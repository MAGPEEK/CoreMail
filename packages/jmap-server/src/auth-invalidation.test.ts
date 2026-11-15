/**
 * JMAP Basic-auth cache invalidation (v7.0.1). A successful Basic login is
 * cached; after each credential-changing event the cached login must be
 * rejected on the very next request (not only after the 60 s TTL).
 * Infra-free: fake Prisma, fake Redis pub/sub broker (no Docker, no Redis).
 * Run: node --import tsx --import ./src/test-env.ts --test src/auth-invalidation.test.ts
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type User = {
  id: string; email: string; displayName: string; domainId: string; role: string; active: boolean;
  passwordHash: string | null; authSource: string; mailbox: null;
  mfa: { totpEnabled: boolean; webAuthnCredentials: unknown[] } | null;
};
const users: User[] = [];
const appPasswords: { id: string; userId: string; hash: string }[] = [];
const sessions: { id: string; userId: string }[] = [];
let lookups = 0;

const pick = (where: Record<string, unknown> | undefined) => (s: { id: string; userId: string }) =>
  (!where?.['userId'] || s.userId === where['userId'])
  && (!(where?.['NOT'] as { id?: string } | undefined)?.id || s.id !== (where!['NOT'] as { id: string }).id);

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: {
    findFirst: async ({ where }: { where: { email?: string; id?: string; active?: boolean } }) => {
      lookups++;
      return users.find((u) => (where.email ? u.email === where.email : u.id === where.id)
        && (where.active === undefined || u.active === where.active)) ?? null;
    },
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => appPasswords.filter((a) => a.userId === where.userId),
    update: async () => ({}),
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      const before = appPasswords.length;
      for (let i = appPasswords.length - 1; i >= 0; i--) if (appPasswords[i]!.userId === where.userId) appPasswords.splice(i, 1);
      return { count: before - appPasswords.length };
    },
  },
  session: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => sessions.filter(pick(where)).map((s) => ({ id: s.id })),
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = sessions.filter(pick(where));
      for (const h of hit) sessions.splice(sessions.indexOf(h), 1);
      return { count: hit.length };
    },
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
};

// Fake Redis: key/value for revocation markers + pub/sub broker.
type Listener = (channel: string, message: string) => void;
const listeners = new Set<Listener>();
const published: string[] = [];
const kv = new Map<string, string>();
const fakeRedis = {
  async get(k: string) { return kv.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
  async del(k: string) { return kv.delete(k) ? 1 : 0; },
  async incr() { return 1; },
  async expire() { return 1; },
  async publish(channel: string, message: string) {
    published.push(message);
    for (const l of listeners) l(channel, message);
    return listeners.size;
  },
};
(globalThis as Record<string, unknown>)['__authRedis'] = fakeRedis;

const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const sauth = await import('@coremail/storage/auth');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { authenticateBasic, basicCache } = await import('./auth.js');

// The jmap-server process subscribes like server.ts does (startAuthInvalidationSubscriber).
core.startAuthInvalidationSubscriber({
  subscriber: {
    subscribe: async () => 1,
    on: (_e: 'message', l: Listener) => { listeners.add(l); },
  },
});

/** Simulates another service (auth-service, api-gateway): the event only arrives via Redis. */
async function remotePublish(event: Record<string, unknown>) {
  await fakeRedis.publish(core.CHANNEL_AUTH_INVALIDATE, JSON.stringify(event));
}

const IP = '203.0.113.10';
let n = 0;
function addUser(extra: Partial<User> = {}): User {
  n++;
  const u: User = {
    id: `u${n}`, email: `user${n}@example.com`, displayName: `User ${n}`, domainId: 'd1', role: 'USER',
    active: true, passwordHash: 'hash:old-pw', authSource: 'LOCAL', mailbox: null, mfa: null, ...extra,
  };
  users.push(u);
  return u;
}

/** Logs in once (cache primed) and verifies the next login is served from the cache. */
async function primeCache(u: User, password: string): Promise<void> {
  assert.equal((await authenticateBasic(u.email, password, IP))?.userId, u.id, 'initial login');
  const before = lookups;
  assert.equal((await authenticateBasic(u.email, password, IP))?.userId, u.id, 'cached login');
  assert.equal(lookups, before, 'second login came from the cache (no DB lookup)');
}

beforeEach(() => { basicCache.clear(); });

test('password change: old password rejected right after the event (self-service, other session kept)', async () => {
  const u = addUser();
  sessions.push({ id: `${u.id}-web`, userId: u.id }, { id: `${u.id}-phone`, userId: u.id });
  await primeCache(u, 'old-pw');
  u.passwordHash = 'hash:new-pw';
  assert.equal((await authenticateBasic(u.email, 'old-pw', IP))?.userId, u.id, 'without the event the cache would still accept');
  await sauth.revokeAllSessions(u.id, { exceptSessionId: `${u.id}-web`, reason: 'password-change' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null);
  assert.equal((await authenticateBasic(u.email, 'new-pw', IP))?.userId, u.id);
});

test('admin password reset: old password rejected immediately', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  u.passwordHash = 'hash:admin-set';
  await sauth.revokeAllSessions(u.id, { reason: 'admin-password-reset' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null);
});

test('password reset by mail: old password and app passwords rejected immediately', async () => {
  const u = addUser();
  appPasswords.push({ id: `${u.id}-ap`, userId: u.id, hash: 'hash:APP-1' });
  await primeCache(u, 'old-pw');
  await primeCache(u, 'APP-1');
  u.passwordHash = 'hash:reset-pw';
  await sauth.revokeAllSessions(u.id, { appPasswords: true, reason: 'password-reset-by-mail' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null);
  assert.equal(await authenticateBasic(u.email, 'APP-1', IP), null);
});

test('MFA enabled (event from the auth-service): primary password → 401 on the next request', async () => {
  const u = addUser();
  appPasswords.push({ id: `${u.id}-ap`, userId: u.id, hash: 'hash:APP-2' });
  await primeCache(u, 'old-pw');
  u.mfa = { totpEnabled: true, webAuthnCredentials: [] };
  assert.equal((await authenticateBasic(u.email, 'old-pw', IP))?.userId, u.id, 'stale cache before the event');
  await remotePublish({ userId: u.id, reason: 'mfa-change' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null, 'MFA → primary password refused');
  assert.equal((await authenticateBasic(u.email, 'APP-2', IP))?.userId, u.id, 'app password still works');
});

test('MFA disabled / WebAuthn key or backup codes changed: entries dropped', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  await sauth.publishUserAuthChange(u.id, 'mfa-change');
  const before = lookups;
  assert.equal((await authenticateBasic(u.email, 'old-pw', IP))?.userId, u.id);
  assert.ok(lookups > before, 're-verified against the database');
});

test('app password revoked (event from the auth-service): rejected immediately', async () => {
  const u = addUser();
  appPasswords.push({ id: `${u.id}-ap`, userId: u.id, hash: 'hash:APP-3' });
  await primeCache(u, 'APP-3');
  appPasswords.splice(appPasswords.findIndex((a) => a.id === `${u.id}-ap`), 1);
  await remotePublish({ userId: u.id, reason: 'app-password-revoked' });
  assert.equal(await authenticateBasic(u.email, 'APP-3', IP), null);
});

test('app password created: cache of the user is refreshed', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  await remotePublish({ userId: u.id, reason: 'app-password-created' });
  assert.equal(basicCache.size, 0);
});

test('user deactivated: rejected immediately', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  u.active = false;
  await sauth.revokeAllSessions(u.id, { reason: 'deactivated' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null);
});

test('user deleted: rejected immediately', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  users.splice(users.indexOf(u), 1);
  await sauth.revokeAllSessions(u.id, { reason: 'deleted' });
  assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null);
});

test('role change: the next request sees the new role', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  u.role = 'ORGANIZATION_MANAGEMENT';
  await remotePublish({ userId: u.id, reason: 'role-change' });
  assert.equal((await authenticateBasic(u.email, 'old-pw', IP))?.role, 'ORGANIZATION_MANAGEMENT');
});

test('session revocation: cached logins of the user are dropped as well', async () => {
  const u = addUser();
  await primeCache(u, 'old-pw');
  await sauth.markSessionsRevoked([`${u.id}-s`], u.id);
  assert.equal(basicCache.size, 0);
});

test('only the affected user is invalidated', async () => {
  const a = addUser();
  const b = addUser();
  await primeCache(a, 'old-pw');
  await primeCache(b, 'old-pw');
  await remotePublish({ userId: a.id, reason: 'mfa-change' });
  const before = lookups;
  assert.equal((await authenticateBasic(b.email, 'old-pw', IP))?.userId, b.id);
  assert.equal(lookups, before, 'b is still served from the cache');
});

test('TTL fallback: without any event the entry expires after 60 s', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const u = addUser();
    await primeCache(u, 'old-pw');
    u.passwordHash = 'hash:changed-without-event'; // e.g. the event was lost (Redis outage)
    mock.timers.tick(59_000);
    assert.equal((await authenticateBasic(u.email, 'old-pw', IP))?.userId, u.id, 'still cached within the TTL');
    mock.timers.tick(1_001);
    assert.equal(await authenticateBasic(u.email, 'old-pw', IP), null, 're-verified after the TTL');
  } finally {
    mock.timers.reset();
  }
});

test('cache keys contain neither the password nor the login in plaintext', async () => {
  const u = addUser({ passwordHash: 'hash:Pl41n-Text-Secret' });
  await primeCache(u, 'Pl41n-Text-Secret');
  const keys = basicCache.keys();
  assert.equal(keys.length, 1);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.ok(!k.includes('Pl41n-Text-Secret') && !k.includes(u.email));
  }
  for (const m of published) assert.ok(!m.includes('Pl41n-Text-Secret'), 'events carry no secrets');
});

test('Bearer: access tokens of a revoked session are refused', async () => {
  const { authenticateBearer } = await import('./auth.js');
  const u = addUser();
  const token = core.signAccessToken({
    sub: u.id, email: u.email, role: 'USER', domainId: 'd1', sessionId: `${u.id}-bearer`, mfaVerified: false,
  });
  assert.equal((await authenticateBearer(token))?.userId, u.id);
  await remotePublish({ userId: u.id, reason: 'sessions-revoked', sessionIds: [`${u.id}-bearer`] });
  assert.equal(await authenticateBearer(token), null);
});
