/**
 * v8.1 mailbox quotas on the SMTP paths: submission (ProhibitSendQuota at MAIL
 * FROM), port 25 RCPT TO and local delivery (ProhibitSendReceiveQuota), the
 * outbound worker's NDR and the warning mail on delivery.
 * Run: node --import tsx --test src/handlers/quota-enforcement.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const MB = 1024 * 1024;
let used = 0;
let warnedAt: Date | null = null;
const user = {
  id: 'u1', email: 'bob@corp.test', displayName: 'Bob', active: true,
  quotaBytes: BigInt(100 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null,
};
const mailbox = { id: 'mb1', folders: [{ id: 'f-in', name: 'INBOX' }, { id: 'f-junk', name: 'Junk' }] };
type W = Record<string, unknown>;
const none = async () => null;

(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: async () => ({ localDeliveryEnabled: true }) },
  domain: { findFirst: async ({ where }: { where: { name: unknown } }) => (JSON.stringify(where.name).includes('corp.test') ? { id: 'd1', name: 'corp.test' } : null) },
  user: {
    findFirst: async ({ where, include }: { where: W; include?: W }) => {
      const hit = where['id'] === 'u1' || String(where['email'] ?? '').toLowerCase() === 'bob@corp.test';
      if (!hit) return null;
      return include ? { ...user, mailbox } : { ...user };
    },
    findUnique: async ({ where }: { where: W }) => (where['id'] === 'u1' ? { ...user, mailbox: { id: 'mb1' } } : null),
    update: async () => ({}),
    updateMany: async ({ where, data }: { where: { OR: Array<{ quotaWarnedAt: null | { lt: Date } }> }; data: { quotaWarnedAt: Date } }) => {
      const cutoff = (where.OR[1]!.quotaWarnedAt as { lt: Date }).lt;
      if (warnedAt && warnedAt >= cutoff) return { count: 0 };
      warnedAt = data.quotaWarnedAt;
      return { count: 1 };
    },
  },
  sharedMailbox: { findFirst: none, findUnique: none },
  mailFlowPolicy: { findUnique: none },
  resourceMailbox: { findFirst: none },
  emailAlias: { findFirst: none, findMany: async () => [] },
  sharedMailboxPerm: { findMany: async () => [] },
  serverSettings: { findUnique: async () => ({ quotaWarningPercent: 80, quotaProhibitSendPercent: 90, publicHostname: 'mail.corp.test' }) },
  message: { aggregate: async () => ({ _sum: { rawSize: used } }) },
  systemLog: { create: async () => ({}) },
};

const storage = await import('@coremail/storage');
const { submissionHandlers } = await import('../submission/handler.js');
const { inboundHandlers } = await import('../inbound/handler.js');
const { storeInboundMessage } = await import('./message.js');
const { deliverOutboundJob } = await import('../outbound/queue.js');
const { quotaExceededDsn, bounceQuotaLocal } = await import('./local-delivery.js');

const warnings: string[] = [];
beforeEach(() => {
  used = 0;
  warnedAt = null;
  warnings.length = 0;
  delete process.env['QUOTA_FULL_PERMANENT'];
  storage.resetQuotaCache();
  storage.setQuotaWarningSender(async (s) => { warnings.push(`${s.email}:${s.level}`); });
});

const authUser = { id: 'u1', email: 'bob@corp.test' };

test('submission: MAIL FROM is refused with 552 5.2.2 at the prohibit-send level only', async () => {
  used = 50 * MB;
  assert.equal(await submissionHandlers.onMailFrom('bob@corp.test', '192.0.2.1', authUser), null);
  storage.resetQuotaCache();
  used = 89 * MB; // warning level: still allowed, warning mail goes out
  assert.equal(await submissionHandlers.onMailFrom('bob@corp.test', '192.0.2.1', authUser), null);
  storage.resetQuotaCache();
  used = 90 * MB;
  const reply = await submissionHandlers.onMailFrom('bob@corp.test', '192.0.2.1', authUser);
  assert.match(String(reply), /^552 5\.2\.2 /);
  // one warning mail per 24 h, not one per refused attempt
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(warnings, ['bob@corp.test:warning']);
});

test('port 25 RCPT TO: 552 5.2.2 at prohibit-send-receive, 452 4.2.2 with QUOTA_FULL_PERMANENT=false', async () => {
  used = 99 * MB;
  assert.equal(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser), null);
  storage.resetQuotaCache();
  used = 100 * MB;
  assert.match(String(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser)), /^552 5\.2\.2 /);
  process.env['QUOTA_FULL_PERMANENT'] = 'false';
  assert.match(String(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser)), /^452 4\.2\.2 /);
});

test('local delivery: an over-quota mailbox is not written to ("quota" result)', async () => {
  used = 100 * MB;
  const raw = Buffer.from('From: x@ext.test\r\nTo: bob@corp.test\r\nSubject: s\r\n\r\nbody\r\n');
  assert.equal(await storeInboundMessage(raw, { fromAddr: 'x@ext.test', rcptTo: 'bob@corp.test', toJunk: false }), 'quota');
});

test('outbound worker: a "quota" local recipient gets one 5.2.2 NDR, no success DSN, no retry', async () => {
  const bounces: Array<{ recipients: Array<{ status: string }> }> = [];
  type Deps = Parameters<typeof deliverOutboundJob>[2];
  type Job = Parameters<typeof deliverOutboundJob>[0];
  const deps: Deps = {
    isLocalAddress: async (a) => a.endsWith('@corp.test'),
    expand: async (a) => a,
    storeLocal: async (_raw, _from, rcpt) => (rcpt === 'bob@corp.test' ? 'quota' : 'stored'),
    resolveDkim: async () => ({}),
    relay: async () => ({ delivered: [], failures: [] }),
    bounce: async (o) => { bounces.push(o as never); },
    hostname: async () => 'mail.corp.test',
  };
  const j: Job = {
    id: 'j1', data: { messageId: 'm1', from: 'alice@ext.test', to: ['bob@corp.test', 'eve@corp.test'], rawMessage: '' },
    attemptsMade: 0, opts: { attempts: 5 }, updateData: async (d) => { j.data = d; },
  };
  await deliverOutboundJob(j, Buffer.from('Subject: hi\r\n\r\nx'), deps);
  assert.equal(bounces.length, 1);
  assert.deepEqual(bounces[0]!.recipients.map((r) => r.status), ['5.2.2']);
  assert.deepEqual(j.data.bouncedRcpts, ['bob@corp.test']);
  assert.deepEqual(j.data.deliveredRcpts, ['eve@corp.test']);
});

test('NDR helper: 552 5.2.2 per recipient, never for a null sender', async () => {
  const dsn = quotaExceededDsn(Buffer.from('Subject: Hi\r\nMessage-ID: <a@b>\r\n\r\nx'), 'alice@ext.test', ['bob@corp.test'], 'mail.corp.test', true);
  assert.equal(dsn.smtpCode, 552);
  assert.deepEqual(dsn.recipients, [{ rcpt: 'bob@corp.test', status: '5.2.2', diagnostic: '552 5.2.2 Mailbox full', remote: false }]);
  assert.equal(dsn.originalSubject, 'Hi');
  const sent: unknown[] = [];
  await bounceQuotaLocal(Buffer.from('x'), '', ['bob@corp.test'], { bounce: async (o) => { sent.push(o); } });
  assert.equal(sent.length, 0);
  await bounceQuotaLocal(Buffer.from('x'), 'alice@ext.test', ['bob@corp.test'], { hostname: 'h', bounce: async (o) => { sent.push(o); } });
  assert.equal(sent.length, 1);
});

test('warning mail on delivery: once per 24 h when the warning level is crossed', async () => {
  used = 85 * MB;
  const owner = { kind: 'user' as const, id: 'u1' };
  const t0 = new Date('2026-11-01T08:00:00Z');
  await storage.recordDelivery(owner, 1000, t0);
  await storage.recordDelivery(owner, 1000, new Date(t0.getTime() + 12 * 3600_000));
  assert.deepEqual(warnings, ['bob@corp.test:warning']);
  await storage.recordDelivery(owner, 1000, new Date(t0.getTime() + 25 * 3600_000));
  assert.equal(warnings.length, 2);
});
