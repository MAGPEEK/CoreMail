import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core/logger';
import { verifyPassword } from '@coremail/core/auth';
import { getPrisma } from '@coremail/storage/prisma';

const log = createLogger('pop3-session');

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
    this.send('+OK CoreMail POP3 server ready');
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
    const command = cmd.toUpperCase();

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

      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { email: this.user } });
      if (!user || !(await verifyPassword(args[0], user.passwordHash))) {
        log.warn({ user: this.user }, 'auth failure');
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
    const prisma = getPrisma();
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
    this.maildrop = (mailbox?.folders[0]?.messages ?? []).map((m) => ({
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
    const prisma = getPrisma();
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) return this.send('-ERR message not found');

    const eml = buildEml(msg as Record<string, unknown>);
    this.send(`+OK ${eml.length} octets`);

    if (topLines !== null) {
      const parts = eml.split('\r\n\r\n');
      const headers = parts[0];
      const body = (parts.slice(1).join('\r\n\r\n')).split('\r\n').slice(0, topLines).join('\r\n');
      const output = body ? `${headers}\r\n\r\n${body}` : headers;
      this.send(output.replace(/^\./, '..'));
    } else {
      this.send(eml.replace(/^\./, '..'));
    }
    this.send('.');
  }

  private async updateAndDelete() {
    const prisma = getPrisma();
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
