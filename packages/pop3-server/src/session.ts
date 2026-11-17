import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { logTlsSocketError } from '@coremail/core/tls-errors';
import {
  LiveConnectionRegistry, PROTOCOL_ACCESS_CHANGE, type AuthInvalidationEvent, type LiveCredential,
} from '@coremail/core/auth';
import { prisma } from '@coremail/storage/prisma';
import {
  expunge, verifyMailCredentials, loadRawMessage, parseMimeTree, headerBytes, type RawSourceMessage,
} from '@coremail/storage';
import { acquireMaildropLock, type AcquireResult } from './maildrop-lock.js';

const log = createLogger('pop3-session');

export interface Pop3SessionOptions {
  /**
   * v7: certificate provider for STLS on a plaintext listener (port 110).
   * Without a certificate the port stays plaintext and refuses USER/PASS.
   */
  starttls?: () => { cert: Buffer; key: Buffer } | null | undefined;
  /**
   * Exclusive maildrop lock (RFC 1939 §4); default: {@link acquireMaildropLock}
   * (in-process + Redis). Injectable for tests.
   */
  lock?: (userId: string) => Promise<AcquireResult>;
  /** v8.1: an STLS handshake must complete within this time (default 30 s). */
  tlsHandshakeMs?: number;
}

/** v8.1: default STLS handshake timeout. */
export const TLS_HANDSHAKE_MS = 30_000;

// Module-level hostname — updated via setPop3Hostname() when settings change
let _hostname = 'mail.localhost';

/** Update the POP3 greeting hostname (called by server.ts on DB reload). */
export function setPop3Hostname(hostname: string): void {
  _hostname = hostname;
}

type State = 'AUTHORIZATION' | 'TRANSACTION' | 'UPDATE';

/**
 * v7.1.0: authenticated POP3 sessions, ended when their credentials become
 * invalid (password change/reset, MFA enabled, app password revoked,
 * deactivation …). server.ts attaches the registry to the auth bus.
 */
export const pop3LiveSessions = new LiveConnectionRegistry('pop3');

export const CREDENTIALS_CHANGED_ERR = '-ERR [AUTH] Credentials changed, please log in again';
/** 9.4: POP3 switched off for the account (login refusal and end of open sessions). */
export const POP3_DISABLED_ERR = '-ERR [AUTH] POP3 access is disabled for this account';

/** RFC 1939 §3: the autologout timer must be at least 10 minutes. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Max octets buffered without a line break (commands are ≤ 512 octets). */
const MAX_PENDING_CHARS = 8 * 1024;
/** RFC 2449 §4: a command line is at most 512 octets including CRLF. */
const MAX_COMMAND_OCTETS = 512;

interface MailDrop {
  id: string;
  uid: number;
  rawSize: number;
  deleted: boolean;
}

/** Maildrop row as loaded from the database. */
interface MailDropRow { id: string; uid: number; rawSize: number; storagePath?: string | null }

export class POP3Session {
  private state: State = 'AUTHORIZATION';
  private user: string | null = null;
  private userId: string | null = null;
  private maildrop: MailDrop[] = [];
  private mailboxId: string | null = null;
  /** INBOX folder of the maildrop — QUIT only expunges rows still in this folder. */
  private inboxFolderId: string | null = null;
  /** Releases the maildrop lock (set while the session holds it). */
  private releaseLock: (() => Promise<void>) | null = null;
  private buf = '';
  /** v7: the connection is encrypted (implicit TLS on 995 or after STLS). */
  private secure: boolean;
  /** Commands run strictly one after another (RFC 2449 §6.6 PIPELINING). */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by STLS — commands received before the upgrade are discarded. */
  private epoch = 0;
  /** Set after QUIT / autologout: further input is ignored. */
  private closed = false;
  /** v7.1.0: credential change — the running command finishes, nothing after it runs. */
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
    // latin1: one character per octet, so line limits count octets (RFC 2449 §4);
    // arguments are decoded as UTF-8 in handleCommand.
    this.socket.setEncoding('latin1');
    this.socket.on('data', this.onDataBound);
    this.socket.once('close', () => {
      this.unregisterLive?.(); this.unregisterLive = null;
      void this.unlock();
    });
    this.armIdleTimer(this.socket);
    // RFC 1939 §3 — greeting with hostname
    this.send(`+OK ${_hostname} POP3 ready`);
  }

  /**
   * RFC 1939 §3: inactivity autologout timer (≥ 10 minutes). No UPDATE state:
   * messages marked as deleted stay in the maildrop.
   */
  private armIdleTimer(socket: net.Socket | tls.TLSSocket): void {
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      if (this.socket !== socket) return;
      this.closed = true;
      socket.end('-ERR autologout: idle for too long\r\n');
    });
  }

  private send(line: string) {
    if (this.closed) return;
    this.socket.write(line + '\r\n');
  }

  /**
   * Writes a (large) multi-line body and waits until the socket buffer drained, so a
   * pipelining client that does not read cannot make the server buffer every
   * requested message (the command queue waits here).
   */
  private async writeBody(data: Buffer): Promise<void> {
    if (this.closed) return;
    const socket = this.socket;
    if (socket.write(data) || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
      socket.on('drain', done);
      socket.on('close', done);
    });
  }

  private async unlock(): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = null;
    await release?.();
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
      if (line.length + 2 > MAX_COMMAND_OCTETS) {
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

  private async handleCommand(wireLine: string) {
    // The line arrives as octets (latin1); arguments such as passwords are UTF-8.
    const rawLine = Buffer.from(wireLine, 'latin1').toString('utf8').trimStart();
    const line = rawLine.trimEnd();
    const [cmd, ...args] = line.split(' ');
    const command = (cmd ?? '').toUpperCase();

    // RFC 1939 §3: keyword and arguments are separated by single spaces. An empty
    // argument ("LIST  1") must not be read as "no argument". PASS is exempt: the
    // password is everything after "PASS " and may contain spaces.
    if (command !== 'PASS' && args.some((a) => a === '')) {
      return this.send('-ERR syntax error: arguments are separated by a single space');
    }

    if (command === 'QUIT') {
      let reply = '+OK CoreMail POP3 server signing off';
      if (this.state === 'TRANSACTION') {
        // RFC 1939 §6: UPDATE state — remove the marked messages, release the
        // lock and close the connection whether or not the removal succeeded.
        this.state = 'UPDATE';
        try {
          await this.updateAndDelete();
        } catch (err) {
          log.error({ err, userId: this.userId }, 'POP3 UPDATE: removing deleted messages failed');
          reply = '-ERR [SYS/TEMP] some deleted messages not removed';
        }
        await this.unlock();
      }
      this.send(reply);
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
    // v8.1: the plaintext idle timer no longer sees the traffic once the TLS
    // layer owns the socket — a client that never completes the handshake is
    // cut off here, and the TLS socket gets its own autologout timer.
    raw.setTimeout(0);
    const handshakeTimer = setTimeout(() => {
      log.info('POP3 STLS handshake timed out');
      this.closed = true;
      secure.destroy();
      raw.destroy();
    }, this.options.tlsHandshakeMs ?? TLS_HANDSHAKE_MS);
    handshakeTimer.unref();
    secure.once('secure', () => {
      clearTimeout(handshakeTimer);
      this.socket = secure;
      this.secure = true;
      this.user = null;
      this.buf = '';
      secure.setEncoding('latin1');
      secure.on('data', this.onDataBound);
      this.armIdleTimer(secure);
      log.debug('POP3 STLS upgrade complete');
    });
    secure.on('error', (err) => {
      clearTimeout(handshakeTimer);
      logTlsSocketError(log, err, { service: 'POP3 STLS', ip: raw.remoteAddress });
      secure.destroy();
    });
    secure.once('close', () => clearTimeout(handshakeTimer));
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
      if (result.status === 'protocol_disabled') {
        log.warn({ userId: result.userId, ip: this.socket.remoteAddress }, 'POP3 login refused — POP3 disabled for this account');
        return this.send(POP3_DISABLED_ERR);
      }
      if (result.status !== 'ok') {
        // invalid and mfa_app_password_required: identical text (no oracle)
        log.warn({ user: this.user, status: result.status, ip: this.socket.remoteAddress }, 'POP3 auth failure');
        return this.send('-ERR [AUTH] invalid credentials (accounts with two-factor authentication need an app password)');
      }

      // RFC 1939 §4: exclusive-access lock on the maildrop, else -ERR [IN-USE] (RFC 2449 §8.1.1).
      const lock = await (this.options.lock ?? acquireMaildropLock)(result.user.id);
      if (lock.status === 'busy') {
        return this.send('-ERR [IN-USE] maildrop already locked by another session, try again later');
      }
      if (lock.status === 'error') {
        return this.send('-ERR [SYS/TEMP] unable to lock the maildrop, try again later');
      }
      this.releaseLock = lock.release;
      if (this.socket.destroyed) { await this.unlock(); return; }

      this.userId = result.user.id;
      try {
        await this.loadMaildrop();
      } catch (err) {
        await this.unlock();
        throw err;
      }
      this.state = 'TRANSACTION';
      this.registerLive(result.method, result.appPasswordId, authStartedAt);
      log.info({ user: result.user.email, method: result.method, ip: this.socket.remoteAddress }, 'POP3 login success');
      this.send(`+OK mailbox has ${this.maildrop.length} messages`);
    } else {
      this.send('-ERR unknown command');
    }
  }

  /** v7.1.0: the session ends when the credentials it used become invalid. */
  private registerLive(method: string, appPasswordId?: string, authStartedAt?: number) {
    if (!this.userId) return;
    const credential: LiveCredential = method === 'password' || method === 'app_password' || method === 'external' ? method : 'unknown';
    this.unregisterLive?.();
    this.unregisterLive = pop3LiveSessions.register({
      userId: this.userId,
      credential,
      protocol: 'pop3',
      ...(appPasswordId ? { appPasswordId } : {}),
      terminate: (event) => this.terminateForCredentialChange(event),
    }, authStartedAt);
  }

  /**
   * Ends the session after a credential change (9.4: or POP3 switched off):
   * the running command (e.g. a RETR) completes, queued commands are dropped,
   * then -ERR [AUTH] and close.
   * No UPDATE state — messages marked as deleted are not removed (RFC 1939 §6).
   */
  private terminateForCredentialChange(event: AuthInvalidationEvent) {
    this.unregisterLive = null;
    if (this.closed || this.terminating) return;
    this.terminating = true;
    const message = event.reason === PROTOCOL_ACCESS_CHANGE ? POP3_DISABLED_ERR : CREDENTIALS_CHANGED_ERR;
    this.queue = this.queue.then(() => {
      if (this.closed) return;
      this.send(message);
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
              select: { id: true, uid: true, rawSize: true, storagePath: true },
              orderBy: { uid: 'asc' },
            },
          },
        },
      },
    });
    const inbox = mailbox?.folders[0] as { id?: string; messages: MailDropRow[] } | undefined;
    this.mailboxId = mailbox?.id ?? null;
    this.inboxFolderId = inbox?.id ?? null;
    const rows = inbox?.messages ?? [];
    // RFC 1939 §5/§11: LIST/STAT report the exact size RETR sends. Legacy rows
    // (no raw object yet) are materialized — once, the raw store persists them —
    // instead of reporting a size computed from the body column. Bounded per
    // login (count, time, parallelism): the first login after an upgrade of a
    // big old inbox must not time out. The rest keeps the stored size until
    // its RETR/TOP (which corrects it) or a later login.
    const sizes = await materializeBounded(
      rows.filter((m) => m.storagePath === null).map((m) => m.id),
      async (id) => (await this.loadRaw(id))?.length ?? null,
      legacyMaterializeLimits,
    );
    this.maildrop = rows.map((m) => ({ id: m.id, uid: m.uid, rawSize: sizes.get(m.id) ?? m.rawSize, deleted: false }));
  }

  /**
   * The message as POP3 sends it: the stored raw octets with every line ending
   * normalized to CRLF (RFC 1939 §3, §11). null when the row is gone.
   */
  private async loadRaw(id: string): Promise<Buffer | null> {
    const msg = await prisma.message.findUnique({
      where: { id },
      include: { attachments: { select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true } } },
    });
    if (!msg) return null;
    return toCrlf(await loadRawMessage(msg as unknown as RawSourceMessage));
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
    let raw: Buffer | null;
    try {
      raw = await this.loadRaw(drop.id);
    } catch (err) {
      log.error({ err, messageId: drop.id }, 'POP3: raw message unavailable');
      return this.send('-ERR [SYS/TEMP] message temporarily unavailable');
    }
    if (!raw) return this.send('-ERR message not found');
    // Exact size as sent from now on (legacy row materialized, bare LF converted).
    drop.rawSize = raw.length;

    if (topLines === null) {
      this.send(`+OK ${raw.length} octets`);
      await this.writeBody(dotStuff(raw));
      return;
    }
    const tree = parseMimeTree(raw);
    let end = tree.bodyStart;
    for (let n = 0; n < topLines && end < raw.length; n++) {
      const lf = raw.indexOf(0x0a, end);
      end = lf === -1 ? raw.length : lf + 1;
    }
    this.send('+OK top of message follows');
    await this.writeBody(dotStuff(Buffer.concat([headerBytes(raw, tree), raw.subarray(tree.bodyStart, end)])));
  }

  /**
   * UPDATE state (RFC 1939 §6): removes exactly the messages marked as deleted in
   * THIS session — by their stable id, and only while they are still live in the
   * INBOX the maildrop was opened from. A message another client moved (IMAP MOVE,
   * JMAP, rules) or deleted in the meantime is left alone ("in no case may the
   * server remove any messages not marked as deleted"). One UPDATE … WHERE, with
   * a modSeq bump so IMAP/JMAP/ActiveSync clients notice.
   */
  private async updateAndDelete() {
    const toDelete = this.maildrop.filter((m) => m.deleted).map((m) => m.id);
    const folderId = this.inboxFolderId;
    if (toDelete.length === 0 || !folderId) return;
    const mailboxId = this.mailboxId;
    await prisma.$transaction((tx) => expunge(tx, toDelete, {
      ...(mailboxId ? { mailboxId } : {}),
      where: { folderId, deletedAt: null },
    }));
  }
}

/** 0-based maildrop index of a message-number argument (-1 when not a positive number). */
export interface MaterializeLimits {
  /** Most legacy messages materialized per login. */
  max: number;
  /** Time budget per login (ms); started work finishes, no new work starts after it. */
  budgetMs: number;
  /** Parallel loads. */
  concurrency: number;
}

/** Per-login limits for legacy materialization (tests lower them). */
export const legacyMaterializeLimits: MaterializeLimits = { max: 200, budgetMs: 5_000, concurrency: 4 };

/**
 * Runs `load` for up to `max` ids, `concurrency` at a time, starting no new
 * load after `budgetMs`. Returns the sizes that were determined; failures are
 * logged and skipped (the caller keeps the stored size).
 */
export async function materializeBounded(
  ids: string[],
  load: (id: string) => Promise<number | null>,
  limits: MaterializeLimits,
  now: () => number = Date.now,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const queue = ids.slice(0, Math.max(0, limits.max));
  const deadline = now() + limits.budgetMs;
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (now() > deadline) return;
      try {
        const size = await load(id);
        if (size !== null) sizes.set(id, size);
      } catch (err) {
        log.warn({ err, messageId: id }, 'POP3: could not materialize a legacy message, size may be inexact');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker));
  if (sizes.size < ids.length) {
    log.info({ legacy: ids.length, materialized: sizes.size }, 'POP3: legacy messages left for later (bounded per login)');
  }
  return sizes;
}

function msgIndex(arg: string | undefined): number {
  return /^[1-9]\d{0,8}$/.test(arg ?? '') ? Number(arg) - 1 : -1;
}

/**
 * Converts every bare LF to CRLF (RFC 1939 §3: lines end in CRLF). Messages stored
 * with bare LF line endings (e.g. imported through JMAP) would otherwise break the
 * multi-line framing. Returns the input unchanged when there is no bare LF.
 */
export function toCrlf(data: Buffer): Buffer {
  let bare = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) bare++;
  if (bare === 0) return data;
  const out = Buffer.allocUnsafe(data.length + bare);
  let o = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) out[o++] = 0x0d;
    out[o++] = data[i]!;
  }
  return out;
}

/**
 * Multi-line response body (RFC 1939 §3): normalizes bare LF to CRLF, byte-stuffs
 * every line that starts with ".", makes sure the data ends with CRLF and appends
 * the terminating ".\r\n".
 */
export function dotStuff(input: Buffer): Buffer {
  const data = toCrlf(input);
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
