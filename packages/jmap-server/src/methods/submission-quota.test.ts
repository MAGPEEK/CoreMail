/** v8.1: EmailSubmission/set refuses with SetError overQuota at the ProhibitSendQuota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MB = 1024 * 1024;
let used = 0;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'u1'
      ? { email: 'bob@ex.com', displayName: 'Bob', quotaBytes: BigInt(100 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null, mailbox: { id: 'mb1' } }
      : null),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  },
  serverSettings: { findUnique: async () => ({ quotaWarningPercent: 80, quotaProhibitSendPercent: 90 }) },
  message: { aggregate: async () => ({ _sum: { rawSize: used } }) },
};

const storage = await import('@coremail/storage');
const { submissionQuotaError } = await import('./submission.js');

test('below the prohibit-send level: no error; at it: overQuota', async () => {
  used = 89 * MB;
  assert.equal(await submissionQuotaError('u1'), null);
  storage.resetQuotaCache();
  used = 90 * MB;
  const e = await submissionQuotaError('u1');
  assert.equal(e?.type, 'overQuota');
  assert.match(String(e?.description), /send quota/);
  assert.equal(await submissionQuotaError('unknown'), null, 'unknown user: no quota row');
});
