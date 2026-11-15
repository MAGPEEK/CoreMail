import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { LiveConnectionRegistry, type LiveCredential } from '@coremail/core/auth';
import { prisma } from '@coremail/storage/prisma';
import {
  expunge, verifyMailCredentials, loadRawMessage, parseMimeTree, headerBytes, type RawSourceMessage,
} from '@coremail/storage';

const log = createLogger('pop3-session');

export interface Pop3SessionOptions {
  /**
   * v7: certificate provider for STLS on a plaintext listener (port 110).
   * Without a certificate the port stays plaintext and refuses USER/PASS.
   */
  starttls?: () => { cert: Buffer; key: Buffer } | null | undefined;
}

// Module-level hostname — updated via setPop3Hostname() when settings change
let _hostname = 'mail.localhost';

/** Update the POP3 greeting hostname (called by server.ts on DB reload). */
export function setPop3Hostname(hostname: string): void {
  _hostname = hostname;
}

type State = 'AUTHORIZATION' | 'TRANSACTION' | 'UPDATE';

/**
 * v7.0.1: authenticated POP3 sessions, ended when their credentials become
 * invalid (password change/reset, MFA enabled, app password revoked,
 * deactivation …). server.ts attaches the registry to the auth bus.
 */
export const pop3LiveSessions = new LiveConnectionRegistry('pop3');

export const CREDENTIALS_CHANGED_ERR = '-ERR [AUTH] Credentials changed, please log in again';

/** RFC 1939 §3: the autologout timer must be at least 10 minutes. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Max characters buffered without a line break (commands are ≤ 512 octets). */
const MAX_PENDING_CHARS = 8 * 1024;

interface MailDrop {
  id: string;
  uid: number;
  rawSize: number;
  deleted: boolean;
}

export class POP3Session {
  private state: State = 'AUTHORIZATION';
  private user: string | null = null;
  private userId: string | null = null;
  private maildrop: MailDrop[] = [];
  private mailboxId: string | null = null;
  private buf = '';
  /** v7: the connection is encrypted (implicit TLS on 995 or after STLS). */
  private secure: boolean;
  /** Commands run strictly one after another (RFC 2449 §6.6 PIPELINING). */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by STLS — commands received before the upgrade are discarded. */
  private epoch = 0;
  /** Set after QUIT / autologout: further input is ignored. */
  private closed = false;
  /** v7.0.1: credential change — the running command finishes, nothing after it runs. */
  private terminating = false;
  private unregisterLive: (() => void) | null = null;
  private readonly onDataBound = (chunk: string) => this.onData(chunk);

  constructor(
    private socket: net.Socket | tls.TLSSocket,
    _secure: boolean,
    private readonly options: Pop3SessionOptions = {},
  ) {
    // Derived from the socket: a listener configured for TLS but running
    // without a certificate (plaintext fallback) is NOT secure.
    this.secure = (socket as tls.TLSSocket).encrypted === true;
  }

  start() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', this.onDataBound);
    this.socket.once('close', () => { this.unregisterLive?.(); this.unregisterLive = null; });
    // RFC 1939 §3: inactivity autologout timer (≥ 10 minutes). No UPDATE state:
    // messages marked as deleted stay in the maildrop.
    this.socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      this.closed = true;
      this.socket.end('-ERR autologout: idle for too long\r\n');
    });
    // RFC 1939 §3 — greeting with hostname
    this.send(`+OK ${_hostname} POP3 ready`);
  }

  private send(line: string) {
    if (this.closed) return;
    this.socket.write(line + '\r\n');
  }

  private onData(chunk: string) {
    if (this.closed) return;
    this.buf += chunk;
    const lines = this.buf.split('\r\n');
    this.buf = lines.pop() ?? '';
    // A client that never sends CRLF must not grow the buffer without limit.
    if (this.buf.length > MAX_PENDING_CHARS) {
      this.closed = true;
      this.socket.end('-ERR line too long\r\n');
      return;
    }
    for (const line of lines) {
      const epoch = this.epoch;
      if (line.length > 512) {
        this.enqueue(epoch, async () => this.send('-ERR line too long'));
        continue;
      }
      // RFC 2449 §6.6 PIPELINING: commands run strictly one after another, so
      // responses arrive in command order even when a command awaits the database.
      // The raw line is passed on: PASS keeps a password with spaces intact.
      this.enqueue(epoch, () => this.handleCommand(line));
    }
  }

  /** Commands queued before STLS (older epoch) or after QUIT/autologout are dropped. */
  private enqueue(epoch: number, fn: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (this.closed || this.terminating || epoch !== this.epoch) return;
      try {
        await fn();
      } catch (err) {
        log.error({ err }, 'command error');
        this.send('-ERR internal error');
      }
    });
  }

  private stlsAvailable(): boolean {
    return !this.secure && !!this.options.starttls?.();
  }

  private async handleCommand(rawLine: string) {
    const line = rawLine.trim();
    const [cmd, ...args] = line.split(' ');
    const command = (cmd ?? '').toUpperCase();

    if (command === 'QUIT') {
      if (this.state === 'TRANSACTION') await this.updateAndDelete();
      this.send('+OK CoreMail POP3 server signing off');
      this.closed = true;
      this.socket.end();
      return;
    }

    if (command === 'CAPA') {
      this.send('+OK Capability list follows');
      this.send('TOP');
      this.send('UIDL');
      // v7: USER/PASS only over TLS; before TLS only STLS is offered (RFC 2595 §4).
      if (this.secure) this.send('USER');
      if (this.stlsAvailable() && this.state === 'AUTHORIZATION') this.send('STLS');
      this.send('PIPELINING');
      this.send('RESP-CODES');
      this.send('AUTH-RESP-CODE');
      this.send('.');
      return;
    }

    if (command === 'STLS') {
      this.handleStls();
      return;
    }

    if (this.state === 'AUTHORIZATION') {
      if (command === 'PASS') {
        // The password is everything after "PASS " — it may contain spaces.
        const sp = rawLine.indexOf(' ');
        await this.handleAuth(command, sp === -1 ? [] : [rawLine.slice(sp + 1)]);
        return;
      }
      await this.handleAuth(command, args);
    } else if (this.state === 'TRANSACTION') {
      await this.handleTransaction(command, args);
    } else {
      this.send('-ERR session in invalid state');
    }
  }

  /**
   * STLS — RFC 2595 §4. Discards everything pipelined after the command
   * (CVE-2011-0411 class) and resets the AUTHORIZATION state.
   */
  private handleStls() {
    if (this.secure) return this.send('-ERR TLS already active');
    if (this.state !== 'AUTHORIZATION') return this.send('-ERR STLS only in AUTHORIZATION state');
    const material = this.options.starttls?.();
    if (!material) return this.send('-ERR STLS not available');

    this.epoch += 1;          // queued commands of the plaintext phase are skipped
    this.buf = '';            // unparsed plaintext remainder is dropped
    const raw = this.socket;
    raw.removeListener('data', this.onDataBound);
    this.send('+OK Begin TLS negotiation');
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext: tls.createSecureContext({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2' }),
    });
    secure.once('secure', () => {
      this.socket = secure;
      this.secure = true;
      this.user = null;
      this.buf = '';
      secure.setEncoding('utf8');
      secure.on('data', this.onDataBound);
      log.debug('POP3 STLS upgrade complete');
    });
    secure.on('error', (err) => {
      log.warn({ err }, 'POP3 STLS handshake/socket error');
      secure.destroy();
    });
  }

  private async handleAuth(command: string, args: string[]) {
    // v7: no credentials over plaintext (RFC 2595 §4) — use STLS or port 995.
    if (!this.secure && (command === 'USER' || command === 'PASS' || command === 'APOP' || command === 'AUTH')) {
      return this.send('-ERR [AUTH] Authentication requires TLS - use STLS or port 995');
    }
    if (command === 'USER') {
      if (!args[0]) return this.send('-ERR missing username');
      this.user = args[0];
      this.send('+OK send PASS');
    } else if (command === 'PASS') {
      if (!this.user) return this.send('-ERR send USER first');
      if (!args[0]) return this.send('-ERR missing password');

      // v7: shared mail-protocol check — DOMAIN\user / bare user name
      // normalisation, MFA → app passwords only, shared lockout.
      const authStartedAt = Date.now();
      const result = await verifyMailCredentials(this.user, args[0], {
        ip: this.socket.remoteAddress,
        protocol: 'pop3',
      });
      if (result.status === 'locked') {
        return this.send('-ERR [SYS/TEMP] Too many failed login attempts, try again later');
      }
      if (result.status === 'error') {
        return this.send('-ERR [SYS/TEMP] Temporary authentication failure, try again later');
      }
      if (result.status !== 'ok') {
        // invalid and mfa_app_password_required: identical text (no oracle)
        log.warn({ user: this.user, status: result.status }, 'POP3 auth failure');
        return this.send('-ERR [AUTH] invalid credentials (accounts with two-factor authentication need an app password)');
      }

      this.userId = result.user.id;
      await this.loadMaildrop();
      this.state = 'TRANSACTION';
      this.registerLive(result.method, result.appPasswordId, authStartedAt);
      this.send(`+OK mailbox has ${this.maildrop.length} messages`);
    } else {
      this.send('-ERR unknown command');
    }
  }

  /** v7.0.1: the session ends when the credentials it used become invalid. */
  private registerLive(method: string, appPasswordId?: string, authStartedAt?: number) {
    if (!this.userId) return;
    const credential: LiveCredential = method === 'password' || method === 'app_password' || method === 'external' ? method : 'unknown';
    this.unregisterLive?.();
    this.unregisterLive = pop3LiveSessions.register({
      userId: this.userId,
      credential,
      ...(appPasswordId ? { appPasswordId } : {}),
      terminate: () => this.terminateForCredentialChange(),
    }, authStartedAt);
  }

  /**
   * Ends the session after a credential change: the running command (e.g. a
   * RETR) completes, queued commands are dropped, then -ERR [AUTH] and close.
   * No UPDATE state — messages marked as deleted are not removed (RFC 1939 §6).
   */
  private terminateForCredentialChange() {
    this.unregisterLive = null;
    if (this.closed || this.terminating) return;
    this.terminating = true;
    this.queue = this.queue.then(() => {
      if (this.closed) return;
      this.send(CREDENTIALS_CHANGED_ERR);
      this.closed = true;
      this.socket.end();
    });
  }

  private async loadMaildrop() {
    
    const mailbox = await prisma.mailbox.findFirst({
      where: { userId: this.userId! },
      include: {
        folders: {
          where: { name: 'INBOX' },
          include: {
            messages: {
              where: { deletedAt: null },
              select: { id: true, uid: true, rawSize: true },
              orderBy: { uid: 'asc' },
            },
          },
        },
      },
    });
    this.mailboxId = mailbox?.id ?? null;
    this.maildrop = (mailbox?.folders[0]?.messages ?? []).map((m: { id: string; uid: number; rawSize: number }) => ({
      ...m,
      deleted: false,
    }));
  }

  private async handleTransaction(command: string, args: string[]) {
    if (command === 'STAT') {
      const active = this.maildrop.filter((m) => !m.deleted);
      const total = active.reduce((s, m) => s + m.rawSize, 0);
      this.send(`+OK ${active.length} ${total}`);
    } else if (command === 'LIST') {
      if (args[0]) {
        const i = msgIndex(args[0]);
        const msg = this.maildrop[i];
        if (!msg || msg.deleted) return this.send('-ERR no such message');
        this.send(`+OK ${i + 1} ${msg.rawSize}`);
      } else {
        const active = this.maildrop.filter((m) => !m.deleted);
        this.send(`+OK ${active.length} messages`);
        this.maildrop.forEach((m, i) => {
          if (!m.deleted) this.send(`${i + 1} ${m.rawSize}`);
        });
        this.send('.');
      }
    } else if (command === 'UIDL') {
      if (args[0]) {
        const i = msgIndex(args[0]);
        const msg = this.maildrop[i];
        if (!msg || msg.deleted) return this.send('-ERR no such message');
        this.send(`+OK ${i + 1} ${msg.id}`);
      } else {
        this.send('+OK unique-id listing follows');
        this.maildrop.forEach((m, i) => {
          if (!m.deleted) this.send(`${i + 1} ${m.id}`);
        });
        this.send('.');
      }
    } else if (command === 'RETR') {
      const i = msgIndex(args[0]);
      const msg = this.maildrop[i];
      if (!msg || msg.deleted) return this.send('-ERR no such message');
      await this.sendMessage(msg, null);
    } else if (command === 'TOP') {
      // RFC 1939 §7: TOP msg n — n is a required non-negative number of lines.
      const i = msgIndex(args[0]);
      if (!/^\d{1,9}$/.test(args[1] ?? '')) return this.send('-ERR TOP requires a message number and a non-negative line count');
      const lines = Number(args[1]);
      const msg = this.maildrop[i];
      if (!msg || msg.deleted) return this.send('-ERR no such message');
      await this.sendMessage(msg, lines);
    } else if (command === 'DELE') {
      const i = msgIndex(args[0]);
      const msg = this.maildrop[i];
      if (!msg || msg.deleted) return this.send('-ERR no such message');
      msg.deleted = true;
      this.send(`+OK message ${i + 1} deleted`);
    } else if (command === 'RSET') {
      this.maildrop.forEach((m) => (m.deleted = false));
      this.send(`+OK ${this.maildrop.length} messages`);
    } else if (command === 'NOOP') {
      this.send('+OK');
    } else {
      this.send('-ERR unknown command');
    }
  }

  /**
   * RETR / TOP (RFC 1939 §7). The original raw message is sent byte-exactly (all
   * headers, every MIME part and attachment); the octet count is that of the
   * message before byte-stuffing, as LIST reports it.
   */
  private async sendMessage(drop: MailDrop, topLines: number | null) {
    const msg = await prisma.message.findUnique({
      where: { id: drop.id },
      include: { attachments: { select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true } } },
    });
    if (!msg) return this.send('-ERR message not found');

    let raw: Buffer;
    try {
      raw = await loadRawMessage(msg as unknown as RawSourceMessage);
    } catch (err) {
      log.error({ err, messageId: drop.id }, 'POP3: raw message unavailable');
      return this.send('-ERR [SYS/TEMP] message temporarily unavailable');
    }
    // A legacy row was just materialized: report its real size from now on.
    drop.rawSize = raw.length;

    if (topLines === null) {
      this.send(`+OK ${raw.length} octets`);
      this.socket.write(dotStuff(raw));
      return;
    }
    const tree = parseMimeTree(raw);
    let end = tree.bodyStart;
    for (let n = 0; n < topLines && end < raw.length; n++) {
      const lf = raw.indexOf(0x0a, end);
      end = lf === -1 ? raw.length : lf + 1;
    }
    this.send('+OK top of message follows');
    this.socket.write(dotStuff(Buffer.concat([headerBytes(raw, tree), raw.subarray(tree.bodyStart, end)])));
  }

  private async updateAndDelete() {

    const toDelete = this.maildrop.filter((m) => m.deleted).map((m) => m.id);
    if (toDelete.length > 0) {
      // Expunge with a modSeq bump so IMAP/JMAP/ActiveSync clients notice.
      const mailboxId = this.mailboxId;
      await prisma.$transaction((tx) => expunge(tx, toDelete, mailboxId ? { mailboxId } : {}));
    }
  }
}

/** 0-based maildrop index of a message-number argument (-1 when not a positive number). */
function msgIndex(arg: string | undefined): number {
  return /^[1-9]\d{0,8}$/.test(arg ?? '') ? Number(arg) - 1 : -1;
}

/**
 * Multi-line response body (RFC 1939 §3): byte-stuffs every line that starts with
 * ".", makes sure the data ends with CRLF and appends the terminating ".\r\n".
 */
export function dotStuff(data: Buffer): Buffer {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x2e && (i === 0 || data[i - 1] === 0x0a)) {
      out.push(data.subarray(start, i), DOT);
      start = i;
    }
  }
  out.push(data.subarray(start));
  if (data.length > 0 && data[data.length - 1] !== 0x0a) out.push(CRLF);
  out.push(TERMINATOR);
  return Buffer.concat(out);
}

const DOT = Buffer.from('.');
const CRLF = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('.\r\n');
