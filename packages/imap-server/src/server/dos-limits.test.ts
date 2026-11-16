/**
 * v8.1 IMAP DoS hardening:
 *  - before authentication literals/lines are capped at 8 KiB (no 25 MB NOOP literal),
 *  - per-IP and global connection caps (checked on the raw TCP connection),
 *  - 60 s idle timeout before login (30 min afterwards),
 *  - STARTTLS handshake timeout,
 *  - concurrent sessions per user → NO [LIMIT].
 * Loopback sockets, fake Prisma via globalThis.__prisma, in-memory Redis.
 * Run: node --import tsx --test src/server/dos-limits.test.ts (in packages/imap-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
process.env['LOG_LEVEL'] ??= 'error';

const users = [
  { id: 'u1', email: 'bob@example.test', displayName: 'Bob', domainId: 'd1', role: 'USER', active: true,
    passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb1' } },
];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  domain: { findFirst: async () => ({ name: 'example.test' }) },
  user: { findFirst: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null },
  appPassword: { findMany: async () => [], update: async () => ({}) },
};
const noop = () => undefined;
const core = await import('@coremail/core');
const redisClient = core.getRedisClient();
redisClient.disconnect(); // no reconnect loop in tests
(redisClient as unknown as Record<string, unknown>)['duplicate'] = () => ({ subscribe: async () => 1, on: noop });

const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { createImapServer } = await import('./index.js');
const { setMaxConnsPerUser, PRE_AUTH_MAX_LITERAL, imapConnectionLimiter, DEFAULT_IMAP_MAX_CONNS_PER_IP } = await import('./limits.js');
const { selfSignedTestCert } = await import('../test-cert.js');
const CERT = selfSignedTestCert();

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(public socket: net.Socket) { this.attach(socket); }
  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { this.buffer += c; this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => undefined);
  }
  write(s: string): void { this.socket.write(s); }
  async line(timeoutMs = 3000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i !== -1) { const l = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 2); return l; }
      if (this.closed) throw new Error('closed');
      const rest = end - Date.now();
      if (rest <= 0) throw new Error(`timeout (buffer ${JSON.stringify(this.buffer)})`);
      await new Promise<void>((r) => { const t = setTimeout(r, rest); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
  async tagged(tag: string): Promise<{ status: string; line: string; untagged: string[] }> {
    const untagged: string[] = [];
    for (;;) {
      const l = await this.line();
      if (l.startsWith(`${tag} `)) return { status: l.split(' ')[1] ?? '', line: l, untagged };
      untagged.push(l);
    }
  }
  async cmd(tag: string, c: string) { this.write(`${tag} ${c}\r\n`); return this.tagged(tag); }
  async waitClosed(timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.closed) {
      const rest = end - Date.now();
      if (rest <= 0) throw new Error('still open');
      await new Promise<void>((r) => { const t = setTimeout(r, rest); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
}

type Options = Parameters<typeof createImapServer>[1];

async function listen(t: TestContext, implicit: boolean, options: Options = {}) {
  const server = implicit ? createImapServer(CERT, options) : createImapServer(undefined, { starttls: () => CERT, ...options });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  const clients: Client[] = [];
  t.after(() => { for (const c of clients) c.socket.destroy(); server.close(); });
  const open = async (): Promise<Client> => {
    const socket = implicit
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
      : net.connect(port, '127.0.0.1');
    const client = new Client(socket);
    clients.push(client);
    await new Promise<void>((resolve) => {
      socket.once(implicit ? 'secureConnect' : 'connect', () => resolve());
      socket.once('close', () => resolve());
    });
    return client;
  };
  return { open };
}

describe('pre-authentication literal cap', () => {
  test('a 26 MB non-synchronizing literal on NOOP closes the connection before any data is buffered', async (t) => {
    const { open } = await listen(t, true);
    const c = await open();
    await c.line(); // greeting
    c.write('a NOOP {26000000+}\r\n');
    assert.match(await c.line(), /^a NO \[TOOBIG\]/);
    assert.match(await c.line(), /^\* BYE/);
    await c.waitClosed();
  });

  test('a synchronizing LOGIN literal above 8 KiB gets NO [TOOBIG] without continuation; small literals still work', async (t) => {
    const { open } = await listen(t, true);
    const c = await open();
    await c.line();
    c.write(`a LOGIN {${PRE_AUTH_MAX_LITERAL + 1}}\r\n`);
    assert.match(await c.line(), /^a NO \[TOOBIG\]/);
    c.write('b LOGIN {16}\r\n');
    assert.match(await c.line(), /^\+ /);
    c.write('bob@example.test secret\r\n');
    assert.equal((await c.tagged('b')).status, 'OK');
    // After login the regular message-size cap applies again.
    c.write(`c NOOP {${PRE_AUTH_MAX_LITERAL * 4}}\r\n`);
    assert.match(await c.line(), /^\+ /);
  });

  test('an unterminated pre-auth line above 8 KiB closes the connection', async (t) => {
    const { open } = await listen(t, true);
    const c = await open();
    await c.line();
    c.write('a NOOP ' + 'x'.repeat(9000));
    assert.match(await c.line(), /^\* BYE Line too long/);
    await c.waitClosed();
  });
});

describe('connection limits', () => {
  test('per-IP cap: the connection above the limit gets BYE, a slot frees up on close', async (t) => {
    const limiter = new core.ConnectionLimiter({ maxPerIp: 2, maxTotal: 100 });
    const { open } = await listen(t, false, { limiter });
    const a = await open();
    const b = await open();
    assert.match(await a.line(), /^\* OK/);
    assert.match(await b.line(), /^\* OK/);
    const c = await open();
    assert.match(await c.line(), /^\* BYE \[UNAVAILABLE\] Too many connections/);
    await c.waitClosed();
    a.socket.destroy();
    await a.waitClosed();
    await new Promise((r) => setTimeout(r, 50));
    const d = await open();
    assert.match(await d.line(), /^\* OK/);
  });

  test('global cap on implicit TLS: the raw connection is dropped before the handshake', async (t) => {
    const limiter = new core.ConnectionLimiter({ maxPerIp: 0, maxTotal: 1 });
    const { open } = await listen(t, true, { limiter });
    const a = await open();
    assert.match(await a.line(), /^\* OK/);
    const b = await open();
    await b.waitClosed();
    assert.equal(b.buffer, '');
    assert.equal(limiter.count(), 1);
  });
});

describe('timeouts', () => {
  test('an unauthenticated connection is closed after the pre-auth idle timeout', async (t) => {
    const { open } = await listen(t, true, { preAuthIdleMs: 150 });
    const c = await open();
    await c.line();
    assert.match(await c.line(1000), /^\* BYE Autologout/);
    await c.waitClosed();
  });

  test('after login the long autologout timer applies', async (t) => {
    const { open } = await listen(t, true, { preAuthIdleMs: 150 });
    const c = await open();
    await c.line();
    assert.equal((await c.cmd('a', 'LOGIN bob@example.test secret')).status, 'OK');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(c.closed, false);
    assert.equal((await c.cmd('b', 'NOOP')).status, 'OK');
  });

  test('a STARTTLS handshake that never starts is cut off', async (t) => {
    const { open } = await listen(t, false, { tlsHandshakeMs: 150 });
    const c = await open();
    await c.line();
    assert.equal((await c.cmd('a', 'STARTTLS')).status, 'OK');
    // no ClientHello
    await c.waitClosed(2000);
  });
});

describe('sessions per user', () => {
  test('a login above IMAP_MAX_CONNS_PER_USER is refused with NO [LIMIT]', async (t) => {
    setMaxConnsPerUser(2);
    t.after(() => setMaxConnsPerUser(20));
    const { open } = await listen(t, true);
    const logins: Client[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await open();
      await c.line();
      assert.equal((await c.cmd('a', 'LOGIN bob@example.test secret')).status, 'OK');
      logins.push(c);
    }
    const third = await open();
    await third.line();
    const r = await third.cmd('a', 'LOGIN bob@example.test secret');
    assert.match(r.line, /^a NO \[LIMIT\]/);
    assert.equal((await logins[0]!.cmd('z', 'LOGOUT')).status, 'OK');
    await logins[0]!.waitClosed();
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal((await third.cmd('b', 'LOGIN bob@example.test secret')).status, 'OK');
  });
});

test('v8.1 review: the default per-IP cap is 50 (NAT offices)', { skip: !!process.env['IMAP_MAX_CONNS_PER_IP'] }, () => {
  assert.equal(DEFAULT_IMAP_MAX_CONNS_PER_IP, 50);
  const releases: Array<() => void> = [];
  for (let i = 0; i < 50; i++) {
    const r = imapConnectionLimiter.acquire('198.51.100.77');
    assert.ok(r.ok, `connection ${i + 1}`);
    if (r.ok) releases.push(r.release);
  }
  assert.equal(imapConnectionLimiter.acquire('198.51.100.77').ok, false);
  for (const release of releases) release();
});

test('isPeerDisconnect: client resets are not server errors (live BCP test 9.2)', async () => {
  const { isPeerDisconnect } = await import('./limits.js');
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']) assert.equal(isPeerDisconnect(Object.assign(new Error('x'), { code })), true, code);
  for (const e of [new Error('boom'), Object.assign(new Error('x'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), null, undefined, 'ECONNRESET']) assert.equal(isPeerDisconnect(e), false, String(e));
});
