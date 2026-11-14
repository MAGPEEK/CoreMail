/**
 * POP3 RETR/TOP/LIST from the raw message (byte-exact, dot-stuffed, octet counts),
 * TOP argument validation and PIPELINING order — fake Prisma + fake object storage.
 * Run: node --import tsx --test src/retr.test.ts  (in packages/pop3-server)
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Readable } from 'node:stream';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const objects = new Map<string, Buffer>();
(globalThis as unknown as { __minioClient: unknown }).__minioClient = {
  getObject: async (_b: string, key: string) => {
    const data = objects.get(key);
    if (!data) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    return Readable.from([data]);
  },
  putObject: async (_b: string, key: string, data: Buffer) => { objects.set(key, Buffer.from(data)); return {}; },
  statObject: async (_b: string, key: string) => {
    if (!objects.has(key)) throw Object.assign(new Error('NotFound'), { code: 'NotFound' });
    return {};
  },
};

interface Msg { id: string; uid: number; rawSize: number; storagePath: string | null; [k: string]: unknown }
let messages: Msg[] = [];
let passwordHash = '';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  user: { findUnique: async () => { await tick(); return { id: 'u1', email: 'bob@x.test', active: true, passwordHash }; } },
  appPassword: { findMany: async () => [] },
  domain: { findFirst: async () => ({ name: 'x.test' }) },
  mailbox: {
    findFirst: async () => {
      await tick();
      return { id: 'mb1', folders: [{ messages: messages.map(({ id, uid, rawSize }) => ({ id, uid, rawSize })) }] };
    },
  },
  message: {
    findUnique: async ({ where }: { where: { id: string } }) => { await tick(); await tick(); return messages.find((m) => m.id === where.id) ?? null; },
    updateMany: async () => ({ count: 0 }),
  },
  attachment: { findMany: async () => [] },
};

const { hashPassword } = await import('@coremail/core');
passwordHash = await hashPassword('secret');
const { storeRawMessage } = await import('@coremail/storage');
const { POP3Session, dotStuff } = await import('./session.js');
const SIMPLE_MESSAGE = Buffer.from(
  'From: alice@example.test\r\nTo: bob@example.test\r\nSubject: Hi\r\nDate: Tue, 03 Feb 2026 10:20:30 +0000\r\n\r\n'
  + 'line one\r\n.dot line\r\nline three',
);
const NESTED_MESSAGE = Buffer.from([
  'Return-Path: <alice@example.test>', 'From: "Alice" <alice@example.test>', 'To: bob@example.test',
  'Subject: Report', 'X-Custom: ä 8-bit header', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
  '--b', 'Content-Type: text/plain; charset=utf-8', '', 'See attached.', '.leading dot', '--b',
  'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQKJcOkw7zDtsOfCg==', '--b--', '',
].join('\r\n'), 'latin1');

class Client {
  buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  constructor(private readonly socket: net.Socket) {
    socket.on('data', (c: Buffer) => { this.buf = Buffer.concat([this.buf, c]); this.wake?.(); });
  }
  write(s: string): void { this.socket.write(s); }
  /** Waits until the buffer contains `marker` (or times out) and returns everything received. */
  async until(marker: RegExp, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!marker.test(this.buf.toString('latin1'))) {
      if (Date.now() > deadline) throw new Error(`timeout; got ${JSON.stringify(this.buf.toString('latin1'))}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 20); this.wake = () => { clearTimeout(t); r(); }; });
    }
    const out = this.buf.toString('latin1');
    this.buf = Buffer.alloc(0);
    return out;
  }
}

async function login(t: TestContext): Promise<Client> {
  const server = net.createServer((s) => new POP3Session(s, false).start());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  t.after(() => { socket.destroy(); server.close(); });
  const c = new Client(socket);
  await c.until(/POP3 ready\r\n$/);
  c.write('USER bob@x.test\r\nPASS secret\r\n');
  await c.until(/\+OK mailbox has \d+ messages\r\n$/);
  return c;
}

async function stored(id: string, uid: number, raw: Buffer): Promise<Msg> {
  const { storagePath, size } = await storeRawMessage(raw);
  return { id, uid, rawSize: size, storagePath };
}

test('dotStuff: every line starting with "." is stuffed; CRLF + terminator appended', () => {
  assert.equal(dotStuff(Buffer.from('.a\r\nb\r\n..c')).toString(), '..a\r\nb\r\n...c\r\n.\r\n');
  assert.equal(dotStuff(Buffer.from('x\r\n')).toString(), 'x\r\n.\r\n');
});

test('RETR sends the stored raw message byte-exactly; size = LIST = STAT', async (t) => {
  messages = [await stored('m1', 1, NESTED_MESSAGE), await stored('m2', 2, SIMPLE_MESSAGE)];
  const c = await login(t);
  c.write('STAT\r\nLIST\r\nLIST 2\r\n');
  const listing = await c.until(/\+OK 2 \d+\r\n$/);
  assert.match(listing, new RegExp(`^\\+OK 2 ${NESTED_MESSAGE.length + SIMPLE_MESSAGE.length}\\r\\n`));
  assert.match(listing, new RegExp(`\\r\\n1 ${NESTED_MESSAGE.length}\\r\\n2 ${SIMPLE_MESSAGE.length}\\r\\n\\.\\r\\n`));
  c.write('RETR 1\r\n');
  const retr = await c.until(/\r\n\.\r\n$/);
  assert.ok(retr.startsWith(`+OK ${NESTED_MESSAGE.length} octets\r\n`));
  const payload = retr.slice(retr.indexOf('\r\n') + 2, -3);
  // byte-exact apart from dot-stuffing (8-bit header, attachment, all header fields)
  assert.equal(payload.replace(/^\.\./gm, '.'), NESTED_MESSAGE.toString('latin1'), 'attachments and all headers delivered unchanged');
  assert.ok(payload.includes('\r\n..leading dot\r\n'));
  c.write('RETR 2\r\n');
  const r2 = await c.until(/\r\n\.\r\n$/);
  assert.ok(r2.includes('\r\n..dot line\r\n'), 'dot-stuffed');
  assert.ok(r2.endsWith('line three\r\n.\r\n'));
});

test('TOP n: headers, blank line, n body lines; invalid n rejected', async (t) => {
  messages = [await stored('m1', 1, SIMPLE_MESSAGE)];
  const c = await login(t);
  c.write('TOP 1 0\r\n');
  const top0 = await c.until(/\r\n\.\r\n$/);
  assert.equal(top0, '+OK top of message follows\r\nFrom: alice@example.test\r\nTo: bob@example.test\r\nSubject: Hi\r\nDate: Tue, 03 Feb 2026 10:20:30 +0000\r\n\r\n.\r\n');
  c.write('TOP 1 2\r\n');
  const top2 = await c.until(/\r\n\.\r\n$/);
  assert.ok(top2.endsWith('\r\n\r\nline one\r\n..dot line\r\n.\r\n'), top2);
  for (const bad of ['TOP 1', 'TOP 1 -1', 'TOP 1 x', 'TOP 0 1', 'TOP -1 1']) {
    c.write(`${bad}\r\n`);
    assert.match(await c.until(/\r\n$/), /^-ERR/, bad);
  }
});

test('pipelined commands are answered in order', async (t) => {
  messages = [await stored('m1', 1, SIMPLE_MESSAGE), await stored('m2', 2, NESTED_MESSAGE)];
  const c = await login(t);
  c.write('RETR 2\r\nNOOP\r\nLIST 1\r\nRETR 1\r\nUIDL 2\r\n');
  const all = await c.until(/\+OK 2 m2\r\n$/);
  const order = [...all.matchAll(/^\+OK[^\r]*/gm)].map((m) => m[0]);
  assert.deepEqual(order, [
    `+OK ${NESTED_MESSAGE.length} octets`, '+OK', `+OK 1 ${SIMPLE_MESSAGE.length}`, `+OK ${SIMPLE_MESSAGE.length} octets`, '+OK 2 m2',
  ]);
});

test('legacy row without a raw object: RETR rebuilds it with the right content type and size', async (t) => {
  messages = [{
    id: 'm1', uid: 1, rawSize: 5, storagePath: null, subject: 'Hi\r\nBcc: x@evil.test', fromAddr: 'a@x.test', fromName: '',
    toAddrs: ['b@x.test'], ccAddrs: [], replyTo: null, messageId: null, inReplyTo: null, date: new Date(0),
    bodyText: '', bodyHtml: '<p>Hello</p>',
  }];
  const c = await login(t);
  c.write('RETR 1\r\n');
  const out = await c.until(/\r\n\.\r\n$/);
  const size = Number(/^\+OK (\d+) octets/.exec(out)?.[1]);
  const payload = out.slice(out.indexOf('\r\n') + 2, -5);
  assert.equal(Buffer.byteLength(payload, 'latin1'), size);
  assert.match(payload, /\r\nContent-Type: text\/html; charset=utf-8\r\n/);
  assert.ok(!/\r\nBcc:/.test(payload), 'no header injection');
  c.write('LIST 1\r\n');
  assert.equal(await c.until(/\r\n$/), `+OK 1 ${size}\r\n`);
});
