import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { verifyPassword } from '@coremail/core/auth';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('pop3-session');

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
  private buf = '';

  constructor(
    private readonly socket: net.Socket | tls.TLSSocket,
    private readonly secure: boolean,
  ) {}

  start() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onData(chunk));
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
      if (line.length > 512) {
        this.send('-ERR line too long');
        continue;
      }
      this.handleCommand(line.trim()).catch((err) => {
        log.error({ err }, 'command error');
        this.send('-ERR internal error');
      });
    }
  }

  private async handleCommand(line: string) {
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
      // v5.3.1: Normalisierung wie bei IMAP — DOMAIN\user oder bare username
      // → email-form. Plus App-Password-Fallback für MFA-User.
      let email = this.user;
      const bsIdx = email.lastIndexOf('\\');
      if (bsIdx !== -1) email = email.slice(bsIdx + 1);
      email = email.trim().toLowerCase();
      if (!email.includes('@')) {
        // bare username → mit primärer Domain ergänzen
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

      // 1) Regulärer Passwort-Hash
      let authenticated = false;
      if (user.passwordHash) {
        authenticated = await verifyPassword(password, user.passwordHash).catch(() => false);
      }
      // 2) Fallback: App-Password (Pflicht für MFA-Accounts)
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

    // v5.3.1 FIX: Byte-Stuffing nach RFC 1939 §3 — JEDE Zeile, die mit "."
    // beginnt, muss durch ".." eskapiert werden. Sonst wird die Mail bei
    // Clients abgeschnitten, weil "." am Zeilenanfang das End-of-Message
    // signalisiert. Vorher: nur erstes Zeichen via `replace(/^\./, '..')`
    // → mehrzeilige Mails mit "." am Zeilenanfang wurden korrupt empfangen.
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
      await prisma.message.updateMany({
        where: { id: { in: toDelete } },
        data: { deletedAt: new Date() },
      });
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
