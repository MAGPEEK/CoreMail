/**
 * 9.4 per-mailbox mail flow on the SMTP paths: port 25 RCPT TO (envelope
 * sender), DATA (every recipient refuses), local delivery ('policy' result →
 * NDR 5.7.1 from every path), admin forwarding plan (loops, bounces),
 * per-mailbox send limits on submission and the once-per-job foreign-send step.
 * Run: node --import tsx --test src/handlers/mail-flow-enforcement.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

type W = Record<string, unknown>;
const none = async () => null;
const user = {
  id: 'u1', email: 'bob@corp.test', displayName: 'Bob', active: true,
  quotaBytes: BigInt(100 * 1024 * 1024), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null,
};
const mailbox = { id: 'mb1', folders: [{ id: 'f-in', name: 'INBOX' }, { id: 'f-junk', name: 'Junk' }] };
let policyRow: W | null = null;
let created = 0;

(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: async () => ({ localDeliveryEnabled: true }) },
  domain: { findFirst: async () => ({ id: 'd1', name: 'corp.test' }) },
  user: {
    findFirst: async ({ where, include }: { where: W; include?: W }) => {
      const hit = where['id'] === 'u1' || String(where['email'] ?? '').toLowerCase() === 'bob@corp.test';
      if (!hit) return null;
      return include ? { ...user, mailbox } : { ...user };
    },
    findUnique: async ({ where }: { where: W }) => (where['id'] === 'u1' ? { ...user, mailbox: { id: 'mb1' } } : null),
  },
  sharedMailbox: { findFirst: none, findUnique: none },
  resourceMailbox: { findFirst: none },
  emailAlias: { findFirst: none, findMany: async () => [] },
  sharedMailboxPerm: { findMany: async () => [] },
  mailFlowPolicy: { findUnique: async ({ where }: { where: W }) => (where['userId'] === 'u1' ? policyRow : null) },
  serverSettings: { findUnique: async () => ({ quotaWarningPercent: 80, quotaProhibitSendPercent: 90, publicHostname: 'mail.corp.test' }) },
  message: { aggregate: async () => ({ _sum: { rawSize: 0 } }), create: async () => { created++; return {}; } },
  systemLog: { create: async () => ({}) },
};

const storage = await import('@coremail/storage');
const { inboundHandlers, refusalForAllRecipients } = await import('../inbound/handler.js');
const { submissionLimitReply } = await import('../submission/handler.js');
const { storeInboundMessage, toLocalOutcome } = await import('./message.js');
const { planAdminForward } = await import('./rule-forward.js');
const { outcomesByOriginal, ledgerEntry, ledgerOutcome } = await import('./delivery.js');
const { deliverOutboundJob, runForeignSendOnce } = await import('../outbound/queue.js');
const { policyRefusedDsn, bouncePolicyLocal, POLICY_REFUSED_DIAGNOSTIC } = await import('./local-delivery.js');

beforeEach(() => {
  policyRow = null;
  created = 0;
  storage.resetQuotaCache();
});

const authUser = { id: 'u1', email: 'bob@corp.test' };

test('port 25 RCPT TO: reject-from / accept-only-from refuse the envelope sender with 550 5.7.1', async () => {
  assert.equal(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser), null, 'no policy → accepted');
  policyRow = { rejectFrom: ['ext.test'] };
  assert.match(String(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser)), /^550 5\.7\.1 /);
  assert.equal(await inboundHandlers.onRcptTo('bob@corp.test', 'x@other.test', authUser), null);
  policyRow = { acceptFrom: ['partner.test'] };
  assert.match(String(await inboundHandlers.onRcptTo('bob@corp.test', 'x@ext.test', authUser)), /^550 5\.7\.1 /);
  assert.match(String(await inboundHandlers.onRcptTo('bob@corp.test', '', authUser)), /^550 5\.7\.1 /, 'null sender to accept-only');
  assert.equal(await inboundHandlers.onRcptTo('bob@corp.test', 'a@partner.test', authUser), null);
});

test('local delivery: a refused sender (header From:) or an oversized message is not stored → "policy"', async () => {
  const raw = Buffer.from('From: spoof@evil.test\r\nTo: bob@corp.test\r\nSubject: s\r\n\r\nbody\r\n');
  policyRow = { rejectFrom: ['evil.test'] };
  assert.equal(await storeInboundMessage(raw, { fromAddr: 'ok@ext.test', rcptTo: 'bob@corp.test', toJunk: false }), 'policy');
  policyRow = { maxReceiveSizeMb: 1 };
  const big = Buffer.concat([raw, Buffer.alloc(1024 * 1024 + 10, 0x61)]);
  assert.equal(await storeInboundMessage(big, { fromAddr: 'ok@ext.test', rcptTo: 'bob@corp.test', toJunk: false }), 'policy');
  assert.equal(created, 0, 'nothing written');
  assert.equal(toLocalOutcome('policy'), 'policy');
  assert.equal(toLocalOutcome('stored'), 'delivered');
  assert.equal(toLocalOutcome(undefined), 'delivered');
});

test('DATA: refused only when EVERY local recipient refuses and there is no external one', async () => {
  const facts = { envelopeFrom: 'x@ext.test', headerFrom: 'x@ext.test', sizeBytes: 10 };
  const refusing = { policy: storage.mailFlowFromRow({ rejectFrom: ['ext.test'] }) };
  const open = { policy: storage.mailFlowFromRow(null) };
  const lookup = async (r: string) => (r.startsWith('no') ? refusing : r.startsWith('res') ? null : open);
  assert.equal(await refusalForAllRecipients(['no1@corp.test', 'no2@corp.test'], [], facts, lookup), storage.SENDER_REFUSED_REPLY);
  assert.equal(await refusalForAllRecipients(['no1@corp.test', 'yes@corp.test'], [], facts, lookup), null, 'one accepts → NDR path');
  assert.equal(await refusalForAllRecipients(['no1@corp.test'], ['x@ext2.test'], facts, lookup), null, 'external targets are delivered');
  assert.equal(await refusalForAllRecipients(['res@corp.test'], [], facts, lookup), null, 'a resource mailbox accepts');
  assert.equal(await refusalForAllRecipients([], [], facts, lookup), null);
});

test('delivery ledger + reports: "policy" outcomes survive a retry and are reported under the alias', () => {
  const entries = new Set([ledgerEntry('bob@corp.test', 'policy')]);
  assert.equal(ledgerOutcome(entries, 'bob@corp.test'), 'policy');
  const origins = new Map([['bob@corp.test', ['sales@corp.test']]]);
  const r = outcomesByOriginal(origins, new Map([['bob@corp.test', 'policy' as const]]));
  assert.deepEqual(r.policy, ['sales@corp.test']);
});

test('outbound worker: a "policy" local recipient gets one 5.7.1 NDR, never for a null sender', async () => {
  type Deps = Parameters<typeof deliverOutboundJob>[2];
  type Job = Parameters<typeof deliverOutboundJob>[0];
  const bounces: Array<{ recipients: Array<{ status: string; diagnostic: string }> }> = [];
  const deps: Deps = {
    isLocalAddress: async (a) => a.endsWith('@corp.test'),
    expand: async (a) => a,
    storeLocal: async (_raw, _from, rcpt) => (rcpt === 'bob@corp.test' ? 'policy' : 'stored'),
    resolveDkim: async () => ({}),
    relay: async () => ({ delivered: [], failures: [] }),
    bounce: async (o) => { bounces.push(o as never); },
    hostname: async () => 'mail.corp.test',
  };
  const j: Job = {
    id: 'j1', data: { messageId: 'm1', from: 'alice@corp.test', to: ['bob@corp.test', 'eve@corp.test'], rawMessage: '' },
    attemptsMade: 0, opts: { attempts: 5 }, updateData: async (d) => { j.data = d; },
  };
  await deliverOutboundJob(j, Buffer.from('Subject: hi\r\n\r\nx'), deps);
  assert.equal(bounces.length, 1);
  assert.deepEqual(bounces[0]!.recipients.map((r) => [r.status, r.diagnostic]), [['5.7.1', POLICY_REFUSED_DIAGNOSTIC]]);
  assert.deepEqual(j.data.bouncedRcpts, ['bob@corp.test']);
  assert.deepEqual(j.data.deliveredRcpts, ['eve@corp.test']);

  const dsn = policyRefusedDsn(Buffer.from('Subject: Hi\r\n\r\nx'), 'a@x.test', ['bob@corp.test'], 'h', true);
  assert.equal(dsn.smtpCode, 550);
  const sent: unknown[] = [];
  await bouncePolicyLocal(Buffer.from('x'), '', ['bob@corp.test'], { bounce: async (o) => { sent.push(o); } });
  assert.equal(sent.length, 0, 'no bounce of a bounce');
});

test('admin forwarding plan: forward + keep copy, forward only, loop protection and bounces stay local', () => {
  assert.equal(planAdminForward({ forwardTo: null, forwardKeepCopy: true }, { envelopeFrom: 'a@x.test', alreadyForwarded: false }), 'none');
  assert.deepEqual(planAdminForward({ forwardTo: 'b@y.test', forwardKeepCopy: true }, { envelopeFrom: 'a@x.test', alreadyForwarded: false }), { to: 'b@y.test', keepCopy: true });
  assert.deepEqual(planAdminForward({ forwardTo: 'b@y.test', forwardKeepCopy: false }, { envelopeFrom: 'a@x.test', alreadyForwarded: false }), { to: 'b@y.test', keepCopy: false });
  assert.equal(planAdminForward({ forwardTo: 'b@y.test', forwardKeepCopy: false }, { envelopeFrom: 'a@x.test', alreadyForwarded: true }), 'skipped-loop', 'already forwarded → kept locally');
  assert.equal(planAdminForward({ forwardTo: 'b@y.test', forwardKeepCopy: false }, { envelopeFrom: '', alreadyForwarded: false }), 'skipped-loop', 'null sender → kept locally');
});

test('submission send limits: size → 552 5.3.4, recipients → 550 5.5.3, within limits → null', () => {
  assert.equal(submissionLimitReply({ ok: true }), null);
  assert.match(String(submissionLimitReply({ ok: false, kind: 'size', limit: 5 * 1024 * 1024 })), /^552 5\.3\.4 .*\(5 MB\)/);
  assert.match(String(submissionLimitReply({ ok: false, kind: 'recipients', limit: 3 })), /^550 5\.5\.3 .*max 3/);
});

test('foreign-send step runs once per job and only for marked jobs with a sender', async () => {
  const runs: unknown[] = [];
  const run = async (i: unknown) => { runs.push(i); return null; };
  const job = { data: { messageId: 'm', from: 'a@x.test', to: ['b@y.test'], senderUserId: 'u1', foreignSendSource: 'webmail' as const }, updateData: async (d: never) => { job.data = d; } };
  assert.equal(await runForeignSendOnce(job, Buffer.from('x'), run), true);
  assert.equal(await runForeignSendOnce(job, Buffer.from('x'), run), false, 'a retry does not repeat it');
  assert.equal(runs.length, 1);
  assert.deepEqual((runs[0] as { source: string; userId: string }), { userId: 'u1', raw: Buffer.from('x'), source: 'webmail' });
  const unmarked = { data: { messageId: 'm', from: 'a@x.test', to: ['b@y.test'], senderUserId: 'u1' }, updateData: async () => undefined };
  assert.equal(await runForeignSendOnce(unmarked, Buffer.from('x'), run), false);
});
