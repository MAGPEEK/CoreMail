import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { verifyPassword } from '@coremail/core/auth';
import { prisma } from '@coremail/storage/prisma';
import { expunge, loadRawMessage, parseMimeTree, headerBytes, type RawSourceMessage } from '@coremail/storage';

const log = createLogger('pop3-session');

// Module-level hostname — updated via setPop3Hostname() when settings change
let _hostname = 'mail.localhost';

/** Update the POP3 greeting hostname (called by server.ts on DB reload). */
export function setPop3Hostname(hostname: string): void {
  _hostname = hostname;
}

type State = 'AUTHORIZATION' | 'TRANSACTION' | 'UPDATE';

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
  /** Serializes pipelined commands (RFC 2449 §6.6). */
  private queue: Promise<void> = Promise.resolve();
  /** Set after QUIT / autologout: further input is ignored. */
  private closed = false;

  constructor(
    private readonly socket: net.Socket | tls.TLSSocket,
    private readonly secure: boolean,
  ) {}

  start() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onData(chunk));
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
      if (line.length > 512) {
        this.enqueue(async () => this.send('-ERR line too long'));
        continue;
      }
      // RFC 2449 §6.6 PIPELINING: commands run strictly one after another, so
      // responses arrive in command order even when a command awaits the database.
      this.enqueue(() => this.handleCommand(line.trim()));
    }
  }

  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await fn();
      } catch (err) {
        log.error({ err }, 'command error');
        this.send('-ERR internal error');
      }
    });
  }

  private async handleCommand(line: string) {
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
      this.send('USER');
      this.send('PIPELINING');
      this.send('RESP-CODES');
      this.send('.');
      return;
    }

    if (this.state === 'AUTHORIZATION') {
      await this.handleAuth(command, args);
    } else if (this.state === 'TRANSACTION') {
      await this.handleTransaction(command, args);
    } else {
      this.send('-ERR session in invalid state');
    }
  }

  private async handleAuth(command: string, args: string[]) {
    if (command === 'USER') {
      if (!args[0]) return this.send('-ERR missing username');
      this.user = args[0];
      this.send('+OK send PASS');
    } else if (command === 'PASS') {
      if (!this.user) return this.send('-ERR send USER first');
      if (!args[0]) return this.send('-ERR missing password');

      const password = args[0];
      // v5.3.1: normalization as in IMAP — DOMAIN\user or bare username
      // → email form. Plus app-password fallback for MFA users.
      let email = this.user;
      const bsIdx = email.lastIndexOf('\\');
      if (bsIdx !== -1) email = email.slice(bsIdx + 1);
      email = email.trim().toLowerCase();
      if (!email.includes('@')) {
        // bare username → append primary domain
        const primaryDomain = await prisma.domain.findFirst({
          where:  { primary: true, active: true },
          select: { name: true },
        }).catch(() => null);
        if (primaryDomain) email = `${email}@${primaryDomain.name}`;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.active) {
        log.warn({ user: this.user }, 'POP3 auth failure: user not found/inactive');
        return this.send('-ERR invalid credentials');
      }

      // 1) Regular password hash
      let authenticated = false;
      if (user.passwordHash) {
        authenticated = await verifyPassword(password, user.passwordHash).catch(() => false);
      }
      // 2) Fallback: app password (mandatory for MFA accounts)
      if (!authenticated) {
        const appPasswords = await prisma.appPassword.findMany({
          where: { userId: user.id },
          select: { id: true, hash: true },
        }).catch(() => []);
        for (const ap of appPasswords) {
          if (await verifyPassword(password, ap.hash).catch(() => false)) {
            authenticated = true;
            void prisma.appPassword.update({
              where: { id: ap.id },
              data:  { lastUsedAt: new Date() },
            }).catch(() => { /* ignore */ });
            break;
          }
        }
      }

      if (!authenticated) {
        log.warn({ user: this.user }, 'POP3 auth failure: bad password');
        return this.send('-ERR invalid credentials');
      }

      this.userId = user.id;
      await this.loadMaildrop();
      this.state = 'TRANSACTION';
      this.send(`+OK mailbox has ${this.maildrop.length} messages`);
    } else {
      this.send('-ERR unknown command');
    }
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
