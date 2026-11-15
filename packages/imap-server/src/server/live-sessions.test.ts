/**
 * v7.1.0: live IMAP connections end after a credential change.
 *  - IDLE / authenticated connections get "* BYE Credentials changed, please
 *    log in again" and are closed on password change/reset, MFA enabled,
 *    deactivation, deletion and "revoke all sessions";
 *  - app password revocation only ends connections that used THAT app password;
 *  - neutral events (role change, web logout, app password created) and other
 *    users' connections are left alone;
 *  - a running command finishes before the BYE;
 *  - events from other services arrive through the Redis subscriber.
 * Loopback TLS sockets, fake Prisma via globalThis.__prisma, fake Redis.
 * Run: node --import tsx --test src/server/live-sessions.test.ts (in packages/imap-server)
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

const user = (id: string, email: string, mailbox: string) => ({
  id, email, displayName: id, domainId: 'd1', role: 'USER', active: true,
  passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: mailbox },
});
const users = [user('u1', 'bob@example.test', 'mb1'), user('u2', 'carol@example.test', 'mb2')];
const appPasswords = [
  { id: 'ap1', userId: 'u1', hash: 'hash:APP-ONE' },
  { id: 'ap2', userId: 'u1', hash: 'hash:APP-TWO' },
];
let listGate: Promise<void> | null = null;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  domain: { findFirst: async () => ({ name: 'example.test' }) },
  user: { findFirst: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => appPasswords.filter((a) => a.userId === where.userId),
    update: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  },
  folder: { findMany: async () => { if (listGate) await listGate; return []; } },
  session: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
};
// Revocation markers of @coremail/storage/auth (revokeAllSessions) — in memory.
const kv = new Map<string, string>();
(globalThis as Record<string, unknown>)['__authRedis'] = {
  async get(k: string) { return kv.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
  // no publish → publishUserAuthChange dispatches locally only
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
const sauth = await import('@coremail/storage/auth');
const { createImapServer } = await import('./index.js');
const { imapLiveSessions } = await import('../session/live.js');
const { selfSignedTestCert } = await import('../test-cert.js');
const CERT = selfSignedTestCert();

imapLiveSessions.attachInvalidation();
// Remote events (other services) arrive via the Redis subscriber like in server.ts.
type Listener = (channel: string, message: string) => void;
const remote = new Set<Listener>();
core.startAuthInvalidationSubscriber({ subscriber: { subscribe: async () => 1, on: (_e: 'message', l: Listener) => { remote.add(l); } } });
const remotePublish = (event: Record<string, unknown>): void => {
  for (const l of remote) l(core.CHANNEL_AUTH_INVALIDATE, JSON.stringify(event));
};
const publish = (event: Parameters<typeof core.publishAuthInvalidation>[0]) => core.publishAuthInvalidation(event, { redis: null });

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(public socket: net.Socket) {
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
      if (Date.now() > end) throw new Error('connection not closed');
      await new Promise<void>((r) => { const t = setTimeout(r, 50); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
}

let server: tls.Server | net.Server | null = null;
async function port(): Promise<number> {
  if (!server) {
    server = createImapServer(CERT);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    server.unref();
  }
  return (server.address() as net.AddressInfo).port;
}

/** Logs in (LOGIN over implicit TLS); `idle` → enters IDLE. */
async function login(t: TestContext, email: string, password: string, idle = true): Promise<Client> {
  const socket = tls.connect({ port: await port(), host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const client = new Client(socket);
  t.after(() => client.socket.destroy());
  await client.line(); // greeting
  assert.equal((await client.cmd('L1', `LOGIN ${email} ${password}`)).status, 'OK');
  if (idle) {
    client.write('I1 IDLE\r\n');
    assert.match(await client.line(), /^\+ /);
  }
  return client;
}

async function expectBye(c: Client): Promise<void> {
  assert.equal(await c.line(), '* BYE Credentials changed, please log in again');
  await c.waitClosed();
}

/** The connection is still usable: DONE ends IDLE, NOOP succeeds. */
async function expectAlive(c: Client, idle = true): Promise<void> {
  if (idle) {
    c.write('DONE\r\n');
    assert.equal((await c.tagged('I1')).status, 'OK');
  }
  assert.equal((await c.cmd('N1', 'NOOP')).status, 'OK');
}

describe('IMAP live sessions after credential changes', () => {
  for (const [reason, extra] of [
    ['password-change', { revokeBefore: { before: 9e9, except: 'web-1', expires: Date.now() + 60_000 } }],
    ['password-reset', {}],
    ['admin-password-reset', {}],
    ['mfa-change', {}],
    ['deactivated', {}],
    ['deleted', {}],
    ['admin-revoke:root', { revokeBefore: { before: 9e9, except: null, expires: Date.now() + 60_000 } }],
  ] as const) {
    test(`${reason}: IDLE connection gets BYE, other users keep theirs`, async (t) => {
      const bob = await login(t, 'bob@example.test', 'secret');
      const carol = await login(t, 'carol@example.test', 'secret');
      await publish({ userId: 'u1', reason, ...extra });
      await expectBye(bob);
      await expectAlive(carol);
    });
  }

  test('password change via revokeAllSessions (storage) ends password logins, keeps app-password logins', async (t) => {
    const pw = await login(t, 'bob@example.test', 'secret');
    const app = await login(t, 'bob@example.test', 'APP-ONE');
    await sauth.revokeAllSessions('u1', { reason: 'password-change', exceptSessionId: 'web-1' });
    await expectBye(pw);
    await expectAlive(app);
  });

  test('password reset by mail (app passwords deleted) ends app-password logins too', async (t) => {
    const app = await login(t, 'bob@example.test', 'APP-TWO');
    await sauth.revokeAllSessions('u1', { reason: 'password-reset-by-mail', appPasswords: true });
    await expectBye(app);
  });

  test('MFA enabled keeps app-password logins', async (t) => {
    const app = await login(t, 'bob@example.test', 'APP-ONE');
    await publish({ userId: 'u1', reason: 'mfa-change' });
    await expectAlive(app);
  });

  test('app password revoked: only connections with that app password end', async (t) => {
    const one = await login(t, 'bob@example.test', 'APP-ONE');
    const two = await login(t, 'bob@example.test', 'APP-TWO');
    const pw = await login(t, 'bob@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await expectBye(one);
    await expectAlive(two);
    await expectAlive(pw);
  });

  test('neutral events keep the connection', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'role-change', revokeBefore: { before: 9e9, except: null, expires: Date.now() + 60_000 } });
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['web-1'] });
    await publish({ userId: 'u1', reason: 'app-password-created' });
    await publish({ userId: 'u1', reason: 'reactivated' });
    await expectAlive(bob);
  });

  test('event from another service (Redis subscriber) ends the connection', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    remotePublish({ userId: 'u1', reason: 'password-reset' });
    await expectBye(bob);
  });

  test('a running command finishes before the BYE; nothing runs afterwards', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret', false);
    let release!: () => void;
    listGate = new Promise<void>((r) => { release = r; });
    try {
      bob.write('A1 LIST "" "*"\r\nA2 NOOP\r\n');
      await new Promise((r) => setTimeout(r, 50));
      await publish({ userId: 'u1', reason: 'password-change' });
      release();
      const r = await bob.tagged('A1');
      assert.equal(r.status, 'OK');
      await expectBye(bob);
      assert.ok(!bob.buffer.includes('A2 '), 'pipelined NOOP must not run after BYE');
    } finally {
      listGate = null;
    }
  });

  test('closed connections leave the registry', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret', false);
    assert.ok(imapLiveSessions.count('u1') >= 1);
    await bob.cmd('Z1', 'LOGOUT');
    await bob.waitClosed();
    for (let i = 0; i < 20 && imapLiveSessions.count('u1') > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(imapLiveSessions.count('u1'), 0);
  });
});
