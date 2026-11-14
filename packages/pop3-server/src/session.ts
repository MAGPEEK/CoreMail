import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { prisma } from '@coremail/storage/prisma';
import { expunge, verifyMailCredentials } from '@coremail/storage';

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
  /** Commands run strictly one after another (RFC 2449 PIPELINING). */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by STLS — commands received before the upgrade are discarded. */
  private epoch = 0;
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
    // RFC 1939 §3 — greeting with hostname
    this.send(`+OK ${_hostname} POP3 ready`);
  }

  private send(line: string) {
    this.socket.write(line + '\r\n');
  }

  private onData(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split('\r\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      const epoch = this.epoch;
      this.queue = this.queue.then(async () => {
        if (epoch !== this.epoch) return; // pipelined before STLS → discarded
        if (line.length > 512) {
          this.send('-ERR line too long');
          return;
        }
        await this.handleCommand(line).catch((err) => {
          log.error({ err }, 'command error');
          this.send('-ERR internal error');
        });
      });
    }
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
      return this.send('-ERR [AUTH] Authentication requires TLS — use STLS or port 995');
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
        const i = parseInt(args[0], 10) - 1;
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
        const i = parseInt(args[0], 10) - 1;
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
      const i = parseInt(args[0] ?? '', 10) - 1;
      const msg = this.maildrop[i];
      if (!msg || msg.deleted) return this.send('-ERR no such message');
      await this.sendMessage(msg.id, null);
    } else if (command === 'TOP') {
      const i = parseInt(args[0] ?? '', 10) - 1;
      const lines = parseInt(args[1] ?? '0', 10);
      const msg = this.maildrop[i];
      if (!msg || msg.deleted) return this.send('-ERR no such message');
      await this.sendMessage(msg.id, lines);
    } else if (command === 'DELE') {
      const i = parseInt(args[0] ?? '', 10) - 1;
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

  private async sendMessage(id: string, topLines: number | null) {
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) return this.send('-ERR message not found');

    const eml = buildEml(msg as Record<string, unknown>);
    this.send(`+OK ${eml.length} octets`);

    // v5.3.1 FIX: byte-stuffing per RFC 1939 §3 — EVERY line starting with "."
    // must be escaped as "..". Otherwise the mail gets truncated by
    // clients, because "." at the start of a line signals end-of-message.
    // Previously: only the first character via `replace(/^\./, '..')`
    // → multi-line mails with "." at the start of a line were received corrupted.
    const stuffLines = (text: string): string =>
      text.split(/\r?\n/).map((line) => line.startsWith('.') ? '.' + line : line).join('\r\n');

    if (topLines !== null) {
      const parts = eml.split('\r\n\r\n');
      const headers = parts[0] ?? '';
      const body = (parts.slice(1).join('\r\n\r\n')).split('\r\n').slice(0, topLines).join('\r\n');
      const output = body ? `${headers}\r\n\r\n${body}` : headers;
      this.send(stuffLines(output));
    } else {
      this.send(stuffLines(eml));
    }
    this.send('.');
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

function buildEml(msg: Record<string, unknown>): string {
  const from = msg['fromAddr'] as string;
  const to = (msg['toAddrs'] as string[]).join(', ');
  const date = new Date(msg['date'] as string).toUTCString();
  const subject = msg['subject'] as string;
  const body = (msg['bodyText'] as string) || (msg['bodyHtml'] as string) || '';

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
  ].join('\r\n');
}
