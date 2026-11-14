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
  assert.deepEqual(outboundJobOptions('eas-1', null),
    { jobId: 'eas-1', attempts: 10, backoff: { type: 'exponential', delay: 60_000 } });
  assert.deepEqual(outboundJobOptions('eas-2', { maxRetryAttempts: 3, retryBackoffDelaySec: 30 }),
    { jobId: 'eas-2', attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
});
