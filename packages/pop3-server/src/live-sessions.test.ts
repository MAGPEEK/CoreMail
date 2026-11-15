/**
 * v7.1.0: live POP3 sessions end after a credential change (-ERR [AUTH] and
 * close), app password revocation only ends sessions that used THAT app
 * password, other users and neutral events are left alone, a running command
 * is not cut and nothing queued after it runs (no UPDATE state → no deletion).
 * Loopback TLS sockets, fake Prisma via globalThis.__prisma.
 * Run: node --import tsx --test src/live-sessions.test.ts (in packages/pop3-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

const users: Record<string, { id: string; mailbox: string }> = {
  'bob@example.test': { id: 'u1', mailbox: 'mb1' },
  'carol@example.test': { id: 'u2', mailbox: 'mb2' },
};
const appPasswords = [
  { id: 'ap1', userId: 'u1', hash: 'hash:APP-ONE' },
  { id: 'ap2', userId: 'u1', hash: 'hash:APP-TWO' },
];
let dropGate: Promise<void> | null = null;
let retrGate: Promise<void> | null = null;
const deleted: string[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  domain: { findFirst: async () => ({ name: 'example.test' }) },
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => {
      const u = users[where.email];
      return u ? { id: u.id, email: where.email, displayName: u.id, domainId: 'd1', role: 'USER', active: true,
        passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: u.mailbox } } : null;
    },
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => appPasswords.filter((a) => a.userId === where.userId),
    update: async () => ({}),
  },
  mailbox: {
    findFirst: async () => {
      if (dropGate) await dropGate;
      return { id: 'mb1', folders: [{ id: 'inbox', messages: [{ id: 'm1', uid: 1, rawSize: 10 }, { id: 'm2', uid: 2, rawSize: 20 }] }] };
    },
  },
  message: {
    findUnique: async () => { if (retrGate) await retrGate; return null; },
    updateMany: async ({ where }: { where: { id: { in: string[] } } }) => { deleted.push(...where.id.in); return { count: where.id.in.length }; } },
};

const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { POP3Session, pop3LiveSessions, CREDENTIALS_CHANGED_ERR } = await import('./session.js');
const { selfSignedTestCert } = await import('./test-cert.js');
const CERT = selfSignedTestCert();
pop3LiveSessions.attachInvalidation();
const publish = (event: Parameters<typeof core.publishAuthInvalidation>[0]) => core.publishAuthInvalidation(event, { redis: null });

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(readonly socket: net.Socket) {
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
  async waitClosed(timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > end) throw new Error('connection not closed');
      await new Promise<void>((r) => { const t = setTimeout(r, 50); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
}

let server: tls.Server | null = null;
async function port(): Promise<number> {
  if (!server) {
    // These tests need several concurrent sessions of one user (different
    // credentials); the RFC 1939 §4 maildrop lock is covered in maildrop-lock.test.ts.
    const noLock = async () => ({ status: 'ok' as const, release: async () => {} });
    server = tls.createServer({ ...CERT }, (s) => new POP3Session(s, true, { lock: noLock }).start());
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    server.unref();
  }
  return (server.address() as net.AddressInfo).port;
}

async function login(t: TestContext, email: string, password: string, waitOk = true): Promise<Client> {
  const socket = tls.connect({ port: await port(), host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const c = new Client(socket);
  t.after(() => socket.destroy());
  assert.match(await c.line(), /^\+OK /);
  c.write(`USER ${email}\r\n`);
  assert.match(await c.line(), /^\+OK/);
  c.write(`PASS ${password}\r\n`);
  if (waitOk) assert.match(await c.line(), /^\+OK mailbox has/);
  return c;
}

async function expectDropped(c: Client): Promise<void> {
  assert.equal(await c.line(), CREDENTIALS_CHANGED_ERR);
  await c.waitClosed();
}
async function expectAlive(c: Client): Promise<void> {
  c.write('NOOP\r\n');
  assert.match(await c.line(), /^\+OK/);
}

describe('POP3 live sessions after credential changes', () => {
  for (const reason of ['password-change', 'password-reset', 'admin-password-reset', 'mfa-change', 'deactivated', 'deleted', 'ldap-sync-disabled'] as const) {
    test(`${reason}: session ends, other users keep theirs`, async (t) => {
      const bob = await login(t, 'bob@example.test', 'secret');
      const carol = await login(t, 'carol@example.test', 'secret');
      await publish({ userId: 'u1', reason });
      await expectDropped(bob);
      await expectAlive(carol);
    });
  }

  test('app password revoked: only the session with that app password ends', async (t) => {
    const one = await login(t, 'bob@example.test', 'APP-ONE');
    const two = await login(t, 'bob@example.test', 'APP-TWO');
    const pw = await login(t, 'bob@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await expectDropped(one);
    await expectAlive(two);
    await expectAlive(pw);
  });

  test('MFA change and password change keep app-password sessions; neutral events keep everything', async (t) => {
    const app = await login(t, 'bob@example.test', 'APP-ONE');
    const pw = await login(t, 'bob@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'role-change' });
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['web'] });
    await publish({ userId: 'u1', reason: 'app-password-created' });
    await expectAlive(pw);
    await publish({ userId: 'u1', reason: 'mfa-change' });
    await publish({ userId: 'u1', reason: 'password-change' });
    await expectAlive(app);
    await expectDropped(pw);
  });

  test('queued commands do not run after the change and DELE is not committed', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    bob.write('DELE 1\r\n');
    assert.match(await bob.line(), /^\+OK/);
    await publish({ userId: 'u1', reason: 'password-reset' });
    await expectDropped(bob);
    assert.deepEqual(deleted, [], 'no UPDATE state after a forced close');
  });

  test('a change during the login: the PASS reply completes, then the session ends', async (t) => {
    let release!: () => void;
    dropGate = new Promise<void>((r) => { release = r; });
    try {
      const bob = await login(t, 'bob@example.test', 'secret', false);
      bob.write('STAT\r\n'); // queued behind the PASS that is still loading the maildrop
      await new Promise((r) => setTimeout(r, 50));
      // The password was checked already, the session is not registered yet.
      await publish({ userId: 'u1', reason: 'password-change' });
      release();
      assert.match(await bob.line(), /^\+OK mailbox has 2/);
      await expectDropped(bob); // STAT never runs
    } finally {
      dropGate = null;
    }
  });

  test('a running command finishes before the -ERR', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    let release!: () => void;
    retrGate = new Promise<void>((r) => { release = r; });
    try {
      bob.write('RETR 1\r\nNOOP\r\n'); // RETR is waiting for the database
      await new Promise((r) => setTimeout(r, 50));
      await publish({ userId: 'u1', reason: 'password-change' });
      release();
      assert.equal(await bob.line(), '-ERR message not found'); // RETR's own reply
      await expectDropped(bob); // the pipelined NOOP is dropped
    } finally {
      retrGate = null;
    }
  });

  test('closed sessions leave the registry', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    assert.ok(pop3LiveSessions.count('u1') >= 1);
    bob.write('QUIT\r\n');
    await bob.waitClosed();
    for (let i = 0; i < 20 && pop3LiveSessions.count('u1') > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(pop3LiveSessions.count('u1'), 0);
  });
});
