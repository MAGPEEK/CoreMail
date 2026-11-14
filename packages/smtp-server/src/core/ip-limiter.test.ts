/**
 * SMTP ip-limiter: CIDR-exact private ranges and pruning of the
 * new-connection sliding window.
 * Run: node --import tsx --test src/core/ip-limiter.test.ts (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { isPrivateIp, checkAndTrackConnection, releaseConnection, pruneConnTimestamps, trackedConnRateIps } =
  await import('./ip-limiter.js');

test('172.16.0.0/12 is private, public 172.x addresses are not (old startsWith("172.2") bug)', () => {
  assert.equal(isPrivateIp('172.20.1.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('::ffff:172.16.0.1'), true);
  assert.equal(isPrivateIp('172.2.3.4'), false);
  assert.equal(isPrivateIp('172.200.1.1'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
  assert.equal(isPrivateIp('203.0.113.5'), false);
});

test('public 172.200.x addresses are subject to the connection rate limit', () => {
  const ip = '172.200.9.9';
  const t0 = 10_000_000;
  let allowed = 0;
  for (let i = 0; i < 40; i++) {
    if (checkAndTrackConnection(ip, t0 + i)) { allowed++; releaseConnection(ip); }
  }
  assert.ok(allowed < 40, `all ${allowed} connections were allowed`);
});

test('the new-connection window is pruned for idle IPs', () => {
  const t0 = 50_000_000;
  for (let i = 0; i < 20; i++) {
    const ip = `198.51.100.${i}`;
    checkAndTrackConnection(ip, t0);
    releaseConnection(ip);
  }
  assert.ok(trackedConnRateIps() >= 20);
  pruneConnTimestamps(t0 + 61_000);
  assert.equal(trackedConnRateIps(), 0);
});
