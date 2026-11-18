/**
 * Fixed-window limiter shared by the api-gateway and the MAPI server (9.4).
 * Run: node --import tsx --test src/net/rate-limit.test.ts
 */
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CounterStore } from './rate-limit.js';

const { createFixedWindowLimiter } = await import('./rate-limit.js');

function memoryStore(): CounterStore & { keys: Map<string, number>; expiries: string[] } {
  const keys = new Map<string, number>();
  const expiries: string[] = [];
  return {
    keys, expiries,
    incr: async (k) => { const n = (keys.get(k) ?? 0) + 1; keys.set(k, n); return n; },
    expire: async (k) => { expiries.push(k); return 1; },
  };
}

test('fixed window: counts per key, refuses above the limit, resets in the next window', async () => {
  let t = 1_000_000;
  const store = memoryStore();
  const rl = createFixedWindowLimiter({ scope: 'x', limit: 2, windowSec: 60, store: () => store, now: () => t });
  assert.equal((await rl.hit('a')).allowed, true);
  assert.equal((await rl.hit('a')).allowed, true);
  const third = await rl.hit('a');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSec >= 1 && third.retryAfterSec <= 60);
  assert.equal((await rl.hit('b')).allowed, true, 'keys are independent');
  assert.deepEqual(store.expiries.length, 2, 'EXPIRE once per key and window');
  assert.ok([...store.keys.keys()].every((k) => k.startsWith('ratelimit:x:')));
  t += 60_000;
  assert.equal((await rl.hit('a')).allowed, true, 'new window');
});

test('fixed window: a failing or hanging store falls back to the in-process counter', async () => {
  const broken: CounterStore = { incr: async () => { throw new Error('down'); }, expire: async () => 1 };
  const fb = createFixedWindowLimiter({ scope: 'f', limit: 1, windowSec: 60, store: () => broken });
  assert.equal((await fb.hit('u')).allowed, true);
  assert.equal((await fb.hit('u')).allowed, false, 'the fallback still limits');

  const hanging: CounterStore = { incr: () => new Promise<number>(() => undefined), expire: async () => 1 };
  const slow = createFixedWindowLimiter({ scope: 'h', limit: 5, windowSec: 60, store: () => hanging, timeoutMs: 10 });
  assert.equal((await slow.hit('u')).count, 1);
});

test('fixed window: limit 0 disables the limiter', async () => {
  const broken: CounterStore = { incr: async () => { throw new Error('down'); }, expire: async () => 1 };
  const off = createFixedWindowLimiter({ scope: 'o', limit: 0, windowSec: 60, store: () => broken });
  for (let i = 0; i < 5; i++) assert.equal((await off.hit('u')).allowed, true);
});
