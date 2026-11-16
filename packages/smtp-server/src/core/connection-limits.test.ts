/**
 * BCP → SMTP → Connection settings reach the SMTP listeners/sessions
 * (maxConnections, maxConnectionsPerIp, connectionTimeoutSec, greetingDelaySec,
 * maxAuthFailures were saved but never read before).
 * Run: node --import tsx --test src/core/connection-limits.test.ts (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { smtpConnectionLimits } = await import('./connection-limits.js');
const { checkAndTrackConnection, releaseConnection, acquireGlobalSlot, releaseGlobalSlot, openConnectionCount } =
  await import('./ip-limiter.js');

test('settings map to session/listener limits; a missing row gives the schema defaults', () => {
  assert.deepEqual(smtpConnectionLimits(null), {
    maxConnections: 100, maxConnectionsPerIp: 10, commandTimeoutMs: 300_000, greetingDelayMs: 0, maxAuthFailures: 5,
  });
  assert.deepEqual(smtpConnectionLimits({
    maxConnections: 50, maxConnectionsPerIp: 3, connectionTimeoutSec: 600, greetingDelaySec: 5, maxAuthFailures: 2,
  }), { maxConnections: 50, maxConnectionsPerIp: 3, commandTimeoutMs: 600_000, greetingDelayMs: 5_000, maxAuthFailures: 2 });
  // out-of-range values are clamped to the admin API ranges
  const c = smtpConnectionLimits({ maxConnections: 0, connectionTimeoutSec: 1, greetingDelaySec: 999 });
  assert.equal(c.maxConnections, 1);
  assert.equal(c.commandTimeoutMs, 30_000);
  assert.equal(c.greetingDelayMs, 30_000);
});

test('maxConnectionsPerIp from the settings overrides the env default', () => {
  const ip = '203.0.113.77';
  const t0 = 90_000_000;
  assert.equal(checkAndTrackConnection(ip, t0, 2), true);
  assert.equal(checkAndTrackConnection(ip, t0 + 1, 2), true);
  assert.equal(checkAndTrackConnection(ip, t0 + 2, 2), false, 'third concurrent connection refused');
  releaseConnection(ip);
  assert.equal(checkAndTrackConnection(ip, t0 + 3, 2), true, 'a released slot can be reused');
  releaseConnection(ip);
  releaseConnection(ip);
});

test('the global connection limit counts every open connection', () => {
  const base = openConnectionCount();
  const max = base + 2;
  assert.equal(acquireGlobalSlot(max), true);
  assert.equal(acquireGlobalSlot(max), true);
  assert.equal(acquireGlobalSlot(max), false);
  releaseGlobalSlot();
  assert.equal(acquireGlobalSlot(max), true);
  releaseGlobalSlot();
  releaseGlobalSlot();
  assert.equal(openConnectionCount(), base);
  // no limit configured → always allowed
  assert.equal(acquireGlobalSlot(undefined), true);
  releaseGlobalSlot();
});

// ── 9.2 review: caps apply to port 25 only; env wins over the DB value ──────

const { connectionCaps } = await import('./ip-limiter.js');

test('global + BCP per-IP caps apply to inbound (port 25) from public IPs only', () => {
  const settings = { maxConnections: 100, maxConnectionsPerIp: 3 };
  assert.deepEqual(connectionCaps({ submission: false, ip: '203.0.113.9', ...settings }), { global: 100, perIp: 3 });
  // submission (587/465): no global cap, pre-9.2 per-IP limit (SMTP_MAX_CONNS_PER_IP)
  assert.deepEqual(connectionCaps({ submission: true, ip: '203.0.113.9', ...settings }), { global: null, perIp: undefined });
  // loopback / private sources are neither capped nor counted globally
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.5', '::ffff:172.16.0.1']) {
    assert.equal(connectionCaps({ submission: false, ip, ...settings }).global, null, ip);
  }
  assert.equal(connectionCaps({ submission: false, ip: '203.0.113.9' }).global, null, 'no setting → no global cap');
});

test('a full port-25 global cap does not block submission clients', () => {
  const base = openConnectionCount();
  const max = base + 1;
  const mx = connectionCaps({ submission: false, ip: '198.51.100.1', maxConnections: max });
  assert.equal(acquireGlobalSlot(mx.global ?? undefined), true);
  assert.equal(acquireGlobalSlot(mx.global ?? undefined), false, 'second MX connection refused');
  // submission and private clients do not go through the global slot at all
  assert.equal(connectionCaps({ submission: true, ip: '198.51.100.2', maxConnections: max }).global, null);
  assert.equal(connectionCaps({ submission: false, ip: '10.0.0.7', maxConnections: max }).global, null);
  // submission per-IP falls back to the env limit (default 10), not the BCP value
  const ip = '198.51.100.3';
  const t0 = 95_000_000;
  for (let i = 0; i < 5; i++) assert.equal(checkAndTrackConnection(ip, t0 + i, connectionCaps({ submission: true, ip, maxConnectionsPerIp: 2 }).perIp), true);
  for (let i = 0; i < 5; i++) releaseConnection(ip);
  releaseGlobalSlot();
  assert.equal(openConnectionCount(), base);
});

test('an explicitly set SMTP_MAX_CONNS_PER_IP wins over the DB value', () => {
  assert.equal(smtpConnectionLimits({ maxConnectionsPerIp: 3 }, {}).maxConnectionsPerIp, 3, 'unset env → DB value');
  assert.equal(smtpConnectionLimits({ maxConnectionsPerIp: 3 }, { SMTP_MAX_CONNS_PER_IP: '25' }).maxConnectionsPerIp, 25);
  assert.equal(smtpConnectionLimits(null, { SMTP_MAX_CONNS_PER_IP: '7' }).maxConnectionsPerIp, 7);
  // empty / invalid env values are ignored
  for (const v of ['', ' ', 'abc', '0', '-4', '2.5']) {
    assert.equal(smtpConnectionLimits({ maxConnectionsPerIp: 3 }, { SMTP_MAX_CONNS_PER_IP: v }).maxConnectionsPerIp, 3, JSON.stringify(v));
  }
  // maxAuthFailures had no env var before 9.2 → the DB value applies
  assert.equal(smtpConnectionLimits({ maxAuthFailures: 4 }, { SMTP_MAX_CONNS_PER_IP: '25' }).maxAuthFailures, 4);
});
