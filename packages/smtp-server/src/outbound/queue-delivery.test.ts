/**
 * Outbound worker: per-recipient progress across retries, one bounce per
 * failed recipient, bounces for external senders (RFC 5321 §6.1).
 * Run: node --import tsx --test src/outbound/queue-delivery.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  systemLog: { create: async () => ({}) },
  user: { findMany: async () => [] },
};

const { deliverOutboundJob, handleFailedJob } = await import('./queue.js');
const { UnrecoverableError } = await import('bullmq');
type Deps = Parameters<typeof deliverOutboundJob>[2];
type Job = Parameters<typeof deliverOutboundJob>[0];
type Failure = Awaited<ReturnType<Deps['relay']>>['failures'][number];

const fail = (rcpt: string, code: number, status: string): Failure =>
  ({ rcpt, code, status, message: `${code} ${status} x`, permanent: code >= 500 });

function harness(relayPlan: Array<(to: string[]) => { delivered: string[]; failures: Failure[] }>) {
  const stored: string[] = [];
  const relayed: string[][] = [];
  const bounces: Array<Parameters<Deps['bounce']>[0]> = [];
  let call = 0;
  const deps: Deps & { deadLetter: () => Promise<string[]> } = {
    isLocalAddress: async (a) => a.endsWith('@corp.test'),
    expand: async (a) => a.map((x) => (x === 'sales@corp.test' ? 'bob@corp.test' : x)),
    storeLocal: async (_raw, _from, rcpt) => { stored.push(rcpt); },
    resolveDkim: async () => ({}),
    relay: async (_raw, _from, to) => { relayed.push(to); return relayPlan[call++]!(to); },
    bounce: async (o) => { bounces.push(o); },
    deadLetter: async () => [],
    hostname: async () => 'mail.corp.test',
  };
  return { deps, stored, relayed, bounces };
}

function job(to: string[], from = 'alice@ext.test'): Job {
  const j: Job = {
    id: 'j1',
    data: { messageId: 'm1', from, to, rawMessage: '' },
    attemptsMade: 0,
    opts: { attempts: 5 },
    updateData: async (d) => { j.data = d; },
  };
  return j;
}

test('a temporary external failure retries only the open recipient — no duplicate local copy, no re-send', async () => {
  const h = harness([
    (to) => ({ delivered: to.filter((r) => r !== 'grey@ext.test'), failures: [fail('grey@ext.test', 450, '4.2.0')] }),
    (to) => ({ delivered: to, failures: [] }),
  ]);
  const j = job(['sales@corp.test', 'ok@ext.test', 'grey@ext.test']);

  await assert.rejects(deliverOutboundJob(j, Buffer.from('x'), h.deps), /Temporary failure for 1 recipient/);
  j.attemptsMade = 1;
  await deliverOutboundJob(j, Buffer.from('x'), h.deps);

  assert.deepEqual(h.stored, ['bob@corp.test']);
  assert.deepEqual(h.relayed, [['ok@ext.test', 'grey@ext.test'], ['grey@ext.test']]);
  assert.equal(h.bounces.length, 0);
});

test('a permanent rejection of one recipient is bounced once, immediately, also to an external sender', async () => {
  const h = harness([
    () => ({ delivered: ['ok@ext.test'], failures: [fail('gone@ext.test', 550, '5.1.1')] }),
  ]);
  const j = job(['ok@ext.test', 'gone@ext.test']);

  await deliverOutboundJob(j, Buffer.from('x'), h.deps);

  assert.equal(h.bounces.length, 1);
  assert.deepEqual(h.bounces[0]?.originalTo, ['gone@ext.test']);
  assert.equal(h.bounces[0]?.recipients?.[0]?.status, '5.1.1');
  assert.equal(h.bounces[0]?.deliverExternal, true);
  assert.deepEqual(j.data.bouncedRcpts, ['gone@ext.test']);
});

test('when every recipient fails permanently the job ends without retry (dead letter), bounced exactly once', async () => {
  const h = harness([() => ({ delivered: [], failures: [fail('gone@ext.test', 550, '5.1.1')] })]);
  const j = job(['gone@ext.test']);

  const err = await deliverOutboundJob(j, Buffer.from('x'), h.deps).catch((e: unknown) => e);
  assert.ok(err instanceof UnrecoverableError);
  const failed = handleFailedJob({ ...j, attemptsMade: 1 }, err, h.deps);

  assert.equal(failed.final, true);
  assert.deepEqual(failed.bounced, [], 'the failed handler does not bounce a second time');
  assert.equal(h.bounces.length, 1);
});

test('failed handler: no bounce while retries remain; on give-up only the still-open recipients are bounced', async () => {
  const h = harness([
    () => ({ delivered: ['ok@ext.test'], failures: [fail('grey@ext.test', 451, '4.3.0')] }),
  ]);
  const j = job(['ok@ext.test', 'grey@ext.test']);
  const err = await deliverOutboundJob(j, Buffer.from('x'), h.deps).then(() => new Error('expected a failure'), (e: unknown) => e as Error);

  const retry = handleFailedJob({ ...j, attemptsMade: 1 }, err, h.deps);
  const giveUp = handleFailedJob({ ...j, attemptsMade: 5 }, err, h.deps);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(retry, { final: false, bounced: [] });
  assert.deepEqual(giveUp, { final: true, bounced: ['grey@ext.test'] });
  assert.equal(h.bounces.length, 1);
  assert.equal(h.bounces[0]?.deliverExternal, true);
  assert.equal(h.bounces[0]?.recipients?.[0]?.status, '4.3.0');
});

// v8.0 review: a redirect keeps the original (possibly forged) sender → no backscatter.
test('a job from a redirect rule is never bounced to an external sender (now or on give-up)', async () => {
  const h = harness([
    () => ({ delivered: [], failures: [fail('gone@ext.test', 550, '5.1.1'), fail('grey@ext.test', 451, '4.3.0')] }),
  ]);
  const j = job(['gone@ext.test', 'grey@ext.test'], 'forged@victim.test');
  j.data.ruleRedirect = true;

  const err = await deliverOutboundJob(j, Buffer.from('x'), h.deps).then(() => new Error('expected a failure'), (e: unknown) => e as Error);
  handleFailedJob({ ...j, attemptsMade: 5 }, err, h.deps);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(h.bounces.length, 2);
  assert.ok(h.bounces.every((b) => b.deliverExternal === false), 'sendDsnBounce then only reaches a LOCAL original sender');
});

test('the bare <Postmaster> recipient is delivered locally (expanded), not relayed', async () => {
  const h = harness([]);
  h.deps.expand = async (a) => a.map((x) => (x === 'postmaster' ? 'admin@corp.test' : x));

  await deliverOutboundJob(job(['postmaster']), Buffer.from('x'), h.deps);

  assert.deepEqual(h.stored, ['admin@corp.test']);
  assert.deepEqual(h.relayed, []);
});

test('v8.1: a transient failure retries until the expiry; then ONE final NDR with 5.4.7 (expired)', async () => {
  const { queueExpiredError, isQueueExpiredError, finalBounceRecipients, outboundBackoffStrategy } = await import('./queue.js');
  const h = harness([() => ({ delivered: [], failures: [fail('slow@ext.test', 451, '4.4.1')] })]);
  const j = job(['slow@ext.test']);
  j.opts = { attempts: 100 };
  await assert.rejects(deliverOutboundJob(j, Buffer.from('x'), h.deps), /Temporary failure/);

  // a retry while attempts remain and the window is open → no bounce
  const mid = handleFailedJob({ ...j, attemptsMade: 30 }, new Error('451 4.4.1 try later'), h.deps);
  assert.equal(mid.final, false);

  // the worker's expiry check → final NDR, status 5.4.7, last remote reply kept as diagnostic
  const err = queueExpiredError(48);
  assert.ok(isQueueExpiredError(err));
  assert.ok(err instanceof UnrecoverableError);
  const done = handleFailedJob({ ...j, attemptsMade: 31 }, err, h.deps);
  assert.equal(done.final, true);
  assert.deepEqual(done.bounced, ['slow@ext.test']);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.bounces.length, 1);
  const ndr = h.bounces[0]!;
  assert.equal(ndr.action ?? 'failed', 'failed');
  assert.equal(ndr.recipients![0]!.status, '5.4.7');
  assert.match(ndr.recipients![0]!.diagnostic, /451 4\.4\.1/);
  assert.match(ndr.failureReason, /expired in queue after 48 hours/);

  // no pending failure known → every open recipient gets 5.4.7
  assert.deepEqual(finalBounceRecipients({ messageId: 'm', from: 'a@corp.test', to: ['x@y', 'z@y'], deliveredRcpts: ['z@y'] }, err).map((f) => [f.rcpt, f.status]), [['x@y', '5.4.7']]);
  // the BullMQ strategy delegates to the schedule (1 min after the first failure)
  assert.equal(await outboundBackoffStrategy(1, 'coremail-outbound', undefined, { timestamp: Date.now() }), 60_000);
});
