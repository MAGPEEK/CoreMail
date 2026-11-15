import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerComposeFlush, flushOpenComposes, logoutWithDraftFlush } from './compose-flush.ts';

afterEach(() => { mock.timers.reset(); });

test('logout: open compose drafts are flushed BEFORE the session ends, then the cache is cleared', async () => {
  const order: string[] = [];
  const off = registerComposeFlush(async () => { await Promise.resolve(); order.push('flush'); });
  await logoutWithDraftFlush({
    logout: async () => { order.push('logout'); },
    clearCache: () => { order.push('clear'); },
  });
  off();
  assert.deepEqual(order, ['flush', 'logout', 'clear']);
});

test('a hanging or failing flush delays the logout by at most the cap', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const offHang = registerComposeFlush(() => new Promise(() => undefined));
  const offFail = registerComposeFlush(async () => { throw new Error('offline'); });
  let done = false;
  const p = flushOpenComposes(3000).then(() => { done = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(done, false);
  mock.timers.tick(3000);
  await p;
  assert.equal(done, true);
  offHang(); offFail();
});

test('the cache is cleared even when the logout request fails', async () => {
  let cleared = false;
  await assert.rejects(logoutWithDraftFlush({ logout: async () => { throw new Error('net'); }, clearCache: () => { cleared = true; } }));
  assert.equal(cleared, true);
});
