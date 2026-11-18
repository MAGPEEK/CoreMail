/**
 * 9.4 review: a held message (scheduled send, undo hold, FUTURERELEASE) is
 * re-checked for send-as / on-behalf rights when the worker sends it.
 * Run: node --import tsx --test src/outbound/send-time-sender.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined, systemLog: { create: async () => ({}) } };

const storage = await import('@coremail/storage');
const { needsSendTimeSenderCheck, handleFailedJob } = await import('./queue.js');
const { refuseRevokedSender, SENDER_REVOKED_PREFIX } = await import('./send-time-sender.js');
type Job = import('./queue.js').OutboundJob;

const RAW = Buffer.from('From: Team <team@corp.test>\r\nSender: <bob@corp.test>\r\nTo: x@ext.test\r\nSubject: Report\r\nMessage-ID: <m1@corp.test>\r\n\r\nbody\r\n');

test('only delayed jobs of a user are re-checked (no rule forwards, releases or immediate sends)', () => {
  const data: Job = { messageId: 'j', from: 'team@corp.test', to: ['x@ext.test'], senderUserId: 'u1', rawMessage: '' };
  assert.equal(needsSendTimeSenderCheck({ data, opts: { delay: 60_000 } }), true);
  assert.equal(needsSendTimeSenderCheck({ data, opts: {} }), false, 'immediate send: checked when queued');
  assert.equal(needsSendTimeSenderCheck({ data: { ...data, ruleForward: true }, opts: { delay: 1 } }), false);
  assert.equal(needsSendTimeSenderCheck({ data: { ...data, ruleRedirect: true }, opts: { delay: 1 } }), false);
  assert.equal(needsSendTimeSenderCheck({ data: { ...data, quarantineReleaseId: 'q' }, opts: { delay: 1 } }), false);
  const { senderUserId: _drop, ...noUser } = data;
  assert.equal(needsSendTimeSenderCheck({ data: noUser, opts: { delay: 1 } }), false);
});

test('storage: envelope + header sender verdict with the current rights', () => {
  const own = ['bob@corp.test'];
  assert.equal(storage.evaluateSubmissionSender(RAW, 'team@corp.test', own, ['team@corp.test']).ok, true, 'on behalf with own Sender:');
  assert.equal(storage.evaluateSubmissionSender(RAW, 'team@corp.test', own, []).ok, false, 'SEND_ON_BEHALF revoked');
  const sendAs = Buffer.from('From: team@corp.test\r\nSubject: s\r\n\r\nb\r\n');
  assert.equal(storage.evaluateSubmissionSender(sendAs, 'team@corp.test', [...own, 'team@corp.test']).ok, true);
  assert.equal(storage.evaluateSubmissionSender(sendAs, 'team@corp.test', own).ok, false, 'SEND_AS revoked');
  const forgedEnvelope = Buffer.from('From: bob@corp.test\r\nSubject: s\r\n\r\nb\r\n');
  assert.equal(storage.evaluateSubmissionSender(forgedEnvelope, 'team@corp.test', own, ['team@corp.test']).ok, false,
    'an on-behalf envelope needs the own Sender: field');
});

test('revoked rights: no send, NDR to the sending user (not the shared box), recipients marked bounced, schedule cancelled', async () => {
  const bounces: Array<Record<string, unknown>> = [];
  const cancelled: string[] = [];
  const job = {
    id: 'api-1',
    data: { messageId: 'j1', from: 'team@corp.test', to: ['x@ext.test', 'y@ext.test'], senderUserId: 'u1', rawMessage: RAW.toString('base64') } as Job,
    async updateData(d: Job) { this.data = d; },
  };
  const deps = {
    check: async () => ({ ok: false, reason: 'From address <team@corp.test> not allowed' }),
    userEmail: async () => 'bob@corp.test',
    bounce: async (o: unknown) => { bounces.push(o as Record<string, unknown>); },
    hostname: async () => 'mail.corp.test',
    cancelScheduled: async (id: string) => { cancelled.push(id); },
  };
  const err = await refuseRevokedSender(job, RAW, deps);
  assert.ok(err && err.name === 'UnrecoverableError');
  assert.ok(err.message.startsWith(SENDER_REVOKED_PREFIX));
  assert.equal(bounces.length, 1);
  assert.equal(bounces[0]!['originalFrom'], 'bob@corp.test');
  assert.equal(bounces[0]!['smtpCode'], 550);
  assert.deepEqual((bounces[0]!['recipients'] as Array<{ status: string }>).map((r) => r.status), ['5.7.1', '5.7.1']);
  assert.equal(bounces[0]!['originalSubject'], 'Report');
  assert.deepEqual(cancelled, ['api-1']);
  assert.deepEqual(job.data.bouncedRcpts, ['x@ext.test', 'y@ext.test']);

  // the failed handler then sends no second NDR to the envelope sender
  const final = handleFailedJob({ ...job, attemptsMade: 1, opts: {} }, err, {
    bounce: async (o) => { bounces.push(o as unknown as Record<string, unknown>); }, hostname: async () => 'mail.corp.test', deadLetter: async () => [],
  });
  assert.equal(final.final, true);
  assert.deepEqual(final.bounced, []);
});

test('rights still valid: the held message is sent', async () => {
  const job = { id: 'api-2', data: { messageId: 'j2', from: 'bob@corp.test', to: ['x@ext.test'], senderUserId: 'u1' } as Job, async updateData() { /* unused */ } };
  const deps = {
    check: async () => ({ ok: true }), userEmail: async () => 'bob@corp.test',
    bounce: async () => { throw new Error('no NDR expected'); }, hostname: async () => 'h', cancelScheduled: async () => { throw new Error('no cancel expected'); },
  };
  assert.equal(await refuseRevokedSender(job, RAW, deps), null);
});

test('review: only still open recipients are refused — none delivered before, no second NDR on an admin retry', async () => {
  const bounces: Array<Record<string, unknown>> = [];
  const job = {
    id: 'api-3',
    data: { messageId: 'j3', from: 'team@corp.test', to: ['x@ext.test', 'y@ext.test'], senderUserId: 'u1', deliveredRcpts: ['x@ext.test'] } as Job,
    async updateData(d: Job) { this.data = d; },
  };
  const deps = {
    check: async () => ({ ok: false, reason: 'From address <team@corp.test> not allowed' }),
    userEmail: async () => 'bob@corp.test',
    bounce: async (o: unknown) => { bounces.push(o as Record<string, unknown>); },
    hostname: async () => 'mail.corp.test',
    cancelScheduled: async () => undefined,
  };
  assert.ok(await refuseRevokedSender(job, RAW, deps));
  assert.deepEqual((bounces[0]!['recipients'] as Array<{ rcpt: string }>).map((r) => r.rcpt), ['y@ext.test'], 'x was delivered on an earlier attempt');
  assert.deepEqual(bounces[0]!['originalTo'], ['y@ext.test']);
  assert.deepEqual(job.data.bouncedRcpts, ['y@ext.test']);

  // admin "Retry" of the dead letter: the progress is kept, the job is refused again without an NDR
  const again = await refuseRevokedSender(job, RAW, deps);
  assert.ok(again && again.name === 'UnrecoverableError');
  assert.equal(bounces.length, 1, 'no second NDR');
});

test('review: messages as the webmail builds them pass with the current rights (no false cancellation)', async () => {
  const build = (o: Record<string, unknown>) => storage.buildCrlfMime({ to: 'x@ext.test', subject: 's', text: 'b', ...o });
  const own = await build({ from: { name: 'Jürgen Müller-Lüdenscheidt, Abteilung Vertrieb', address: 'bob@corp.test' } });
  assert.equal(storage.evaluateSubmissionSender(own, 'bob@corp.test', ['bob@corp.test']).ok, true, 'own address, non-ASCII display name');
  const onBehalf = await build({ from: { name: 'Team', address: 'team@corp.test' }, sender: '"Bob, Sales" <bob@corp.test>' });
  assert.equal(storage.evaluateSubmissionSender(onBehalf, 'team@corp.test', ['bob@corp.test'], ['team@corp.test']).ok, true, 'on behalf');
  const sendAs = await build({ from: { name: 'Team', address: 'Team@Corp.Test' } });
  assert.equal(storage.evaluateSubmissionSender(sendAs, 'team@corp.test', ['bob@corp.test', 'team@corp.test']).ok, true, 'send as, mixed case');
  // nodemailer writes the A-label into From — the account may be stored with the U-label
  const idn = await build({ from: { name: 'Anna', address: 'anna@bücher.example' } });
  assert.match(idn.toString(), /anna@xn--bcher-kva\.example/);
  assert.equal(storage.evaluateSubmissionSender(idn, 'anna@bücher.example', ['anna@bücher.example']).ok, true, 'IDN: either spelling');
  assert.equal(storage.evaluateSubmissionSender(idn, 'anna@xn--bcher-kva.example', ['anna@bücher.example']).ok, true);
});
