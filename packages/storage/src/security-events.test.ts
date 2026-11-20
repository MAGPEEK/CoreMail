/**
 * 10.5 security event recorder: sampling per IP and minute, global cap,
 * important events, cross-process budget, loopback skipped, sink errors.
 * Run: node --import tsx --test src/security-events.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { createSecurityEventRecorder } = await import('./security-events.js');
type Row = Parameters<Parameters<typeof createSecurityEventRecorder>[0]['sink']['write']>[0];

function setup(opts: { perIp?: number; global?: number; shared?: Map<string, number> | null } = {}) {
  let now = 1_700_000_000_000;
  const rows: Row[] = [];
  const shared = opts.shared ?? null;
  const rec = createSecurityEventRecorder({
    perIpPerMinute: opts.perIp ?? 3,
    globalPerMinute: opts.global ?? 100,
    now: () => now,
    sink: { write: async (r) => { rows.push(r); } },
    shared: () => (shared ? async (key) => { const n = (shared.get(key) ?? 0) + 1; shared.set(key, n); return n; } : null),
  });
  return { rec, rows, tick: (ms: number) => { now += ms; } };
}

test('at most N events per IP and minute; the next minute starts again', async () => {
  const { rec, rows, tick } = setup({ perIp: 3 });
  for (let i = 0; i < 10; i++) await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.1', protocol: 'imap' });
  for (let i = 0; i < 2; i++) await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.2', protocol: 'pop3' });
  assert.equal(rows.filter((r) => r.ip === '198.51.100.1').length, 3);
  assert.equal(rows.filter((r) => r.ip === '198.51.100.2').length, 2);
  assert.deepEqual(rec.stats(), { written: 5, dropped: 7 });
  tick(60_000);
  await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.1', protocol: 'imap' });
  assert.equal(rows.filter((r) => r.ip === '198.51.100.1').length, 4);
});

test('important events (locks) skip the per-IP budget and the global cap (10.5 review)', async () => {
  const { rec, rows } = setup({ perIp: 1, global: 4 });
  for (let i = 0; i < 3; i++) await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.1', protocol: 'smtp' });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.1', protocol: 'smtp', important: true });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.1', protocol: 'smtp', important: true });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.1', protocol: 'smtp', important: true });
  assert.deepEqual(rows.map((r) => r.type), ['AUTH_BRUTE_FORCE', 'AUTH_LOCKOUT', 'AUTH_LOCKOUT', 'AUTH_LOCKOUT']);
  // the global budget of 4 is used up: ordinary events are dropped, a lock is still written
  await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.8', protocol: 'smtp' });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.9', protocol: 'smtp', important: true });
  assert.deepEqual(rows.slice(4).map((r) => r.type), ['AUTH_LOCKOUT']);
});

test('important events are not lost in a flood of ordinary ones (security-events.ts:98 review finding)', async () => {
  const { rec, rows } = setup({ perIp: 10, global: 50 });
  for (let i = 0; i < 500; i++) await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: `203.0.${Math.floor(i / 200)}.${i % 200}`, protocol: 'web' });
  await rec.record({ type: 'IP_AUTO_BLOCKED', ip: '203.0.0.7', protocol: 'web', important: true });
  assert.equal(rows.filter((r) => r.type === 'AUTH_BRUTE_FORCE').length, 50);
  assert.equal(rows.filter((r) => r.type === 'IP_AUTO_BLOCKED').length, 1);
});

test('important events have their own (higher) ceiling per minute', async () => {
  const rows: Row[] = [];
  const rec = createSecurityEventRecorder({ perIpPerMinute: 1, globalPerMinute: 2, importantPerMinute: 3, now: () => 0, sink: { write: async (r) => { rows.push(r); } } });
  for (let i = 0; i < 5; i++) await rec.record({ type: 'AUTH_LOCKOUT', ip: `198.51.100.${i}`, protocol: 'imap', important: true });
  assert.equal(rows.length, 3);
});

test('a distributed attack is bounded by the global cap per minute', async () => {
  const { rec, rows } = setup({ perIp: 10, global: 50 });
  for (let i = 0; i < 300; i++) await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: `203.0.${Math.floor(i / 200)}.${i % 200}`, protocol: 'web' });
  assert.equal(rows.length, 50);
});

test('the cross-process budget (Redis) applies on top of the local one', async () => {
  const shared = new Map<string, number>();
  const a = setup({ perIp: 3, shared });
  const b = setup({ perIp: 3, shared });
  for (let i = 0; i < 3; i++) await a.rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.1', protocol: 'imap' });
  for (let i = 0; i < 3; i++) await b.rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '198.51.100.1', protocol: 'pop3' });
  assert.equal(a.rows.length + b.rows.length, 3, 'three per IP and minute across both processes');
});

test('rows carry protocol (also as service), capped target, detail; loopback is skipped', async () => {
  const { rec, rows } = setup();
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '::ffff:198.51.100.4', protocol: 'activesync', target: 'x'.repeat(400), detail: { scope: 'ip' } });
  await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '127.0.0.1', protocol: 'imap' });
  await rec.record({ type: 'AUTH_BRUTE_FORCE', ip: '::1', protocol: 'imap' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ip, '198.51.100.4');
  assert.equal(rows[0]!.protocol, 'activesync');
  assert.equal(rows[0]!.service, 'activesync');
  // 10.5 review: attacker text that is no mail address is masked, never stored
  assert.equal(rows[0]!.target, '(ungültige Eingabe, 400 Zeichen)');
  assert.deepEqual(rows[0]!.detail, { scope: 'ip' });
});

test('targets: a normalised mail address is kept, raw login text is masked (10.5 review)', async () => {
  const { rec, rows } = setup();
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.4', protocol: 'imap', target: 'alice@example.test', important: true });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.5', protocol: 'imap', target: 'Click https://evil.example/x', important: true });
  await rec.record({ type: 'AUTH_LOCKOUT', ip: '198.51.100.6', protocol: 'imap', target: '<b>x</b>@example.test', important: true });
  assert.deepEqual(rows.map((r) => r.target), [
    'alice@example.test', '(ungültige Eingabe, 28 Zeichen)', '(ungültige Eingabe, 21 Zeichen)',
  ]);
});

test('a failing sink never throws', async () => {
  const rec = createSecurityEventRecorder({ sink: { write: async () => { throw new Error('db down'); } } });
  assert.equal(await rec.record({ type: 'X', ip: '198.51.100.1', protocol: 'smtp' }), false);
});
