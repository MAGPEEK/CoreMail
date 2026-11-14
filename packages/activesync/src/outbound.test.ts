/**
 * EAS outbound queue contract: queue name and retry options.
 * Run: node --import tsx --test src/outbound.test.ts  (in packages/activesync)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { OUTBOUND_QUEUE_NAME, outboundJobOptions } = await import('./outbound.js');

test('uses the BullMQ queue consumed by the smtp-server worker (hyphen, not colon)', () => {
  assert.equal(OUTBOUND_QUEUE_NAME, 'smtp-outbound');
  assert.doesNotMatch(OUTBOUND_QUEUE_NAME, /:/);
});

test('retry options: defaults 10 × 60 s exponential, overridable by QueueSettings', () => {
  const d = outboundJobOptions('eas-1', null);
  assert.equal(d.jobId, 'eas-1');
  assert.equal(d.attempts, 10);
  assert.deepEqual(d.backoff, { type: 'exponential', delay: 60_000 });
  const o = outboundJobOptions('eas-2', { maxRetryAttempts: 3, retryBackoffDelaySec: 30, completedRetentionHours: 2 });
  assert.equal(o.attempts, 3);
  assert.deepEqual(o.backoff, { type: 'exponential', delay: 30_000 });
  assert.deepEqual(o.removeOnComplete, { age: 7200, count: 100 });
});
