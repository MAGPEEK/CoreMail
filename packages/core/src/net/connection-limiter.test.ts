import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionLimiter, envLimit } from './connection-limiter.js';

test('per-IP limit rejects the connection above the cap and frees the slot on release', () => {
  const limiter = new ConnectionLimiter({ maxPerIp: 2, maxTotal: 10 });
  const a = limiter.acquire('203.0.113.1');
  const b = limiter.acquire('::ffff:203.0.113.1');
  assert.ok(a.ok && b.ok);
  const c = limiter.acquire('203.0.113.1');
  assert.deepEqual(c, { ok: false, reason: 'per_ip', current: 2, limit: 2 });
  assert.ok(limiter.acquire('203.0.113.2').ok, 'other IPs are unaffected');
  if (a.ok) { a.release(); a.release(); } // idempotent
  assert.equal(limiter.count('203.0.113.1'), 1);
  assert.ok(limiter.acquire('203.0.113.1').ok);
});

test('the global cap applies to every client, exempt ones included', () => {
  const limiter = new ConnectionLimiter({ maxPerIp: 1, maxTotal: 3, isExempt: (ip) => ip === '127.0.0.1' });
  assert.ok(limiter.acquire('127.0.0.1').ok);
  assert.ok(limiter.acquire('127.0.0.1').ok, 'exempt IPs skip the per-IP cap');
  assert.ok(limiter.acquire('198.51.100.1').ok);
  const r = limiter.acquire('198.51.100.2');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'total');
  assert.equal(limiter.count(), 3);
});

test('a limit <= 0 disables the check', () => {
  const limiter = new ConnectionLimiter({ maxPerIp: 0, maxTotal: 0 });
  for (let i = 0; i < 50; i++) assert.ok(limiter.acquire('192.0.2.1').ok);
});

test('envLimit parses integers and falls back on garbage', () => {
  assert.equal(envLimit('X', 20, { X: '5' }), 5);
  assert.equal(envLimit('X', 20, { X: '0' }), 0);
  assert.equal(envLimit('X', 20, { X: 'abc' }), 20);
  assert.equal(envLimit('X', 20, {}), 20);
});
