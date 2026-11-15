/**
 * 8.0.0 review:
 *  - access-token revocation marks compare millisecond issue times (`iatMs` /
 *    `beforeMs`): a token minted earlier in the same second as a revoke-all no
 *    longer survives, a token minted after it (e.g. the login that follows an
 *    LDAP takeover) is not caught by it;
 *  - isAccessTokenRevokedShared() finds revocations that only exist in Redis
 *    (process restart, lost invalidation event) and caches the lookups briefly
 *    without hiding a revocation event.
 * Infra-free: fake Prisma + fake Redis.
 * Run: node --import tsx --test src/auth/revocation.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma, FakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = new FakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const auth = await import('./index.js');

beforeEach(() => {
  redis.store.clear();
  auth.resetRevocationLookupCache();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('issuedBeforeMark: exact with iatMs, fail-closed same second without, legacy marks unchanged', () => {
  const mark = { before: 1000, beforeMs: 1_000_500 };
  assert.equal(core.issuedBeforeMark(mark, 1000, 1_000_499), true);   // same second, earlier
  assert.equal(core.issuedBeforeMark(mark, 1000, 1_000_500), false);  // at the mark
  assert.equal(core.issuedBeforeMark(mark, 1000, 1_000_900), false);  // same second, later
  assert.equal(core.issuedBeforeMark(mark, 1000), true);              // pre-8.0 token, same second → revoked
  assert.equal(core.issuedBeforeMark(mark, 1001), false);
  assert.equal(core.issuedBeforeMark({ before: 1000 }, 1000, 1_000_100), false); // old publisher: iat < before
  assert.equal(core.issuedBeforeMark({ before: 1000 }, 999), true);
  assert.equal(core.issuedBeforeMark(mark, undefined), true);
});

test('revokeAllSessions: a token minted earlier in the same second is revoked, a later one is not', async () => {
  const userId = 'same-second';
  const iat = Math.floor(Date.now() / 1000);
  const earlierMs = Date.now();
  await sleep(2);
  await auth.revokeAllSessions(userId, { reason: 'role-change' });
  await sleep(2);
  const laterMs = Date.now();
  // Same `iat` second (as far as the whole-second claim can tell): only iatMs decides.
  assert.equal(auth.isAccessTokenRevoked(userId, iat, 's-old', earlierMs), true);
  assert.equal(auth.isAccessTokenRevoked(userId, Math.floor(laterMs / 1000), 's-new', laterMs), false);
  assert.equal(await auth.isAccessTokenRevokedShared(userId, iat, 's-old', earlierMs), true);
});

test('the revoke-all event carries beforeMs (other processes compare exactly)', async () => {
  const seen: Array<{ before: number; beforeMs?: number } | undefined> = [];
  const off = core.onAuthInvalidation((e) => { if (e.userId === 'evt') seen.push(e.revokeBefore); });
  await auth.revokeAllSessions('evt', { reason: 'deactivated' });
  off?.();
  assert.equal(typeof seen[0]?.beforeMs, 'number');
  assert.equal(seen[0]?.before, Math.floor(seen[0]!.beforeMs! / 1000));
});

test('Redis-only revocations (restart / lost event) are found by the shared check', async () => {
  const now = Date.now();
  // Written by another process; this process never saw an event.
  await redis.setex('auth:revoked-session:sess-r', 900, '1');
  await redis.setex('auth:revoked:user-r', 900, JSON.stringify({ before: Math.floor(now / 1000), beforeMs: now, except: null, expires: now + 900_000 }));
  assert.equal(auth.isAccessTokenRevoked('other', 1, 'sess-r', 1), false, 'in-process maps know nothing');
  assert.equal(await auth.isAccessTokenRevokedShared('other', 1, 'sess-r', 1), true);
  assert.equal(await auth.isAccessTokenRevokedShared('user-r', 1, 'sess-x', now - 10), true);
  assert.equal(await auth.isAccessTokenRevokedShared('user-r', 1, 'sess-x', now + 10), false);
});

test('lookup cache: a cached "not revoked" is overridden by a revocation event', async () => {
  assert.equal(await auth.isAccessTokenRevokedShared('cache-u', 1, 'cache-s', 1), false); // cached
  await redis.setex('auth:revoked-session:cache-s', 900, '1');
  // A marker written without an event is visible after the cache TTL at the latest …
  assert.equal(await auth.isAccessTokenRevokedShared('cache-u', 1, 'cache-s', 1, { cache: false }), true);
  // … and immediately once the event arrives.
  await auth.markSessionsRevoked(['cache-s'], 'cache-u');
  assert.equal(await auth.isAccessTokenRevokedShared('cache-u', 1, 'cache-s', 1), true);
});

test('Redis errors fail open (in-process result applies)', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g['__authRedis'];
  g['__authRedis'] = { get: async () => { throw new Error('down'); } };
  try {
    assert.equal(await auth.isAccessTokenRevokedShared('down-u', 1, 'down-s', 1, { cache: false }), false);
  } finally {
    g['__authRedis'] = saved;
  }
});
