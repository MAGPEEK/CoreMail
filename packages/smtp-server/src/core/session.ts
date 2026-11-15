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
import { smtpLiveSessions } from './live-sessions.js';

const log = createLogger('smtp:session');

// RFC 5321 §4.5.3.2 timeouts (milliseconds)
const T_GREETING = 5 * 60_000;
const T_COMMAND  = 5 * 60_000;
const T_DATA     = 10 * 60_000;

// RFC 5321 §4.5.3.1 — max command line length (octets)
const MAX_LINE = 1000;

// Hard cap for an unterminated line in the input buffer. Lines above MAX_LINE
// are answered with 500 once their CRLF arrives; a peer that never sends CRLF
// would otherwise grow the buffer without limit (memory exhaustion / RangeError).
const MAX_UNTERMINATED_COMMAND = 64 * 1024;

/**
 * Builds the reply line for a rejection string returned by a handler.
 *  - "452 4.2.2 …" / "550 5.7.1 …"  → passed through unchanged (own reply code)
 *  - "4.3.0 …"                       → transient: "<transientCode> 4.3.0 …"
 *  - "5.1.1 …" or free text          → permanent: "<permanentCode> …"
 * The reply-code class follows the enhanced status code class
 * (RFC 3463 §2, RFC 2034 §4); 4yz must stay transient (RFC 5321 §4.2.1).
 */
export function formatRejectReply(reject: string, permanentCode = 550, transientCode = 451): string {
  const text = reject.trim();
  if (/^[45]\d\d(?: |-|$)/.test(text)) return text;
  if (/^4\.\d{1,3}\.\d{1,3}\b/.test(text)) return `${transientCode} ${text}`;
  return `${permanentCode} ${text}`;
}

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

  // DATA mode: the size limit was exceeded — keep consuming (and discarding)
  // body lines until the terminator, then answer with a single 552
  // (RFC 5321 §4.1.1.4, §4.5.3.1.10). Never switch back to command mode early.
  private dataOverflow: boolean = false;

  // Set once the connection is being torn down (oversized line).
  private closing: boolean = false;

  /**
   * Command queue — serializes async command processing to prevent PIPELINING
   * race conditions (RFC 2920). Without this, pipelined MAIL FROM + RCPT TO
   * arrive together: handleMailFrom() awaits onMailFrom() DB call, but RCPT TO
   * is dispatched immediately while state is still 'READY' → 503.
   *
   * All commands are enqueued here and run strictly in order.
   */
  private cmdQueue: Promise<void> = Promise.resolve();

  /**
   * Bumped by STARTTLS. Commands that were received (and queued) before the
   * TLS handshake carry an older epoch and are discarded — pipelined plaintext
   * after STARTTLS must never run inside the TLS session (CVE-2011-0411 class).
   */
  private epoch = 0;

  /** Failed AUTH attempts in this session (421 + disconnect at the limit). */
  private authFailures = 0;

  /**
   * v7.0.1: the credentials of the authenticated user changed. Queued commands
   * no longer run; a message body that is being received is read to its end and
   * then rejected (the session closes with 421 instead of accepting it).
   */
  private terminating = false;
  private terminateAfterData = false;
  private unregisterLive: (() => void) | null = null;

  constructor(socket: net.Socket | tls.TLSSocket, config: SmtpSessionConfig) {
    this.socket = socket;
    this.config = config;
    this.id = crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.ip = this.socket.remoteAddress ?? '0.0.0.0';
    // Implicit TLS (port 465): the connection is encrypted from the start.
    this.tlsUpgraded = (this.socket as tls.TLSSocket).encrypted === true;
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session start');

    this.socket.setEncoding('binary'); // handle raw bytes via string; we buffer lines ourselves
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => {
      log.debug({ id: this.id, err }, 'Socket error');
    });
    this.socket.on('close', () => {
      this.clearTimer();
      this.unregisterLive?.();
      this.unregisterLive = null;
      log.debug({ id: this.id }, 'Socket closed');
    });

    this.resetTimer(T_GREETING);
    // RFC 5321 §4.2 — 220 Greeting: "220 <domain> <text>"
    // bannerText overrides the default text when configured in the admin panel.
    const bannerBody = this.config.bannerText?.trim() || `${this.config.hostname} ESMTP CoreMail`;
    this.send(`220 ${bannerBody}`);
  }

  // ─── Timer ──────────────────────────────────────────────────────────────────

  private resetTimer(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.send(`421 4.4.2 ${this.config.hostname} Timeout - closing connection`);
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

  // ─── Command Queue ───────────────────────────────────────────────────────────

  /**
   * Enqueues an SMTP command handler to run strictly after the previous one
   * completes. This is the fix for PIPELINING race conditions: without a queue,
   * async handlers (onMailFrom, onRcptTo) suspend mid-execution and the next
   * pipelined command sees stale state.
   */
  private enqueueCommand(fn: () => Promise<void> | void): void {
    const epoch = this.epoch;
    this.cmdQueue = this.cmdQueue.then(async () => {
      // Skip if session already terminated
      if (this.state === 'QUIT' || this.terminating) return;
      // Received before a STARTTLS that has since been executed → discard.
      if (epoch !== this.epoch) return;
      await (fn() ?? Promise.resolve());
    }).catch(() => {
      // Errors are handled inside each handler — they send their own error
      // responses and never propagate to the queue chain.
    });
  }

  // ─── Send ────────────────────────────────────────────────────────────────────

  private send(line: string): void {
    if (this.socket.writable) {
      this.socket.write(`${line}\r\n`);
    }
  }

  // ─── Data handler ────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    if (this.closing) return;
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

    // Hard cap on the unterminated remainder: 64 KiB in command mode, the
    // maximum message size in data mode (a single body line can never be
    // larger than the whole message).
    const limit = this.inData
      ? Math.max(this.config.maxSize, MAX_UNTERMINATED_COMMAND)
      : MAX_UNTERMINATED_COMMAND;
    if (this.lineBuffer.length > limit) {
      this.closeForOversizedLine();
    }
  }

  private closeForOversizedLine(): void {
    this.closing = true;
    this.lineBuffer = '';
    this.transaction = null;
    this.inData = false;
    this.dataOverflow = false;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`500 5.5.6 Line too long - closing connection`);
    this.socket.end();
    log.warn({ id: this.id, ip: this.ip }, 'SMTP line exceeds hard limit — connection closed');
  }

  // ─── DATA accumulation ───────────────────────────────────────────────────────

  private handleDataLine(line: string): void {
    // Dot-stuffing terminator: single dot on its own line
    if (line === '.') {
      this.inData = false;
      if (this.terminateAfterData) {
        // v7.0.1: credentials changed during the transfer — not accepted.
        this.closeForCredentialChange();
        return;
      }
      if (this.dataOverflow) {
        // Oversized message fully consumed — exactly one reply, then back to
        // command mode with the transaction discarded.
        this.dataOverflow = false;
        this.enqueueCommand(() => {
          this.transaction = null;
          this.state = 'READY';
          this.resetTimer(T_COMMAND);
          this.send('552 5.3.4 Message exceeds size limit');
        });
        return;
      }
      // Enqueue finishData so that any pipelined commands after the "."
      // (e.g. QUIT or a new MAIL FROM) wait for delivery to complete first.
      this.enqueueCommand(() => this.finishData());
      return;
    }

    // Discard mode: keep the timer alive but do not buffer anything.
    if (this.dataOverflow) {
      this.resetTimer(T_DATA);
      return;
    }

    // Dot-stuffing: remove leading extra dot (RFC 5321 §4.5.2)
    const actual = line.startsWith('..') ? line.slice(1) : line;
    const raw = Buffer.from(actual + '\r\n', 'binary');

    if (this.transaction) {
      this.transaction.size += raw.length;

      if (this.transaction.size > this.config.maxSize) {
        // Do NOT leave DATA mode here: the rest of the body would otherwise
        // be parsed as SMTP commands (command injection). Drop what was
        // buffered and discard further lines until "." arrives.
        this.dataOverflow = true;
        this.transaction.data = [];
        this.resetTimer(T_DATA);
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
      // If the error message starts with its own 4yz/5yz reply code, pass it
      // through unchanged (a reply line carries exactly one code, RFC 5321 §4.2);
      // a bare enhanced code keeps its class; anything else is a temporary 451.
      if (/^[45]\d\d(?: |-|$)/.test(msg) || /^[45]\.\d{1,3}\.\d{1,3}\b/.test(msg)) {
        this.send(formatRejectReply(msg, 554, 451));
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

    // AUTH_WAIT: multi-step AUTH exchange — enqueue like all other commands
    // so that concurrent pipelined commands don't race against auth state.
    if (this.state === 'AUTH_WAIT') {
      this.resetTimer(T_COMMAND);
      this.enqueueCommand(() => this.handleAuthStep(line));
      return;
    }

    // Split command and arguments
    const spaceIdx = line.indexOf(' ');
    const cmd  = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase().trim();
    const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1).trim();

    this.resetTimer(T_COMMAND);

    // ALL commands go through the queue — this serializes async handlers
    // (onMailFrom, onRcptTo) so that pipelined commands always see the correct
    // state set by the previous command. Without this, RCPT TO arrives while
    // MAIL FROM's onMailFrom() is still awaiting, sees state='READY' → 503.
    switch (cmd) {
      case 'EHLO':    this.enqueueCommand(() => this.handleEhlo(args)); break;
      case 'HELO':    this.enqueueCommand(() => this.handleHelo(args)); break;
      case 'AUTH':    this.enqueueCommand(() => this.handleAuth(args)); break;
      case 'STARTTLS':this.enqueueCommand(() => this.handleStarttls()); break;
      case 'MAIL':    this.enqueueCommand(() => this.handleMailFrom(args)); break;
      case 'RCPT':    this.enqueueCommand(() => this.handleRcptTo(args)); break;
      case 'DATA':    this.enqueueCommand(() => this.handleDataCommand()); break;
      case 'RSET':    this.enqueueCommand(() => this.handleRset()); break;
      case 'NOOP':    this.enqueueCommand(() => { this.send('250 2.0.0 OK'); }); break;
      case 'VRFY':    this.enqueueCommand(() => { this.send('502 5.5.1 VRFY not supported'); }); break;
      case 'EXPN':    this.enqueueCommand(() => { this.send('502 5.5.1 EXPN not supported'); }); break;
      case 'QUIT':    this.enqueueCommand(() => this.handleQuit()); break;
      default:
        this.enqueueCommand(() => { this.send(`500 5.5.1 Command not recognized: ${cmd}`); });
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
    // Deliberately not advertised (stub-only / not implemented):
    //   DSN (RFC 3461)       — no parsing of NOTIFY/ORCPT/ENVID/RET, no multipart/report
    //   SMTPUTF8 (RFC 6531)  — UTF-8 envelope addresses are not handled specially
    //   CHUNKING (RFC 3030)  — BDAT command is not recognized by the parser

    // STARTTLS only if TLS configured AND extension enabled AND not yet upgraded
    // AND advertiseStarttls != false. On port 25 with a self-signed cert the server suppresses
    // this so that strict MTAs (Microsoft Exchange) do not get stuck in the TLS handshake.
    const advertise = this.config.advertiseStarttls !== false;
    if (esmtp.starttls && this.config.tls && !this.tlsUpgraded && advertise) {
      lines.push('STARTTLS');
    }

    // AUTH only if verifyCredentials is configured AND at least one mech enabled
    // AND the connection is encrypted (implicit TLS or after STARTTLS) — v7:
    // credentials are never accepted in plaintext (RFC 4954 §4, RFC 8314).
    // CRAM-MD5 is not advertised — handleAuth only recognizes PLAIN + LOGIN, CRAM-MD5
    // would be rejected with 504 Unrecognized.
    if (this.config.verifyCredentials && this.tlsUpgraded) {
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

    // v7: no credentials over an unencrypted connection (RFC 4954 §6 — 538).
    if (!this.tlsUpgraded) {
      this.send('538 5.7.11 Encryption required for requested authentication mechanism (use STARTTLS)');
      return Promise.resolve();
    }

    const parts = args.split(' ');
    const mechanism = (parts[0] ?? '').toUpperCase() as AuthMechanism;
    const initialResponse = parts[1] ?? '';

    if (mechanism === 'PLAIN') {
      return this.handleAuthPlain(initialResponse);
    } else if (mechanism === 'LOGIN') {
      return this.handleAuthLoginStart(initialResponse);
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

  private async handleAuthLoginStart(initialResponse = ''): Promise<void> {
    if (initialResponse && initialResponse !== '=') {
      // "AUTH LOGIN <base64 username>" — widespread client behaviour: continue
      // directly with the password prompt.
      this.authCtx = {
        mechanism: 'LOGIN',
        step: 2,
        username: Buffer.from(initialResponse, 'base64').toString('utf8'),
      };
      this.state = 'AUTH_WAIT';
      this.send('334 UGFzc3dvcmQ6');
      return;
    }
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

    const authStartedAt = Date.now();
    try {
      const result = await this.config.verifyCredentials(username.toLowerCase().trim(), password, this.ip);
      if (result && 'failure' in result) {
        // Lockout or temporary failure (database down …) — RFC 4954 §6: 454 4.7.0.
        this.send(result.failure === 'locked'
          ? '454 4.7.0 Too many failed authentication attempts, try again later'
          : '454 4.7.0 Temporary authentication failure');
        log.warn({ id: this.id, username, failure: result.failure }, 'SMTP auth not possible');
        if (result.failure === 'locked') this.countAuthFailure();
      } else if (result) {
        this.authUser = result;
        this.registerLive(result, authStartedAt);
        this.send('235 2.7.0 Authentication successful');
        log.info({ id: this.id, email: result.email }, 'SMTP auth success');
        return;
      } else {
        this.send('535 5.7.8 Authentication credentials invalid');
        log.warn({ id: this.id, username }, 'SMTP auth failed');
        this.countAuthFailure();
      }
    } catch (err) {
      log.error({ id: this.id, err }, 'verifyCredentials error');
      this.send('454 4.7.0 Temporary authentication failure');
    }
  }

  /** v7.0.1: the session ends when the credentials it authenticated with become invalid. */
  private registerLive(user: AuthUser, authStartedAt: number): void {
    this.unregisterLive?.();
    this.unregisterLive = smtpLiveSessions.register({
      userId: user.id,
      credential: user.credential ?? 'unknown',
      ...(user.appPasswordId ? { appPasswordId: user.appPasswordId } : {}),
      terminate: () => this.terminateForCredentialChange(),
    }, authStartedAt);
  }

  /**
   * Credential change: the command in progress (e.g. delivery of a complete
   * message) finishes, queued commands are dropped, then 421 4.7.0 and close.
   * During a DATA transfer the body is consumed to its terminator first and
   * the message is rejected — the connection never closes mid-body.
   */
  private terminateForCredentialChange(): void {
    this.unregisterLive = null;
    if (this.state === 'QUIT' || this.closing || this.terminating) return;
    this.terminating = true;
    this.cmdQueue = this.cmdQueue.then(() => {
      if (this.state === 'QUIT' || this.closing) return;
      if (this.inData) { this.terminateAfterData = true; return; }
      this.closeForCredentialChange();
    });
  }

  private closeForCredentialChange(): void {
    this.closing = true;
    this.terminateAfterData = false;
    this.lineBuffer = '';
    this.transaction = null;
    this.inData = false;
    this.dataOverflow = false;
    this.authUser = null;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`421 4.7.0 ${this.config.hostname} Credentials changed, please authenticate again - closing connection`);
    this.socket.end();
    log.info({ id: this.id, ip: this.ip }, 'SMTP session closed after a credential change');
  }

  /** Closes the AUTH loop: after N failed attempts → 421 and disconnect. */
  private countAuthFailure(): void {
    this.authFailures += 1;
    const max = this.config.maxAuthFailures ?? 3;
    if (this.authFailures < max) return;
    this.state = 'QUIT';
    this.clearTimer();
    this.send(`421 4.7.0 ${this.config.hostname} Too many authentication failures - closing connection`);
    this.socket.end();
    log.warn({ id: this.id, ip: this.ip, failures: this.authFailures }, 'SMTP: AUTH failure limit reached — connection closed');
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

    // Discard everything the client pipelined after STARTTLS (CVE-2011-0411
    // class): queued commands of the old epoch are skipped, the unparsed
    // remainder of the plaintext buffer is dropped.
    this.epoch += 1;
    this.lineBuffer = '';

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
        this.send(formatRejectReply(reject, 550, 451));
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
      const reject = await this.config.handlers.onRcptTo(addr, tx.from, this.authUser, this.ip);
      if (reject !== null) {
        this.send(formatRejectReply(reject, 550, 451));
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
    this.dataOverflow = false;
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
    this.send(`221 2.0.0 ${this.config.hostname} closing connection - goodbye`);
    this.socket.end();
    log.debug({ id: this.id, ip: this.ip }, 'SMTP session quit');
  }
}
