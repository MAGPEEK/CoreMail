/**
 * v8.1 review: an admin "Retry" of a dead letter restarts the retry window
 * (expiryBaseMs) and resets the attempt counter, keeping the delivery progress.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/queues-retry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma({});

const { adminRetryJob } = await import('./queues.js');
const { isExpiredInQueue } = await import('@coremail/storage');

test('adminRetryJob sets expiryBaseMs before retrying and resets the attempts', async () => {
  const calls: string[] = [];
  const now = 1_000_000_000_000;
  const job = {
    data: { messageId: 'm', from: 'a@corp.test', to: ['x@ext.test'], finalNdrRcpts: ['x@ext.test'], deliveredRcpts: ['y@ext.test'] } as Record<string, unknown>,
    async updateData(d: Record<string, unknown>) { calls.push('updateData'); job.data = d; },
    async retry(state?: string, opts?: Record<string, unknown>) { calls.push(`retry:${state}:${JSON.stringify(opts)}`); },
  };
  await adminRetryJob(job as never, now);
  assert.deepEqual(calls, ['updateData', 'retry:failed:{"resetAttemptsMade":true,"resetAttemptsStarted":true}']);
  assert.equal(job.data['expiryBaseMs'], now);
  assert.deepEqual(job.data['finalNdrRcpts'], ['x@ext.test']);
  assert.deepEqual(job.data['deliveredRcpts'], ['y@ext.test']);
  // a job enqueued 100 h ago is no longer expired after the retry
  assert.equal(isExpiredInQueue({ timestamp: now - 100 * 3_600_000, data: job.data }, null, now + 60_000), false);
});
