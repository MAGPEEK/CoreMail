/**
 * Dead-letter notification + queue cleaner per QueueSettings.
 * Run: node --import tsx --test src/outbound/dead-letter.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
let queueSettingsRow: Record<string, unknown> | null = null;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  queueSettings: { findUnique: async () => queueSettingsRow },
};

const { notifyDeadLetter, buildDeadLetterNotice, cleanQueueOnce } = await import('./dead-letter.js');

const INFO = { jobId: 'j1', from: 'alice@local.example', to: ['x@ext.example'], subject: 'Report\r\nBcc: evil@x', reason: '550 User unknown', smtpCode: 550, attempts: 1 };

test('notice is an internal, auto-generated message without header injection', () => {
  const raw = buildDeadLetterNotice(INFO, 'admin@local.example', 'mail.local.example').toString('utf8');
  assert.match(raw, /^Auto-Submitted: auto-generated\r$/m);
  assert.match(raw, /^To: <admin@local\.example>\r$/m);
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.match(raw, /550 User unknown/);
});

test('notifyOnDeadLetter=false → nothing; throttle → only the first notice', async () => {
  const delivered: string[] = [];
  let slot = true;
  const deps = (enabled: boolean) => ({
    notifyEnabled: async () => enabled,
    acquireThrottle: async () => { const s = slot; slot = false; return s; },
    adminEmails: async () => ['Admin@local.example', 'admin@local.example', 'ops@local.example'],
    hostname: async () => 'mail.local.example',
    deliver: async (_raw: Buffer, rcpt: string) => { delivered.push(rcpt); },
  });
  assert.deepEqual(await notifyDeadLetter(INFO, deps(false)), []);
  assert.deepEqual(await notifyDeadLetter(INFO, deps(true)), ['admin@local.example', 'ops@local.example']);
  assert.deepEqual(await notifyDeadLetter(INFO, deps(true)), []);
  assert.deepEqual(delivered, ['admin@local.example', 'ops@local.example']);
});

test('cleaner uses completedRetentionHours and only flushes dead letters with autoFlushDead', async () => {
  const calls: Array<[number, number, string]> = [];
  const queue = { clean: async (grace: number, limit: number, type: string) => { calls.push([grace, limit, type]); return ['a']; } };
  queueSettingsRow = { completedRetentionHours: 2, autoFlushDead: false, deadLetterRetentionDays: 3 };
  await cleanQueueOnce(queue as never);
  assert.deepEqual(calls, [[2 * 3_600_000, 1000, 'completed']]);
  calls.length = 0;
  queueSettingsRow = { completedRetentionHours: 2, autoFlushDead: true, deadLetterRetentionDays: 3 };
  await cleanQueueOnce(queue as never);
  assert.deepEqual(calls, [[2 * 3_600_000, 1000, 'completed'], [3 * 86_400_000, 1000, 'failed']]);
});
