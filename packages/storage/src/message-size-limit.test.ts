/**
 * 9.4: one maximum-message-size helper for REST, JMAP and ActiveSync — the stricter of
 * the SMTP and the global setting, default 25 MB, 60 s cache.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

let smtpMb: number | null = 30;
let serverMb: number | null = 10;
let fail = false;
let reads = 0;
const read = (mb: () => number | null) => async () => {
  reads++;
  if (fail) throw new Error('db down');
  const v = mb();
  return v === null ? null : { maxMessageSizeMb: v };
};
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: read(() => smtpMb) },
  serverSettings: { findUnique: read(() => serverMb) },
};

const m = await import('./message-size-limit.js');
const MB = 1024 * 1024;

beforeEach(() => { smtpMb = 30; serverMb = 10; fail = false; reads = 0; m.clearMessageSizeLimitCache(); });

test('maxMessageBytesFrom: smallest positive value, default 25 MB', () => {
  assert.equal(m.maxMessageBytesFrom([30, 10]), 10 * MB);
  assert.equal(m.maxMessageBytesFrom([null, undefined, 0, -3]), 25 * MB);
  assert.equal(m.maxMessageBytesFrom([]), 25 * MB);
  assert.equal(m.maxMessageBytesFrom([7]), 7 * MB);
});

test('checkMessageSize: at the limit passes, one byte more fails', () => {
  assert.deepEqual(m.checkMessageSize(100, 100), { ok: true });
  assert.deepEqual(m.checkMessageSize(101, 100), { ok: false, size: 101, limit: 100 });
});

test('maxOutgoingMessageBytes: stricter of SMTP and server setting, cached for 60 s', async () => {
  assert.equal(await m.maxOutgoingMessageBytes(1_000), 10 * MB);
  serverMb = 50;
  assert.equal(await m.maxOutgoingMessageBytes(30_000), 10 * MB, 'cached');
  assert.equal(await m.maxOutgoingMessageBytes(62_000), 30 * MB, 'reloaded after the TTL');
  assert.equal(reads, 4);
});

test('missing rows and a database error fall back to 25 MB', async () => {
  smtpMb = null; serverMb = null;
  assert.equal(await m.maxOutgoingMessageBytes(), 25 * MB);
  m.clearMessageSizeLimitCache();
  fail = true;
  assert.equal(await m.maxOutgoingMessageBytes(), 25 * MB);
});

test('checkOutgoingMessageSize uses the configured limit', async () => {
  assert.equal((await m.checkOutgoingMessageSize(10 * MB)).ok, true);
  assert.deepEqual(await m.checkOutgoingMessageSize(10 * MB + 1), { ok: false, size: 10 * MB + 1, limit: 10 * MB });
});
