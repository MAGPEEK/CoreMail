/**
 * Auth invalidation bus + CredentialCache (v7.1.0). Infra-free: a fake Redis
 * pub/sub broker connects a "publisher process" and a "subscriber process".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const inv = await import('./invalidation.js');
const {
  CredentialCache, CHANNEL_AUTH_INVALIDATE, publishAuthInvalidation, onAuthInvalidation,
  startAuthInvalidationSubscriber, parseAuthInvalidationEvent,
} = inv;

/** Minimal in-memory Redis pub/sub broker. */
function createFakeBroker() {
  type Listener = (channel: string, message: string) => void;
  const subs: { channels: Set<string>; listeners: Set<Listener> }[] = [];
  const published: { channel: string; message: string }[] = [];
  return {
    published,
    publisher: {
      async publish(channel: string, message: string) {
        published.push({ channel, message });
        let n = 0;
        for (const s of subs) if (s.channels.has(channel)) { n++; for (const l of s.listeners) l(channel, message); }
        return n;
      },
    },
    subscriber() {
      const s = { channels: new Set<string>(), listeners: new Set<Listener>() };
      subs.push(s);
      return {
        async subscribe(ch: string) { s.channels.add(ch); return 1; },
        async unsubscribe(ch: string) { s.channels.delete(ch); return 0; },
        on(_e: 'message', l: Listener) { s.listeners.add(l); return this; },
        removeListener(_e: 'message', l: Listener) { s.listeners.delete(l); return this; },
      };
    },
  };
}

test('CredentialCache: hit, per-user invalidation, other users untouched', () => {
  const c = new CredentialCache<{ id: string }>();
  c.set('a@x.test', 'pw-a', 'ua', { id: 'ua' });
  c.set('a@x.test', 'app-a', 'ua', { id: 'ua' });
  c.set('b@x.test', 'pw-b', 'ub', { id: 'ub' });
  assert.equal(c.get('A@X.test ', 'pw-a')?.id, 'ua', 'login is normalised');
  assert.equal(c.get('a@x.test', 'wrong'), undefined, 'different secret → miss');
  assert.equal(c.invalidateUser('ua'), 2);
  assert.equal(c.get('a@x.test', 'pw-a'), undefined);
  assert.equal(c.get('a@x.test', 'app-a'), undefined);
  assert.equal(c.get('b@x.test', 'pw-b')?.id, 'ub');
});

test('CredentialCache: TTL fallback expires entries without any event', () => {
  let now = 1_000_000;
  const c = new CredentialCache<string>({ ttlMs: 60_000, now: () => now });
  c.set('a@x.test', 'pw', 'ua', 'ua');
  now += 59_999;
  assert.equal(c.get('a@x.test', 'pw'), 'ua');
  now += 1;
  assert.equal(c.get('a@x.test', 'pw'), undefined);
  assert.equal(c.size, 0);
});

test('CredentialCache: a lookup started before an invalidation is not cached', () => {
  let now = 5_000;
  const c = new CredentialCache<string>({ now: () => now });
  const startedAt = now;
  now += 10;
  c.invalidateUser('ua'); // e.g. MFA enabled while bcrypt was running
  now += 10;
  c.set('a@x.test', 'pw', 'ua', 'ua', startedAt);
  assert.equal(c.get('a@x.test', 'pw'), undefined);
  c.set('a@x.test', 'pw', 'ua', 'ua', now); // a fresh lookup may cache again
  assert.equal(c.get('a@x.test', 'pw'), 'ua');
});

test('CredentialCache: keys never contain the plaintext secret or an unkeyed hash', async () => {
  const { createHash } = await import('node:crypto');
  const c = new CredentialCache<string>();
  const secret = 'Sup3r-Secret-Passw0rd';
  c.set('a@x.test', secret, 'ua', 'ua');
  const [key] = c.keys();
  assert.ok(key && /^[0-9a-f]{64}$/.test(key), 'HMAC-SHA256 hex');
  assert.ok(!key.includes(secret) && !key.includes('a@x.test'));
  assert.notEqual(key, createHash('sha256').update(`a@x.test\u0000${secret}`).digest('hex'), 'keyed, not plain sha256');
  assert.notEqual(new CredentialCache<string>().key('a@x.test', secret), key, 'per-process random key');
});

test('CredentialCache: size bound evicts the oldest entries', () => {
  const c = new CredentialCache<string>({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) c.set(`u${i}@x.test`, 'pw', `u${i}`, `u${i}`);
  assert.equal(c.size, 3);
  assert.equal(c.get('u0@x.test', 'pw'), undefined);
  assert.equal(c.get('u4@x.test', 'pw'), 'u4');
});

test('publish → remote subscriber drops the cached login immediately', async () => {
  const broker = createFakeBroker();
  // "jmap-server": cache + subscriber
  const cache = new CredentialCache<string>();
  const detach = cache.attachInvalidation();
  const stop = startAuthInvalidationSubscriber({ subscriber: broker.subscriber() });
  try {
    cache.set('a@x.test', 'pw', 'ua', 'ua');
    cache.set('b@x.test', 'pw', 'ub', 'ub');
    // publish = local dispatch + Redis message on the shared channel
    await publishAuthInvalidation({ userId: 'ua', reason: 'mfa-change' }, { redis: broker.publisher });
    assert.equal(broker.published.length, 1);
    assert.equal(broker.published[0]!.channel, CHANNEL_AUTH_INVALIDATE);
    assert.equal(cache.get('a@x.test', 'pw'), undefined);
    assert.equal(cache.get('b@x.test', 'pw'), 'ub');
  } finally {
    stop();
    detach();
  }
});

test('remote-only delivery: a message from another process invalidates', async () => {
  const broker = createFakeBroker();
  const cache = new CredentialCache<string>();
  const detach = cache.attachInvalidation();
  const stop = startAuthInvalidationSubscriber({ subscriber: broker.subscriber() });
  try {
    cache.set('a@x.test', 'pw', 'ua', 'ua');
    await broker.publisher.publish(CHANNEL_AUTH_INVALIDATE, JSON.stringify({ userId: 'ua', reason: 'app-password-revoked' }));
    assert.equal(cache.get('a@x.test', 'pw'), undefined);
    // unrelated channel / malformed payloads are ignored
    cache.set('a@x.test', 'pw', 'ua', 'ua', Date.now() + 1);
    await broker.publisher.publish('other', JSON.stringify({ userId: 'ua' }));
    await broker.publisher.publish(CHANNEL_AUTH_INVALIDATE, 'not json');
    await broker.publisher.publish(CHANNEL_AUTH_INVALIDATE, JSON.stringify({ reason: 'x' }));
    assert.equal(cache.get('a@x.test', 'pw'), 'ua');
  } finally {
    stop();
    detach();
  }
});

test('publish never throws when Redis fails; local handlers still run', async () => {
  const seen: string[] = [];
  const off = onAuthInvalidation((e) => seen.push(`${e.userId}:${e.reason}`));
  try {
    await publishAuthInvalidation({ userId: 'u9', reason: 'deleted' }, {
      redis: { publish: async () => { throw new Error('redis down'); } },
    });
    await publishAuthInvalidation({ userId: 'u9', reason: 'role-change' }, { redis: {} });
    await publishAuthInvalidation({ userId: 'u9', reason: 'deactivated' }, { redis: null });
    assert.deepEqual(seen, ['u9:deleted', 'u9:role-change', 'u9:deactivated']);
  } finally {
    off();
  }
});

test('parseAuthInvalidationEvent keeps session ids and revocation marks', () => {
  const e = parseAuthInvalidationEvent(JSON.stringify({
    userId: 'u1', reason: 'sessions-revoked', sessionIds: ['s1', 3, ''], revokeBefore: { before: 10, except: 's2', expires: 99 },
  }));
  assert.deepEqual(e, { userId: 'u1', reason: 'sessions-revoked', sessionIds: ['s1'], revokeBefore: { before: 10, except: 's2', expires: 99 } });
  assert.equal(parseAuthInvalidationEvent('[]'), null);
});
