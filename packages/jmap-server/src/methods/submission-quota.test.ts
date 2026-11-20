/** v8.1: EmailSubmission/set refuses with SetError overQuota at the ProhibitSendQuota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MB = 1024 * 1024;
let used = 0;
let mailFlowRow: Record<string, unknown> | null = null;
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
  // 10.5: per-mailbox send rate override of the test user
  mailFlowPolicy: { findUnique: async () => mailFlowRow },
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

test('10.5: EmailSubmission/set send rate → SetError rateLimit (RFC 8620 §5.3), counted per submitting user', async () => {
  const { sendRateSetError } = await import('./submission.js');
  assert.equal(sendRateSetError({ allowed: true }), null);
  const e = sendRateSetError({ allowed: false, reason: 'recipients', limit: 1000, retryAfterSec: 90 });
  assert.equal(e?.type, 'rateLimit');
  assert.match(String(e?.description), /1000 recipients per hour; retry in 90 s/);
  assert.equal(sendRateSetError({ allowed: false, reason: 'blocked', limit: 200, retryAfterSec: 3600 })?.type, 'rateLimit');

  // the storage limiter with a per-mailbox override of 2 messages / hour
  mailFlowRow = { maxMessagesPerHour: 2 };
  storage.resetSendRateState();
  storage.setSendRateHooks({ onLimitHit: async () => undefined });
  try {
    const submit = async () => sendRateSetError(await storage.consumeSendRate({ userId: 'u1', recipients: 1, protocol: 'jmap' }));
    assert.equal(await submit(), null);
    assert.equal(await submit(), null);
    assert.equal((await submit())?.type, 'rateLimit');
  } finally {
    mailFlowRow = null;
    storage.setSendRateHooks(null);
    storage.resetSendRateState();
  }
});