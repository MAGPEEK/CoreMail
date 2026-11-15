/**
 * Credential/session invalidation events (v7.1.0): every storage-level event
 * site publishes CHANNEL_AUTH_INVALIDATE, and events published by another
 * process are applied to this process's access-token revocation state.
 * Infra-free: fake Prisma + fake Redis with an in-memory pub/sub broker.
 * Run: node --import tsx --test src/auth/invalidation.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, FakeRedis } = await import('./testing.js');

/** FakeRedis + publish (records messages, delivers to fake subscribers). */
class PubSubRedis extends FakeRedis {
  published: { channel: string; message: string }[] = [];
  listeners = new Set<(channel: string, message: string) => void>();
  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    for (const l of this.listeners) l(channel, message);
    return this.listeners.size;
  }
}

const db = createFakePrisma();
const redis = new PubSubRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const auth = await import('./index.js');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const events: { userId: string; reason: string }[] = [];
core.onAuthInvalidation((e) => events.push({ userId: e.userId, reason: e.reason }));

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
  redis.published = [];
  events.length = 0;
});

function publishedFor(userId: string): { userId: string; reason: string; sessionIds?: string[] }[] {
  return redis.published
    .filter((p) => p.channel === core.CHANNEL_AUTH_INVALIDATE)
    .map((p) => JSON.parse(p.message) as { userId: string; reason: string; sessionIds?: string[] })
    .filter((e) => e.userId === userId);
}

test('revokeAllSessions (password change / admin reset / deactivation) publishes with session ids + mark', async () => {
  const u = await db.user.create({ data: { email: 'a@example.com' } });
  const uid = u['id'] as string;
  await db.session.create({ data: { id: 's1', userId: uid, tokenHash: 'x1', expiresAt: new Date(Date.now() + 1e6) } });
  await db.session.create({ data: { id: 's2', userId: uid, tokenHash: 'x2', expiresAt: new Date(Date.now() + 1e6) } });
  for (const reason of ['password-change', 'admin-password-reset', 'deactivated', 'deleted']) {
    redis.published = [];
    await auth.revokeAllSessions(uid, { reason, ...(reason === 'password-change' ? { exceptSessionId: 's1' } : {}) });
    const [e] = publishedFor(uid);
    assert.equal(e?.reason, reason);
    assert.ok((e as { revokeBefore?: unknown }).revokeBefore, 'carries the access-token mark');
  }
});

test('password reset by mail publishes (sessions + app passwords revoked)', async () => {
  const u = await db.user.create({ data: { email: 'a@example.com' } });
  const raw = await auth.createPasswordResetToken(u['id'] as string, 'ip');
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip')).ok, true);
  assert.equal(publishedFor(u['id'] as string)[0]?.reason, 'password-reset-by-mail');
});

test('enabling TOTP (confirm) publishes mfa-change; verifying an enabled TOTP does not', async () => {
  const u = await db.user.create({ data: { email: 'a@example.com' } });
  const uid = u['id'] as string;
  await db.userMfa.create({ data: { userId: uid, totpSecret: auth.encryptMfaSecret(SECRET), totpEnabled: false } });
  const now = Date.now();
  assert.equal(await auth.verifyUserTotp(uid, auth.totpCode(SECRET, now), { requireEnabled: false, nowMs: now }), true);
  assert.deepEqual(publishedFor(uid).map((e) => e.reason), ['mfa-change']);
  redis.published = [];
  const later = now + 30_000;
  assert.equal(await auth.verifyUserTotp(uid, auth.totpCode(SECRET, later), { nowMs: later }), true);
  assert.equal(publishedFor(uid).length, 0, 'a normal second-factor login is not a credential change');
});

test('regenerating backup codes publishes mfa-change', async () => {
  await auth.regenerateBackupCodes('u-bc');
  assert.equal(publishedFor('u-bc')[0]?.reason, 'mfa-change');
});

test('markSessionsRevoked (single session / logout / token reuse) publishes the session ids', async () => {
  await auth.markSessionsRevoked(['sx'], 'u-s');
  assert.deepEqual(publishedFor('u-s')[0]?.sessionIds, ['sx']);
  await auth.markSessionsRevoked(['sy']); // owner unknown → markers only
  assert.equal(redis.published.length, 1);
});

test('publish failures never break the event site', async () => {
  const orig = redis.publish.bind(redis);
  redis.publish = async () => { throw new Error('redis down'); };
  try {
    await auth.publishUserAuthChange('u-x', 'role-change');
    assert.deepEqual(events.at(-1), { userId: 'u-x', reason: 'role-change' }, 'local handlers still run');
  } finally {
    redis.publish = orig;
  }
});

test('remote event (other process) applies session + user revocation marks in-process', async () => {
  const stop = core.startAuthInvalidationSubscriber({
    subscriber: {
      subscribe: async () => 1,
      on: (_e: 'message', l: (c: string, m: string) => void) => { redis.listeners.add(l); },
      removeListener: (_e: 'message', l: (c: string, m: string) => void) => { redis.listeners.delete(l); },
    },
  });
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    assert.equal(auth.isAccessTokenRevoked('u-r', nowSec - 5, 'remote-s1'), false);
    // As published by the auth-service (DELETE /sessions/:id) — delivered only via Redis.
    await redis.publish(core.CHANNEL_AUTH_INVALIDATE, JSON.stringify({ userId: 'u-r', reason: 'sessions-revoked', sessionIds: ['remote-s1'] }));
    assert.equal(auth.isAccessTokenRevoked('u-r', nowSec - 5, 'remote-s1'), true);
    assert.equal(auth.isAccessTokenRevoked('u-r', nowSec - 5, 'remote-s2'), false);
    // As published by revokeAllSessions in another process (except = current session).
    await redis.publish(core.CHANNEL_AUTH_INVALIDATE, JSON.stringify({
      userId: 'u-r', reason: 'password-change',
      revokeBefore: { before: nowSec, except: 'keep', expires: Date.now() + 60_000 },
    }));
    assert.equal(auth.isAccessTokenRevoked('u-r', nowSec - 5, 'remote-s2'), true);
    assert.equal(auth.isAccessTokenRevoked('u-r', nowSec - 5, 'keep'), false);
  } finally {
    stop();
  }
});
