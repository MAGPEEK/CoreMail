/**
 * SmtpSession — RFC 5321 State Machine
 *
 * Full implementation including:
 *   - EHLO / HELO
 *   - AUTH PLAIN / LOGIN (RFC 4954)
 *   - STARTTLS (RFC 3207)
 *   - MAIL FROM / RCPT TO / DATA with dot-stuffing
 *   - RSET / NOOP / VRFY / EXPN / QUIT
 *   - RFC 5321 §4.5.3.2 timeouts
 *   - RFC 5321 §4.5.3.1 max line length
 *   - State enforcement and sequence checks
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { createLogger } from '@coremail/core';
import type { SmtpState, AuthMechanism, AuthUser, Transaction, SmtpSessionConfig } from './types.js';
import { DEFAULT_ESMTP_EXTENSIONS } from './types.js';

const log = createLogger('smtp:session');

// RFC 5321 §4.5.3.2 timeouts (milliseconds)
const T_GREETING = 5 * 60_000;
const T_COMMAND  = 5 * 60_000;
const T_DATA     = 10 * 60_000;

// RFC 5321 §4.5.3.1 — max command line length (octets)
const MAX_LINE = 1000;

/**
 * Parse MAIL FROM:<addr> or RCPT TO:<addr> argument.
 * Returns:
 *  - lowercase normalized email string on success
 *  - '' (empty string) for null sender <> when prefix === 'FROM'
 *  - null on parse error
 */
function parseAddress(arg: string, prefix: 'FROM' | 'TO'): string | null {
  const match = /^(?:FROM|TO):\s*<([^>]*)>/i.exec(arg.trim());
  if (!match) return null;
  const addr = (match[1] ?? '').toLowerCase().trim();
  if (addr === '' && prefix === 'FROM') return ''; // Null sender ok
  if (addr && !addr.includes('@')) return null;
  return addr || null;
}

/**
 * Auth context stored during multi-step AUTH exchange.
 */
interface AuthCtx {
  mechanism: AuthMechanism;
  step: number;
  username?: string;
}

export class SmtpSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private socket: net.Socket | tls.TLSSocket;
  private readonly config: SmtpSessionConfig;
  private readonly id: string;

  private state: SmtpState = 'INIT';
  private greeting: string = '';
  private authUser: AuthUser | null = null;
  private authCtx: AuthCtx | null = null;
  private transaction: Transaction | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lineBuffer: string = '';
  private tlsUpgraded: boolean = false;
  private ip: string = '';

  // DATA mode: are we inside the message body accumulation?
  private inData: boolean = false;

  constructor(socket: net.Socket | tls.TLSSocket, config: SmtpSessionConfig) {
    this.socket = socket;
    this.config = config;
    this.id = crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.ip = this.socket.remoteAddress ?? '0.0.0.0';
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session start');

    this.socket.setEncoding('binary'); // handle raw bytes via string; we buffer lines ourselves
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => {
      log.debug({ id: this.id, err }, 'Socket error');
    });
    this.socket.on('close', () => {
      this.clearTimer();
      log.debug({ id: this.id }, 'Socket closed');
    });

    this.resetTimer(T_GREETING);
    // RFC 5321 §4.2 — 220 Greeting: "220 <domain> <text>"
    // bannerText überschreibt den Standard-Text wenn im Admin-Panel konfiguriert.
    const bannerBody = this.config.bannerText?.trim() || `${this.config.hostname} ESMTP CoreMail`;
    this.send(`220 ${bannerBody}`);
  }

  // ─── Timer ──────────────────────────────────────────────────────────────────

  private resetTimer(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.send(`421 4.4.2 ${this.config.hostname} Timeout — closing connection`);
      this.socket.destroy();
      log.info({ id: this.id, ip: this.ip }, 'SMTP session timed out');
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ─── Send ────────────────────────────────────────────────────────────────────

  private send(line: string): void {
    if (this.socket.writable) {
      this.socket.write(`${line}\r\n`);
    }
  }

  // ─── Data handler ────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.lineBuffer += chunk;

    while (true) {
      const crlf = this.lineBuffer.indexOf('\r\n');
      if (crlf === -1) break;

      const line = this.lineBuffer.slice(0, crlf);
      this.lineBuffer = this.lineBuffer.slice(crlf + 2);

      if (this.inData) {
        this.handleDataLine(line);
      } else {
        this.handleCommandLine(line);
      }
    }
  }

  // ─── DATA accumulation ───────────────────────────────────────────────────────

  private handleDataLine(line: string): void {
    // Dot-stuffing terminator: single dot on its own line
    if (line === '.') {
      this.inData = false;
      void this.finishData();
      return;
    }

    // Dot-stuffing: remove leading extra dot (RFC 5321 §4.5.2)
    const actual = line.startsWith('..') ? line.slice(1) : line;
    const raw = Buffer.from(actual + '\r\n', 'binary');

    if (this.transaction) {
      this.transaction.size += raw.length;

      if (this.transaction.size > this.config.maxSize) {
        this.inData = false;
        this.transaction = null;
        this.state = 'READY';
        this.send('552 5.3.4 Message exceeds size limit');
        this.resetTimer(T_COMMAND);
        return;
      }

      this.transaction.data.push(raw);
    }
  }

  private async finishData(): Promise<void> {
    const tx = this.transaction;
    if (!tx) {
      this.send('451 4.3.0 Internal error');
      this.resetTimer(T_COMMAND);
      return;
    }

    const raw = Buffer.concat(tx.data);
    const from = tx.from;
    const to = [...tx.rcptTo];
    const authUser = this.authUser;
    const ip = this.ip;

    // Reset transaction state before calling handler (handler may take time)
    this.transaction = null;
    this.state = 'READY';
    this.resetTimer(T_COMMAND);

    try {
      await this.config.handlers.onMessage(raw, from, to, authUser, ip);
      this.send('250 2.0.0 OK');
      log.info({ id: this.id, from, rcpt: to, size: raw.length }, 'Message accepted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Temporary failure';
      // If the error message starts with a valid SMTP code, use it as-is
      if (/^\d{3}/.test(msg)) {
        this.send(msg.startsWith('5') ? msg : `451 4.3.0 ${msg}`);
      } else {
        this.send(`451 4.3.0 ${msg}`);
      }
      log.error({ id: this.id, err }, 'onMessage handler error');
    }
  }

  // ─── Command dispatch ────────────────────────────────────────────────────────

  private handleCommandLine(line: string): void {
    // RFC 5321 §4.5.3.1 — max line length
    if (line.length > MAX_LINE) {
      this.send('500 5.5.6 Line too long');
      this.resetTimer(T_COMMAND);
      return;
    }

    // AUTH_WAIT: pass line directly to auth handler
    if (this.state === 'AUTH_WAIT') {
      this.resetTimer(T_COMMAND);
      void this.handleAuthStep(line);
      return;
    }

    // Split command and arguments
    const spaceIdx = line.indexOf(' ');
    const cmd  = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase().trim();
    const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();

    this.resetTimer(T_COMMAND);

    switch (cmd) {
      case 'EHLO': this.handleEhlo(args); break;
      case 'HELO': this.handleHelo(args); break;
      case 'AUTH': void this.handleAuth(args); break;
      case 'STARTTLS': void this.handleStarttls(); break;
      case 'MAIL': void this.handleMailFrom(args); break;
      case 'RCPT': void this.handleRcptTo(args); break;
      case 'DATA': this.handleDataCommand(); break;
      case 'RSET': this.handleRset(); break;
      case 'NOOP': this.send('250 2.0.0 OK'); break;
      case 'VRFY': this.send('502 5.5.1 VRFY not supported'); break;
      case 'EXPN': this.send('502 5.5.1 EXPN not supported'); break;
      case 'QUIT': this.handleQuit(); break;
      default:
        this.send(`500 5.5.1 Command not recognized: ${cmd}`);
    }
  }

  // ─── EHLO ────────────────────────────────────────────────────────────────────

  private handleEhlo(clientName: string): void {
    this.greeting = clientName;
    this.transaction = null;

    const esmtp = this.config.esmtp ?? DEFAULT_ESMTP_EXTENSIONS;
    const lines: string[] = [`${this.config.hostname}`];

    if (esmtp.size)           lines.push(`SIZE ${this.config.maxSize}`);
    if (esmtp.pipelining)     lines.push('PIPELINING');
    if (esmtp.bit8mime)       lines.push('8BITMIME');
    if (esmtp.enhancedStatus) lines.push('ENHANCEDSTATUSCODES');
    // Bewusst nicht beworben (Stub-only / nicht implementiert):
    //   DSN (RFC 3461)       — kein Parsing von NOTIFY/ORCPT/ENVID/RET, keine multipart/report
    //   SMTPUTF8 (RFC 6531)  — UTF-8 Envelope-Adressen werden nicht gesondert behandelt
    //   CHUNKING (RFC 3030)  — BDAT-Command wird vom Parser nicht erkannt

    // STARTTLS only if TLS configured AND extension enabled AND not yet upgraded
    // AND advertiseStarttls != false. Auf Port 25 mit self-signed Cert wird das vom Server
    // unterdrückt damit strikte MTAs (Microsoft Exchange) nicht am TLS-Handshake hängen.
    const advertise = this.config.advertiseStarttls !== false;
    if (esmtp.starttls && this.config.tls && !this.tlsUpgraded && advertise) {
      lines.push('STARTTLS');
    }

    // AUTH only if verifyCredentials is configured AND at least one mech enabled
    // CRAM-MD5 wird nicht beworben — handleAuth erkennt nur PLAIN + LOGIN, CRAM-MD5
    // würde mit 504 Unrecognized abgewiesen werden.
    if (this.config.verifyCredentials) {
      const mechs: string[] = [];
      if (esmtp.authPlain)   mechs.push('PLAIN');
      if (esmtp.authLogin)   mechs.push('LOGIN');
      if (mechs.length > 0) lines.push(`AUTH ${mechs.join(' ')}`);
    }

    // Build multi-line response
    for (let i = 0; i < lines.length - 1; i++) {
      this.send(`250-${lines[i]}`);
    }
    this.send(`250 ${lines[lines.length - 1]}`);

    this.state = 'READY';
  }

  // ─── HELO ────────────────────────────────────────────────────────────────────

  private handleHelo(clientName: string): void {
    this.greeting = clientName;
    this.transaction = null;
    this.send(`250 ${this.config.hostname}`);
    this.state = 'READY';
  }

  // ─── AUTH ────────────────────────────────────────────────────────────────────

  private handleAuth(args: string): Promise<void> {
    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return Promise.resolve();
    }

    if (!this.config.verifyCredentials) {
      this.send('502 5.5.1 AUTH not supported');
      return Promise.resolve();
    }

    if (this.authUser) {
      this.send('503 5.7.0 Already authenticated');
      return Promise.resolve();
    }

    const parts = args.split(' ');
    const mechanism = (parts[0] ?? '').toUpperCase() as AuthMechanism;
    const initialResponse = parts[1] ?? '';

    if (mechanism === 'PLAIN') {
      return this.handleAuthPlain(initialResponse);
    } else if (mechanism === 'LOGIN') {
      return this.handleAuthLoginStart();
    } else {
      this.send('504 5.5.4 Unrecognized authentication type');
      return Promise.resolve();
    }
  }

  private async handleAuthPlain(initialResponse: string): Promise<void> {
    if (!initialResponse) {
      // Two-step: send empty challenge, wait for client response
      this.authCtx = { mechanism: 'PLAIN', step: 1 };
      this.state = 'AUTH_WAIT';
      this.send('334 ');
      return;
    }

    // Inline: decode immediately
    await this.verifyPlainCredentials(initialResponse);
  }

  private async handleAuthLoginStart(): Promise<void> {
    this.authCtx = { mechanism: 'LOGIN', step: 1 };
    this.state = 'AUTH_WAIT';
    // "Username:"
    this.send('334 VXNlcm5hbWU6');
  }

  private async handleAuthStep(line: string): Promise<void> {
    // AUTH cancel
    if (line === '*') {
      this.authCtx = null;
      this.state = 'READY';
      this.send('501 5.7.0 Authentication cancelled');
      return;
    }

    const ctx = this.authCtx;
    if (!ctx) {
      this.state = 'READY';
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    if (ctx.mechanism === 'PLAIN') {
      this.authCtx = null;
      this.state = 'READY';
      await this.verifyPlainCredentials(line);
    } else if (ctx.mechanism === 'LOGIN') {
      if (ctx.step === 1) {
        // Received username (base64)
        try {
          ctx.username = Buffer.from(line, 'base64').toString('utf8');
        } catch {
          ctx.username = line;
        }
        ctx.step = 2;
        // "Password:"
        this.send('334 UGFzc3dvcmQ6');
      } else {
        // Received password (base64)
        const username = ctx.username ?? '';
        let password: string;
        try {
          password = Buffer.from(line, 'base64').toString('utf8');
        } catch {
          password = line;
        }
        this.authCtx = null;
        this.state = 'READY';
        await this.verifyCredentials(username, password);
      }
    }
  }

  private async verifyPlainCredentials(b64: string): Promise<void> {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      // Format: [authzid]\0authcid\0password
      const parts = decoded.split('\0');
      let username: string;
      let password: string;
      if (parts.length === 3) {
        username = parts[1] ?? '';
        password = parts[2] ?? '';
      } else if (parts.length === 2) {
        username = parts[0] ?? '';
        password = parts[1] ?? '';
      } else {
        this.send('535 5.7.8 Authentication credentials invalid');
        return;
      }
      await this.verifyCredentials(username, password);
    } catch {
      this.send('535 5.7.8 Authentication credentials invalid');
    }
  }

  private async verifyCredentials(username: string, password: string): Promise<void> {
    if (!this.config.verifyCredentials) {
      this.send('535 5.7.8 Authentication credentials invalid');
      return;
    }

    try {
      const user = await this.config.verifyCredentials(username.toLowerCase().trim(), password, this.ip);
      if (user) {
        this.authUser = user;
        this.send('235 2.7.0 Authentication successful');
        log.info({ id: this.id, email: user.email }, 'SMTP auth success');
      } else {
        this.send('535 5.7.8 Authentication credentials invalid');
        log.warn({ id: this.id, username }, 'SMTP auth failed');
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'verifyCredentials error');
      this.send('451 4.3.0 Temporary authentication failure');
    }
  }

  // ─── STARTTLS ────────────────────────────────────────────────────────────────

  private async handleStarttls(): Promise<void> {
    if (!this.config.tls || this.config.advertiseStarttls === false) {
      this.send('502 5.5.1 STARTTLS not supported');
      return;
    }

    if (this.tlsUpgraded) {
      this.send('503 5.5.1 TLS already active');
      return;
    }

    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    this.send('220 2.0.0 Ready to start TLS');
    this.clearTimer();

    // Remove existing data listener before upgrading
    this.socket.removeAllListeners('data');

    const tlsSocket = new tls.TLSSocket(this.socket, {
      isServer: true,
      cert: this.config.tls.cert,
      key: this.config.tls.key,
      minVersion: 'TLSv1.2',
    });

    tlsSocket.once('secure', () => {
      // After TLS handshake: reset state per RFC 3207
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).socket = tlsSocket;
      this.tlsUpgraded = true;
      this.state = 'INIT';
      this.greeting = '';
      this.transaction = null;
      this.lineBuffer = '';
      this.authUser = null;
      this.authCtx = null;

      tlsSocket.setEncoding('binary');
      tlsSocket.on('data', (chunk: string) => this.onData(chunk));
      tlsSocket.on('error', (err) => {
        log.debug({ id: this.id, err }, 'TLS socket error');
      });

      this.resetTimer(T_GREETING);
      log.debug({ id: this.id }, 'STARTTLS upgrade complete');
    });

    tlsSocket.once('error', (err) => {
      log.warn({ id: this.id, err }, 'STARTTLS handshake error');
      this.socket.destroy();
    });
  }

  // ─── MAIL FROM ───────────────────────────────────────────────────────────────

  private async handleMailFrom(args: string): Promise<void> {
    if (this.state !== 'READY') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    // RFC 4954: requireAuth
    if (this.config.requireAuth && !this.authUser) {
      this.send('530 5.7.0 Authentication required');
      return;
    }

    // Parse address (supports SIZE= param suffix)
    const argsNorm = args.replace(/\s+SIZE=\d+\s*$/i, '').replace(/\s+[A-Z0-9]+=\S*\s*/gi, ' ').trim();
    const addr = parseAddress(argsNorm, 'FROM');
    if (addr === null) {
      this.send('501 5.1.7 Bad sender address syntax');
      return;
    }

    // Parse SIZE= parameter
    const sizeMatch = /\bSIZE=(\d+)\b/i.exec(args);
    if (sizeMatch) {
      const declaredSize = parseInt(sizeMatch[1] ?? '0', 10);
      if (declaredSize > this.config.maxSize) {
        this.send('552 5.3.4 Message exceeds maximum size');
        return;
      }
    }

    try {
      const reject = await this.config.handlers.onMailFrom(addr, this.ip, this.authUser);
      if (reject !== null) {
        this.send(`550 ${reject}`);
        return;
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'onMailFrom error');
      this.send('451 4.3.0 Temporary failure');
      return;
    }

    this.transaction = { from: addr, rcptTo: [], data: [], size: 0 };
    this.state = 'MAIL';
    this.send(`250 2.1.0 OK`);
  }

  // ─── RCPT TO ─────────────────────────────────────────────────────────────────

  private async handleRcptTo(args: string): Promise<void> {
    if (this.state !== 'MAIL' && this.state !== 'RCPT') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    const tx = this.transaction;
    if (!tx) {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    if (tx.rcptTo.length >= this.config.maxRcpt) {
      this.send(`452 4.5.3 Too many recipients (max ${this.config.maxRcpt})`);
      return;
    }

    // Strip known RCPT TO params (NOTIFY, ORCPT, etc.)
    const argsNorm = args.replace(/\s+[A-Z0-9]+=\S*\s*/gi, ' ').trim();
    const addr = parseAddress(argsNorm, 'TO');
    if (addr === null || addr === '') {
      this.send('501 5.1.3 Bad recipient address syntax');
      return;
    }

    try {
      const reject = await this.config.handlers.onRcptTo(addr, tx.from, this.authUser);
      if (reject !== null) {
        this.send(`550 ${reject}`);
        return;
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'onRcptTo error');
      this.send('451 4.3.0 Temporary failure');
      return;
    }

    tx.rcptTo.push(addr);
    this.state = 'RCPT';
    this.send(`250 2.1.5 OK`);
  }

  // ─── DATA ────────────────────────────────────────────────────────────────────

  private handleDataCommand(): void {
    if (this.state !== 'RCPT') {
      this.send('503 5.5.1 Bad sequence of commands');
      return;
    }

    this.state = 'DATA';
    this.inData = true;
    this.resetTimer(T_DATA);
    this.send('354 End data with <CR><LF>.<CR><LF>');
  }

  // ─── RSET ────────────────────────────────────────────────────────────────────

  private handleRset(): void {
    this.transaction = null;
    this.inData = false;
    // Do not reset authUser per RFC 5321
    if (this.state !== 'INIT') {
      this.state = 'READY';
    }
    this.send('250 2.0.0 OK');
  }

  // ─── QUIT ────────────────────────────────────────────────────────────────────

  private handleQuit(): void {
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`221 2.0.0 ${this.config.hostname} closing connection — goodbye`);
    this.socket.end();
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session quit');
  }
}
