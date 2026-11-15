/**
 * POP3 UPDATE state, maildrop lock, exact sizes, line endings, backpressure and
 * command syntax (RFC 1939 §3–§6, §11; RFC 2449 §4, §6.6, §8.1.1).
 * Loopback TLS sockets, fake Prisma via globalThis.__prisma, in-memory object store.
 * Run: node --import tsx --test src/update-state.test.ts  (in packages/pop3-server)
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

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

interface Row {
  id: string; uid: number; rawSize: number; storagePath: string | null; folderId: string; deletedAt: Date | null;
  [k: string]: unknown;
}
const db = { messages: [] as Row[], failExpunge: false, passwordHash: '' };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
type Where = { id: string | { in: string[] }; folderId?: string; deletedAt?: null; storagePath?: null };
const matches = (m: Row, w: Where): boolean => (typeof w.id === 'string' ? m.id === w.id : w.id.in.includes(m.id))
  && (w.folderId === undefined || m.folderId === w.folderId)
  && (!('deletedAt' in w) || m.deletedAt === null)
  && (!('storagePath' in w) || m.storagePath === null);

const fakePrisma = {
  $on: () => undefined,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => {
      await tick();
      const id = where.email === 'bob@x.test' ? 'u1' : where.email === 'carol@x.test' ? 'u2' : null;
      return id ? { id, email: where.email, displayName: id, domainId: 'd1', role: 'USER', active: true,
        passwordHash: db.passwordHash, authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb1' } } : null;
    },
  },
  appPassword: { findMany: async () => [], update: async () => ({}) },
  domain: { findFirst: async () => ({ name: 'x.test' }) },
  mailbox: {
    findFirst: async () => {
      await tick();
      const live = db.messages.filter((m) => m.folderId === 'inbox' && m.deletedAt === null).sort((a, b) => a.uid - b.uid);
      return { id: 'mb1', folders: [{ id: 'inbox', messages: live.map(({ id, uid, rawSize, storagePath }) => ({ id, uid, rawSize, storagePath })) }] };
    },
    update: async () => ({ uidNext: 100, highestModSeq: 7n }),
    updateMany: async () => ({ count: 0 }),
  },
  message: {
    aggregate: async () => ({ _max: { modSeq: null, uid: null } }),
    findUnique: async ({ where }: { where: { id: string } }) => { await tick(); return db.messages.find((m) => m.id === where.id) ?? null; },
    updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      await tick();
      if (db.failExpunge && 'deletedAt' in data) throw new Error('database unavailable');
      const rows = db.messages.filter((m) => matches(m, where));
      for (const m of rows) Object.assign(m, data);
      return { count: rows.length };
    },
  },
  attachment: { findMany: async () => [] },
};
(globalThis as Record<string, unknown>)['__prisma'] = fakePrisma;

const { hashPassword } = await import('@coremail/core');
db.passwordHash = await hashPassword('secret');
const { storeRawMessage, createMemoryAuthRedis } = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = createMemoryAuthRedis();
(globalThis as Record<string, unknown>)['__pop3LockRedis'] = null; // in-process lock layer only
const { POP3Session, dotStuff, toCrlf, materializeBounded, legacyMaterializeLimits } = await import('./session.js');
const { selfSignedTestCert } = await import('./test-cert.js');
const CERT = selfSignedTestCert();

class Client {
  buf = Buffer.alloc(0);
  closed = false;
  private wake: (() => void) | null = null;
  constructor(readonly socket: net.Socket) {
    socket.on('data', (c: Buffer) => { this.buf = Buffer.concat([this.buf, c]); this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => { /* surfaced through closed */ });
  }
  write(s: string | Buffer): void { this.socket.write(s); }
  async until(marker: RegExp, timeoutMs = 4000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!marker.test(this.buf.toString('latin1'))) {
      if (Date.now() > deadline) throw new Error(`timeout; got ${JSON.stringify(this.buf.toString('latin1').slice(0, 400))}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 20); this.wake = () => { clearTimeout(t); r(); }; });
    }
    const out = this.buf.toString('latin1');
    this.buf = Buffer.alloc(0);
    return out;
  }
  async waitClosed(timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return this.closed;
  }
}

interface Server { connect(): Promise<Client>; sockets: tls.TLSSocket[] }
async function startServer(t: TestContext): Promise<Server> {
  const sockets: tls.TLSSocket[] = [];
  const server = tls.createServer({ ...CERT }, (s) => { sockets.push(s); new POP3Session(s, true).start(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const clients: Client[] = [];
  t.after(() => { for (const c of clients) c.socket.destroy(); server.close(); });
  return {
    sockets,
    connect: async () => {
      const socket = tls.connect({ port: (server.address() as net.AddressInfo).port, host: '127.0.0.1', rejectUnauthorized: false });
      const c = new Client(socket);
      clients.push(c);
      await c.until(/POP3 ready\r\n$/);
      return c;
    },
  };
}
async function login(c: Client, user = 'bob@x.test'): Promise<string> {
  c.write(`USER ${user}\r\nPASS secret\r\n`);
  return c.until(/\r\n(\+OK|-ERR)[^\r]*\r\n$/);
}
async function stored(id: string, uid: number, raw: Buffer): Promise<Row> {
  const { storagePath, size } = await storeRawMessage(raw);
  return { id, uid, rawSize: size, storagePath, folderId: 'inbox', deletedAt: null };
}
const MSG = (n: number) => Buffer.from(`Subject: m${n}\r\n\r\nbody ${n}\r\n`);
async function three(): Promise<Row[]> { return [await stored('m1', 1, MSG(1)), await stored('m2', 2, MSG(2)), await stored('m3', 3, MSG(3))]; }
const deletedIds = () => db.messages.filter((m) => m.deletedAt !== null).map((m) => m.id).sort();

test('QUIT never removes a message that was DELE\'d but moved to another folder before QUIT (RFC 1939 §6)', async (t) => {
  db.messages = await three();
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.write('DELE 1\r\nDELE 2\r\n');
  await c.until(/message 2 deleted\r\n$/);
  // Another client (IMAP MOVE / JMAP / a rule) moves message 1 to Archive meanwhile.
  db.messages.find((m) => m.id === 'm1')!.folderId = 'archive';
  c.write('QUIT\r\n');
  assert.match(await c.until(/\r\n$/), /^\+OK/);
  assert.ok(await c.waitClosed());
  assert.deepEqual(deletedIds(), ['m2'], 'only the message still in INBOX is removed');
  assert.equal(db.messages.find((m) => m.id === 'm1')!.deletedAt, null);
});

test('QUIT does not touch a message another client already deleted', async (t) => {
  db.messages = await three();
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.write('DELE 3\r\n');
  await c.until(/deleted\r\n$/);
  const earlier = new Date(0);
  db.messages.find((m) => m.id === 'm3')!.deletedAt = earlier;
  c.write('QUIT\r\n');
  await c.until(/\r\n$/);
  assert.equal(db.messages.find((m) => m.id === 'm3')!.deletedAt, earlier);
});

test('QUIT when the removal fails: -ERR [SYS/TEMP], the connection is closed and the lock released', async (t) => {
  db.messages = await three();
  db.failExpunge = true;
  try {
    const srv = await startServer(t);
    const c = await srv.connect();
    await login(c);
    c.write('DELE 1\r\nQUIT\r\n');
    const out = await c.until(/\r\n-ERR[^\r]*\r\n$/);
    assert.match(out, /-ERR \[SYS\/TEMP\] some deleted messages not removed\r\n$/);
    assert.ok(await c.waitClosed(), 'connection closed after a failed UPDATE');
    assert.deepEqual(deletedIds(), []);
    const again = await srv.connect();
    assert.match(await login(again), /\+OK mailbox has 3 messages\r\n$/, 'lock released after the failed UPDATE');
  } finally {
    db.failExpunge = false;
  }
});

test('a second session for the same maildrop gets -ERR [IN-USE]; the lock is released by QUIT and by a dropped connection', async (t) => {
  db.messages = await three();
  const srv = await startServer(t);
  const first = await srv.connect();
  assert.match(await login(first), /\+OK mailbox has 3/);
  const second = await srv.connect();
  assert.match(await login(second), /-ERR \[IN-USE\][^\r]*\r\n$/);
  // Another user is not affected.
  const carol = await srv.connect();
  assert.match(await login(carol, 'carol@x.test'), /\+OK mailbox has/);

  first.write('QUIT\r\n');
  await first.waitClosed();
  const third = await srv.connect();
  assert.match(await login(third), /\+OK mailbox has 3/);

  third.socket.destroy(); // no QUIT: the lock still goes away with the connection
  await new Promise((r) => setTimeout(r, 100));
  const fourth = await srv.connect();
  assert.match(await login(fourth), /\+OK mailbox has 3/);
});

test('legacy row: LIST/STAT report the size RETR sends before the first RETR (RFC 1939 §5)', async (t) => {
  db.messages = [{
    id: 'L1', uid: 1, rawSize: 7, storagePath: null, folderId: 'inbox', deletedAt: null,
    subject: 'Legacy', fromAddr: 'a@x.test', fromName: '', toAddrs: ['b@x.test'], ccAddrs: [], replyTo: null,
    messageId: null, inReplyTo: null, date: new Date(0), bodyText: 'Grüße\r\nzweite Zeile', bodyHtml: '',
  }];
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.write('LIST 1\r\n');
  const list = Number(/^\+OK 1 (\d+)\r\n$/.exec(await c.until(/\r\n$/))?.[1]);
  c.write('STAT\r\n');
  assert.equal(await c.until(/\r\n$/), `+OK 1 ${list}\r\n`);
  c.write('RETR 1\r\n');
  const out = await c.until(/\r\n\.\r\n$/);
  assert.ok(out.startsWith(`+OK ${list} octets\r\n`), out.slice(0, 40));
  const payload = Buffer.from(out.slice(out.indexOf('\r\n') + 2, -3), 'latin1');
  // The payload is the message (+ the CRLF the framing adds when the last line has none).
  assert.ok(payload.length === list || payload.length === list + 2, `${payload.length} vs ${list}`);
  assert.notEqual(list, 7, 'size comes from the materialized raw message, not the stale column');
});

// v8.0 review: the first login after an upgrade materialized EVERY legacy row before +OK.
test('legacy materialization at login is bounded (count, time budget, parallelism)', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);
  let running = 0;
  let peak = 0;
  const load = async (id: string): Promise<number | null> => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    if (id === 'm3') throw new Error('object store down');
    return id.length;
  };
  const byCount = await materializeBounded(ids, load, { max: 10, budgetMs: 60_000, concurrency: 3 });
  assert.equal(byCount.size, 9, '10 tried, the failing one is skipped');
  assert.ok(peak <= 3, `peak parallelism ${peak}`);

  let clock = 0;
  const byTime = await materializeBounded(ids, async (id) => { clock += 100; return id.length; },
    { max: 1000, budgetMs: 450, concurrency: 1 }, () => clock);
  assert.ok(byTime.size >= 4 && byTime.size <= 6, `stops after the budget (${byTime.size})`);
});

test('legacy rows beyond the per-login limit keep the stored size until RETR corrects it', async (t) => {
  const saved = { ...legacyMaterializeLimits };
  legacyMaterializeLimits.max = 1;
  t.after(() => Object.assign(legacyMaterializeLimits, saved));
  const legacy = (id: string, uid: number): Row => ({
    id, uid, rawSize: 7, storagePath: null, folderId: 'inbox', deletedAt: null,
    subject: `Legacy ${id}`, fromAddr: 'a@x.test', fromName: '', toAddrs: ['b@x.test'], ccAddrs: [], replyTo: null,
    messageId: null, inReplyTo: null, date: new Date(0), bodyText: 'text', bodyHtml: '',
  });
  db.messages = [legacy('A1', 1), legacy('A2', 2), legacy('A3', 3)];
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.write('LIST\r\n');
  const list = await c.until(/\r\n\.\r\n$/);
  const sizes = [...list.matchAll(/^(\d) (\d+)\r$/gm)].map((m) => Number(m[2]));
  assert.equal(sizes.length, 3, list);
  assert.notEqual(sizes[0], 7, 'the first legacy row was materialized');
  assert.deepEqual(sizes.slice(1), [7, 7], 'the others keep the stored size for now');
  c.write('RETR 2\r\n');
  const out = await c.until(/\r\n\.\r\n$/);
  const announced = Number(/^\+OK (\d+) octets/.exec(out)?.[1]);
  c.write('LIST 2\r\n');
  assert.equal(await c.until(/\r\n$/), `+OK 2 ${announced}\r\n`, 'RETR made the size exact');
});

test('a message stored with bare LF line endings is sent with CRLF and a proper terminator (RFC 1939 §3)', async (t) => {
  const raw = Buffer.from('Subject: lf\n\nline one\n.dot\nlast\n');
  db.messages = [await stored('lf', 1, raw)];
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.write('RETR 1\r\nNOOP\r\n');
  const out = await c.until(/\r\n\.\r\n\+OK\r\n$/);
  const body = out.slice(out.indexOf('\r\n') + 2, out.lastIndexOf('\r\n.\r\n') + 2);
  assert.equal(body, 'Subject: lf\r\n\r\nline one\r\n..dot\r\nlast\r\n');
  assert.ok(!/[^\r]\n/.test(body), 'no bare LF on the wire');
  assert.ok(out.startsWith(`+OK ${toCrlf(raw).length} octets\r\n`));
  c.write('LIST 1\r\nTOP 1 1\r\n');
  const rest = await c.until(/\r\n\.\r\n$/);
  assert.match(rest, new RegExp(`^\\+OK 1 ${toCrlf(raw).length}\\r\\n`), 'LIST reports the CRLF size after RETR');
  assert.ok(rest.endsWith('Subject: lf\r\n\r\nline one\r\n.\r\n'), rest);
});

test('toCrlf / dotStuff: bare LF becomes CRLF, existing CRLF stays', () => {
  assert.equal(toCrlf(Buffer.from('a\nb\r\nc\n')).toString(), 'a\r\nb\r\nc\r\n');
  const same = Buffer.from('a\r\nb');
  assert.equal(toCrlf(same), same);
  assert.equal(dotStuff(Buffer.from('a\n.b\n')).toString(), 'a\r\n..b\r\n.\r\n');
});

test('pipelined RETRs to a client that does not read: the server buffer stays bounded (backpressure)', async (t) => {
  const big = Buffer.concat([Buffer.from('Subject: big\r\n\r\n'), Buffer.alloc(2 * 1024 * 1024, 'x')]);
  db.messages = [await stored('big', 1, big)];
  const srv = await startServer(t);
  const c = await srv.connect();
  await login(c);
  c.socket.pause(); // stop reading
  c.write('RETR 1\r\n'.repeat(20));
  await new Promise((r) => setTimeout(r, 500));
  const server = srv.sockets.at(-1)!;
  // Without backpressure all 20 messages (≈40 MB) would sit in the server's buffer.
  assert.ok(server.writableLength < 8 * 1024 * 1024, `server buffered ${server.writableLength} octets`);
  c.socket.destroy();
});

test('command syntax: empty arguments are rejected, PASS after a leading space, limit counted in octets', async (t) => {
  db.messages = await three();
  const srv = await startServer(t);
  const c = await srv.connect();
  c.write(' USER bob@x.test\r\n PASS secret\r\n');
  assert.match(await c.until(/mailbox has 3 messages\r\n$/), /\+OK send PASS\r\n\+OK mailbox has 3 messages\r\n$/);
  c.write('LIST  1\r\n');
  assert.match(await c.until(/\r\n$/), /^-ERR syntax error/);
  c.write('LIST 1\r\n');
  assert.match(await c.until(/\r\n$/), /^\+OK 1 \d+\r\n$/);
  // 200 × "ä" = 400 octets + "NOOP " → over 512 octets on the wire, though only 205 characters.
  c.write(Buffer.from(`NOOP ${'ä'.repeat(260)}\r\nNOOP\r\n`, 'utf8'));
  assert.match(await c.until(/\r\n\+OK\r\n$/), /^-ERR line too long\r\n\+OK\r\n$/);
});
