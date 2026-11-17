/**
 * Validation + stage dispatch of POST /check/connection.
 * Run: node --import tsx --test src/connection-request.test.ts  (in packages/security-filter)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionRequest, runConnectionStage, type ConnectionStageDeps } from './connection-request.js';

test('connect stage with only senderIp is valid (was 400 before)', () => {
  assert.deepEqual(parseConnectionRequest({ stage: 'connect', senderIp: '203.0.113.7' }),
    { ok: true, stage: 'connect', ctx: { senderIp: '203.0.113.7', mailFrom: '', rcptTo: '' } });
  // legacy smtp-server payload with empty strings → connect stage
  assert.deepEqual(parseConnectionRequest({ senderIp: '203.0.113.7', mailFrom: '', rcptTo: '' }),
    { ok: true, stage: 'connect', ctx: { senderIp: '203.0.113.7', mailFrom: '', rcptTo: '' } });
});

test('IPv6 and IPv4-mapped addresses are accepted', () => {
  assert.equal(parseConnectionRequest({ senderIp: '2001:db8::1' }).ok, true);
  assert.equal(parseConnectionRequest({ senderIp: '::ffff:192.0.2.1' }).ok, true);
});

test('missing or invalid senderIp is rejected', () => {
  assert.equal(parseConnectionRequest({}).ok, false);
  assert.equal(parseConnectionRequest({ senderIp: '' }).ok, false);
  assert.equal(parseConnectionRequest({ senderIp: 'not-an-ip' }).ok, false);
  assert.equal(parseConnectionRequest({ senderIp: 42 }).ok, false);
  assert.equal(parseConnectionRequest(null).ok, false);
  assert.equal(parseConnectionRequest([]).ok, false);
});

test('rcpt stage needs rcptTo; empty mailFrom (null sender) is allowed', () => {
  assert.equal(parseConnectionRequest({ stage: 'rcpt', senderIp: '192.0.2.1', mailFrom: 'a@b.c' }).ok, false);
  assert.deepEqual(parseConnectionRequest({ stage: 'rcpt', senderIp: '192.0.2.1', mailFrom: '', rcptTo: 'bob@firma.de' }),
    { ok: true, stage: 'rcpt', ctx: { senderIp: '192.0.2.1', mailFrom: '', rcptTo: 'bob@firma.de' } });
});

test('legacy request with all fields → full stage', () => {
  const r = parseConnectionRequest({ senderIp: '192.0.2.1', mailFrom: 'a@b.c', rcptTo: 'bob@firma.de' });
  assert.equal(r.ok && r.stage, 'full');
});

test('unknown stage and non-string fields are rejected', () => {
  assert.equal(parseConnectionRequest({ stage: 'data', senderIp: '192.0.2.1' }).ok, false);
  assert.equal(parseConnectionRequest({ senderIp: '192.0.2.1', rcptTo: 5 }).ok, false);
  assert.equal(parseConnectionRequest({ senderIp: '192.0.2.1', mailFrom: {} }).ok, false);
});

function deps(ip: 'accept' | 'reject', grey: 'accept' | 'defer', lists: 'accept' | 'reject' = 'accept'): ConnectionStageDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ipChecks: async () => { calls.push('ip'); return { action: ip, reason: ip }; },
    greylist: async () => { calls.push('grey'); return { action: grey, reason: grey }; },
    senderList: async () => { calls.push('lists'); return { action: lists, reason: lists }; },
  };
}

const CTX = { senderIp: '192.0.2.1', mailFrom: 'a@b.c', rcptTo: 'bob@firma.de' };

test('connect stage runs only the IP checks (DNSBL/GeoIP)', async () => {
  const d = deps('reject', 'defer');
  const r = await runConnectionStage('connect', CTX, {}, d);
  assert.equal(r.action, 'reject');
  assert.deepEqual(d.calls, ['ip']);
});

test('rcpt stage: sender lists of the recipient, then greylisting', async () => {
  const d = deps('reject', 'defer');
  const r = await runConnectionStage('rcpt', CTX, {}, d);
  assert.equal(r.action, 'defer');
  assert.deepEqual(d.calls, ['lists', 'grey']);
});

test('9.4: rcpt stage — a sender-list block refuses the recipient before greylisting', async () => {
  const d = deps('accept', 'defer', 'reject');
  assert.equal((await runConnectionStage('rcpt', CTX, {}, d)).action, 'reject');
  assert.deepEqual(d.calls, ['lists']);
});

test('full stage: recipient checks first, IP checks only if they pass', async () => {
  const d1 = deps('reject', 'defer');
  assert.equal((await runConnectionStage('full', CTX, {}, d1)).action, 'defer');
  assert.deepEqual(d1.calls, ['lists', 'grey']);
  const d2 = deps('reject', 'accept');
  assert.equal((await runConnectionStage('full', CTX, {}, d2)).action, 'reject');
  assert.deepEqual(d2.calls, ['lists', 'grey', 'ip']);
});
