/**
 * Maildrop lock (RFC 1939 §4): in-process layer + Redis layer with owner token.
 * Run: node --import tsx --test src/maildrop-lock.test.ts  (in packages/pop3-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

/** In-memory Redis with SET NX PX and the compare-and-delete / compare-and-pexpire scripts. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    down: false,
    async set(key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX'): Promise<'OK' | null> {
      if (this.down) throw new Error('ECONNREFUSED');
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(script: string, _n: number, key: string, token: string): Promise<number> {
      if (store.get(key) !== token) return 0;
      if (script.includes('"del"')) store.delete(key);
      return 1;
    },
  };
}

const redis = fakeRedis();
(globalThis as Record<string, unknown>)['__pop3LockRedis'] = redis;
const { acquireMaildropLock, maildropLockKey } = await import('./maildrop-lock.js');

test('the lock is exclusive per user, also across instances (Redis key held by another owner)', async () => {
  const a = await acquireMaildropLock('u1');
  assert.equal(a.status, 'ok');
  assert.equal((await acquireMaildropLock('u1')).status, 'busy', 'same process');
  assert.equal((await acquireMaildropLock('u2')).status, 'ok', 'other users are independent');
  if (a.status === 'ok') await a.release();
  assert.equal(redis.store.has(maildropLockKey('u1')), false);

  redis.store.set(maildropLockKey('u3'), 'other-instance-token');
  assert.equal((await acquireMaildropLock('u3')).status, 'busy', 'held on another instance');
  assert.equal(redis.store.get(maildropLockKey('u3')), 'other-instance-token', 'a busy attempt leaves the foreign lock alone');
});

test('release only deletes its own token and is idempotent', async () => {
  const a = await acquireMaildropLock('u4');
  assert.equal(a.status, 'ok');
  // The lock expired and another instance took it over.
  redis.store.set(maildropLockKey('u4'), 'new-owner');
  if (a.status === 'ok') { await a.release(); await a.release(); }
  assert.equal(redis.store.get(maildropLockKey('u4')), 'new-owner');
});

test('Redis unavailable: the lock is not granted (error), and the in-process slot is freed again', async () => {
  redis.down = true;
  try {
    assert.equal((await acquireMaildropLock('u5')).status, 'error');
  } finally {
    redis.down = false;
  }
  const b = await acquireMaildropLock('u5');
  assert.equal(b.status, 'ok');
  if (b.status === 'ok') await b.release();
});
