/**
 * Submission limits (9.4): stricter size of the SMTP and server settings, the
 * SMTP recipient limit, defaults, cache. Prisma via the globalThis.__prisma seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const rows = {
  smtp: { maxMessageSizeMb: 30, maxRecipients: 40 } as Record<string, unknown> | null,
  server: { maxMessageSizeMb: 20 } as Record<string, unknown> | null,
  fail: false,
  reads: 0,
};
const read = (row: () => unknown) => async () => {
  rows.reads += 1;
  if (rows.fail) throw new Error('db down');
  return row();
};
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: read(() => rows.smtp) },
  serverSettings: { findUnique: read(() => rows.server) },
};

const { submissionLimitsFrom, loadSubmissionLimits, clearSubmissionLimitsCache } = await import('./submission-limits.js');
const MB = 1024 * 1024;

test('submissionLimitsFrom: the stricter size, the SMTP recipient limit, defaults for missing or invalid values', () => {
  assert.deepEqual(submissionLimitsFrom({ maxMessageSizeMb: 30, maxRecipients: 40 }, { maxMessageSizeMb: 20 }), { maxMessageBytes: 20 * MB, maxRecipients: 40 });
  assert.deepEqual(submissionLimitsFrom({ maxMessageSizeMb: 10, maxRecipients: null }, null), { maxMessageBytes: 10 * MB, maxRecipients: 100 });
  assert.deepEqual(submissionLimitsFrom(null, null), { maxMessageBytes: 25 * MB, maxRecipients: 100 });
  assert.deepEqual(submissionLimitsFrom({ maxMessageSizeMb: 0, maxRecipients: -3 }, { maxMessageSizeMb: 0 }), { maxMessageBytes: 25 * MB, maxRecipients: 100 });
});

test('loadSubmissionLimits: read once per minute, defaults when the database fails', async () => {
  clearSubmissionLimitsCache();
  rows.reads = 0;
  assert.deepEqual(await loadSubmissionLimits(1_000), { maxMessageBytes: 20 * MB, maxRecipients: 40 });
  rows.smtp = { maxMessageSizeMb: 5, maxRecipients: 2 };
  assert.deepEqual(await loadSubmissionLimits(30_000), { maxMessageBytes: 20 * MB, maxRecipients: 40 }, 'cached');
  assert.equal(rows.reads, 2);
  assert.deepEqual(await loadSubmissionLimits(62_000), { maxMessageBytes: 5 * MB, maxRecipients: 2 }, 'cache expired');
  rows.fail = true;
  clearSubmissionLimitsCache();
  assert.deepEqual(await loadSubmissionLimits(70_000), { maxMessageBytes: 25 * MB, maxRecipients: 100 });
});
