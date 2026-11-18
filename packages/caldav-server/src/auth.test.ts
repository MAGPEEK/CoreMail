import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeProtocolPolicies } from '@coremail/storage/auth/testing';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['AUTH_SERVICE_URL'];

interface FakeUser {
  id: string; email: string; active: boolean; displayName: string; domainId: string; role: string;
  passwordHash: string | null; authSource: string; mfa: { totpEnabled: boolean; webAuthnCredentials: unknown[] } | null;
  mailbox: null;
}
const mk = (id: string, active: boolean, mfa = false): FakeUser => ({
  id, email: `${id}@example.com`, active, displayName: id, domainId: 'd1', role: 'USER',
  passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: mfa ? { totpEnabled: true, webAuthnCredentials: [] } : null, mailbox: null,
});
const users: Record<string, FakeUser> = { alice: mk('alice', true), gone: mk('gone', false), mfa: mk('mfa', true, true) };
const state = { dbDown: false };
/** 9.4: ProtocolPolicy rows (protocol switches). */
const policies: Array<Record<string, unknown>> = [];

const prisma: Record<string, unknown> = {
  $on: () => undefined,
  ...fakeProtocolPolicies(policies),
  user: {
    findUnique: async (args: { where: { id: string } }) => users[args.where.id] ?? null,
    findFirst: async (args: { where: { email: string; active: boolean } }) => {
      if (state.dbDown) throw new Error('db down');
      return Object.values(users).find((u) => u.email === args.where.email && u.active === args.where.active) ?? null;
    },
  },
  appPassword: {
    findMany: async (args: { where: { userId: string } }) =>
      args.where.userId === 'mfa' || args.where.userId === 'alice' ? [{ id: `ap-${args.where.userId}`, hash: 'hash:APP-PW' }] : [],
    update: async () => ({}),
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
};
(globalThis as Record<string, unknown>)['__prisma'] = prisma;

// v7.1.0: Bearer checks consult the session revocation markers (fake Redis).
const { createFakeRedis } = await import('@coremail/storage/auth/testing');
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();

const { signAccessToken, signRefreshToken } = await import('@coremail/core');
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
});
const { davAuthMiddleware, davFeatureGate, davFeatureOf } = await import('./auth.js');

type Outcome = { nextCalled: boolean; status: number | null; davUser: unknown };

async function run(authorization: string | undefined): Promise<Outcome> {
  const req = {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    headers: {},
    socket: { remoteAddress: '203.0.113.10' },
  } as unknown as Parameters<typeof davAuthMiddleware>[0];
  const outcome: Outcome = { nextCalled: false, status: null, davUser: undefined };
  const res = {
    set: () => res,
    type: () => res,
    status: (code: number) => { outcome.status = code; return res; },
    send: () => res,
  } as unknown as Parameters<typeof davAuthMiddleware>[1];
  await davAuthMiddleware(req, res, () => { outcome.nextCalled = true; });
  outcome.davUser = (req as unknown as { davUser?: unknown }).davUser;
  return outcome;
}

const accessFor = (id: string) => signAccessToken({
  sub: id, email: `${id}@example.com`, role: 'USER',
  domainId: 'domain-1', sessionId: 'session-1', mfaVerified: false,
});
const basic = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;

let fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

test('a garbage bearer token is answered with 401 instead of crashing', async () => {
  const out = await run('Bearer x');
  assert.equal(out.status, 401);
  assert.equal(out.nextCalled, false);
});

test('a valid bearer token of an active user passes', async () => {
  const out = await run(`Bearer ${accessFor('alice')}`);
  assert.equal(out.nextCalled, true);
  assert.deepEqual(out.davUser, { userId: 'alice', email: 'alice@example.com' });
});

test('a refresh token is not accepted as bearer token', async () => {
  const out = await run(`Bearer ${signRefreshToken('alice', 'session-1')}`);
  assert.equal(out.status, 401);
});

test('a bearer token of a deactivated user is rejected', async () => {
  assert.equal((await run(`Bearer ${accessFor('gone')}`)).status, 401);
});

test('a bearer token of a revoked session is rejected (v7.1.0)', async () => {
  const token = signAccessToken({
    sub: 'alice', email: 'alice@example.com', role: 'USER', domainId: 'domain-1', sessionId: 'session-revoked', mfaVerified: false,
  });
  assert.equal((await run(`Bearer ${token}`)).nextCalled, true);
  const sauth = await import('@coremail/storage/auth');
  await sauth.markSessionsRevoked(['session-revoked'], 'alice');
  assert.equal((await run(`Bearer ${token}`)).status, 401);
});

test('Basic auth uses the shared credential check (no auth-service call)', async () => {
  const out = await run(basic('alice@example.com', 'pw'));
  assert.equal(out.nextCalled, true);
  assert.deepEqual(out.davUser, { userId: 'alice', email: 'alice@example.com' });
  assert.deepEqual(fetchCalls, []);
});

test('Basic auth accepts an app password (v7)', async () => {
  assert.equal((await run(basic('alice@example.com', 'APP-PW'))).nextCalled, true);
});

test('Basic auth: MFA account needs an app password', async () => {
  assert.equal((await run(basic('mfa@example.com', 'pw'))).status, 401);
  assert.equal((await run(basic('mfa@example.com', 'APP-PW'))).nextCalled, true);
});

test('Basic auth rejects a deactivated user', async () => {
  assert.equal((await run(basic('gone@example.com', 'pw'))).status, 401);
});

test('Basic auth with wrong credentials is answered with 401', async () => {
  assert.equal((await run(basic('alice@example.com', 'wrong'))).status, 401);
});

test('Basic auth: a database error is answered with 503, not 401', async () => {
  state.dbDown = true;
  try {
    assert.equal((await run(basic('alice@example.com', 'pw'))).status, 503);
  } finally {
    state.dbDown = false;
  }
});

test('9.4: CalDAV/CardDAV switched off → 403 for Basic and Bearer, a wrong password stays 401', async () => {
  policies.push({ id: 'p-alice', userId: 'alice', domainId: null, dav: 'OFF' });
  storage.invalidateProtocolAccessCache();
  try {
    assert.equal((await run(basic('alice@example.com', 'pw'))).status, 403);
    assert.equal((await run(basic('alice@example.com', 'APP-PW'))).status, 403);
    assert.equal((await run(basic('alice@example.com', 'wrong'))).status, 401);
    const bearer = await run(`Bearer ${accessFor('alice')}`);
    assert.equal(bearer.status, 403);
    assert.equal(bearer.nextCalled, false);
  } finally {
    policies.length = 0;
    storage.invalidateProtocolAccessCache();
  }
  assert.equal((await run(basic('alice@example.com', 'pw'))).nextCalled, true);
});

test('9.4 webmail policy: calendar / contacts modules gate their DAV collections', async () => {
  assert.equal(davFeatureOf('/calendars/u1/c1/'), 'calendar');
  assert.equal(davFeatureOf('/addressbooks/u1/default'), 'contacts');
  assert.equal(davFeatureOf('/principals/u1/'), null);
  assert.equal(davFeatureOf('/calendarsx'), null);
  const gate = async (path: string) => {
    const outcome = { status: null as number | null, next: false };
    const res = {
      set: () => res, type: () => res, send: () => res,
      status: (code: number) => { outcome.status = code; return res; },
    } as unknown as Parameters<typeof davFeatureGate>[1];
    const req = { path, davUser: { userId: 'alice', email: 'alice@example.com' } } as unknown as Parameters<typeof davFeatureGate>[0];
    await davFeatureGate(req, res, () => { outcome.next = true; });
    return outcome;
  };
  assert.deepEqual(await gate('/calendars/alice/'), { status: null, next: true });
  const model = prisma['webmailPolicy'] as { findMany: () => Promise<unknown> };
  const original = model.findMany;
  model.findMany = async () => [{ id: 'global', domainId: null, userId: null, calendar: 'OFF' }];
  storage.invalidateWebmailPolicyCache();
  try {
    assert.deepEqual(await gate('/calendars/alice/'), { status: 403, next: false });
    assert.deepEqual(await gate('/addressbooks/alice/default'), { status: null, next: true });
    assert.deepEqual(await gate('/principals/alice/'), { status: null, next: true });
    model.findMany = async () => { throw new Error('db down'); };
    storage.invalidateWebmailPolicyCache();
    assert.equal((await gate('/addressbooks/alice/default')).status, 503);
  } finally {
    model.findMany = original;
    storage.invalidateWebmailPolicyCache();
  }
});

test('9.4: an unreadable CalDAV/CardDAV switch answers a Bearer request with 503, not 401', async () => {
  const policy = prisma['protocolPolicy'] as { findMany: () => Promise<unknown> };
  const findMany = policy.findMany;
  policy.findMany = async () => { throw new Error('db down'); };
  storage.invalidateProtocolAccessCache();
  try {
    const r = await run(`Bearer ${accessFor('alice')}`);
    assert.equal(r.status, 503);
    assert.equal(r.nextCalled, false);
  } finally {
    policy.findMany = findMany;
    storage.invalidateProtocolAccessCache();
  }
});
