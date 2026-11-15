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
  mailbox: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'mb1' ? { userId: 'u1', sharedBoxId: null } : null) },
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

test('Email/set create, Email/import, Email/copy: SetError overQuota at the hard quota (fresh usage)', async () => {
  const { writeQuotaError, storeEmailFromRaw } = await import('../mail/write.js');
  storage.resetQuotaCache();
  used = 99 * MB;
  assert.equal(await writeQuotaError('mb1'), null);
  used = 100 * MB; // no cache reset: the write check aggregates fresh
  const e = await writeQuotaError('mb1');
  assert.equal(e?.type, 'overQuota');
  await assert.rejects(
    storeEmailFromRaw({ mailboxId: 'mb1' } as never, 'f1', Buffer.from('Subject: x\r\n\r\nb'), []),
    (err: { type?: string }) => err.type === 'overQuota',
  );
});