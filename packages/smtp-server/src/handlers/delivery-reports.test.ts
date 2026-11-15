/**
 * Review fixes — delivery reports:
 *  - NDRs survive a retry after a partial failure (ledger keeps the outcome)
 *  - the worker's success DSN uses the persisted delivered/bounced sets
 *  - port-25 success DSNs only for an authenticated MAIL FROM domain, RET=HDRS
 *  - alias recipients: outcomes are reported under the address as given
 *  - transport-rule redirect/add-recipient targets that are full/unknown get an NDR
 *  - inline (cid:) attachments of structured queue jobs keep their Content-ID
 * Run: node --import tsx --test src/handlers/delivery-reports.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  serverSettings: { findUnique: async () => ({ publicHostname: 'mx.corp.test' }) },
  domain: { findFirst: async () => null },
};

const { deliverOnce, outcomesByOriginal, ledgerEntry } = await import('./delivery.js');
const { notifyLocalOutcomes, successDsnAllowed } = await import('./local-notify.js');
const { deliverOutboundJob, attachmentMimeFields, buildRawFromMessage } = await import('../outbound/queue.js');
const { handleTransportOutcome } = await import('./transport-actions.js');

type Deps = Parameters<typeof notifyLocalOutcomes>[1] & object;

function memoryLedger() {
  const sets = new Map<string, Set<string>>();
  return {
    sets,
    async delivered(key: string) { return new Set(sets.get(key) ?? []); },
    async remember(key: string, entries: string[]) {
      const s = sets.get(key) ?? new Set<string>();
      for (const e of entries) s.add(e);
      sets.set(key, s);
    },
  };
}

function recordingDeps() {
  const calls = { success: [] as string[][], unknown: [] as string[][], quota: [] as string[][], dsn: [] as unknown[] };
  const deps: Deps = {
    successDsn: (async (o: { rcpts: string[]; dsn: unknown }) => { calls.success.push(o.rcpts); calls.dsn.push(o.dsn); return o.rcpts; }) as never,
    bounceUnknown: (async (_raw: Buffer, _from: string, rcpts: readonly string[]) => { calls.unknown.push([...rcpts]); }) as never,
    bounceQuota: (async (_raw: Buffer, _from: string, rcpts: readonly string[]) => { calls.quota.push([...rcpts]); }) as never,
  };
  return { calls, deps };
}

const DSN = { rcpts: { 'a@corp.test': { notify: ['SUCCESS' as const] }, 'b@corp.test': { notify: ['SUCCESS' as const] } }, ret: 'FULL' as const };
const RAW = Buffer.from('Subject: Hi\r\nMessage-ID: <1@ext.test>\r\n\r\nbody\r\n');

// ── Finding 2: NDR lost on retry ─────────────────────────────────────────────

test('a retry after a partial failure still sends the NDR and no success DSN for the full mailbox', async () => {
  const ledger = memoryLedger();
  const stores: string[] = [];
  const storeLocal = async (rcpt: string) => { stores.push(rcpt); return rcpt === 'b@corp.test' ? 'quota' as const : 'delivered' as const; };
  // attempt 1: local part done (b over quota), then the queue is down → 451
  await assert.rejects(deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], {
    ledger, storeLocal, enqueueExternal: async () => { throw new Error('redis down'); },
  }));
  assert.deepEqual([...ledger.sets.get('k')!].sort(), ['a@corp.test', ledgerEntry('b@corp.test', 'quota')].sort());
  // attempt 2 (client retry): nothing stored again, outcomes come from the ledger
  const r = await deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], {
    ledger, storeLocal, enqueueExternal: async () => undefined,
  });
  assert.deepEqual(stores, ['a@corp.test', 'b@corp.test']);
  assert.equal(r.outcomes.get('b@corp.test'), 'quota');
  assert.equal(r.outcomes.get('a@corp.test'), 'delivered');
  const { calls, deps } = recordingDeps();
  await notifyLocalOutcomes({
    from: 'alice@corp.test', originals: ['a@corp.test', 'b@corp.test'], origins: new Map(), outcomes: r.outcomes,
    dsn: DSN, hostname: 'mx', deliveredRaw: RAW, ndrRaw: RAW,
  }, deps);
  assert.deepEqual(calls.quota, [['b@corp.test']]);
  assert.deepEqual(calls.success, [['a@corp.test']]);
});

test('pre-8.1 ledger entries (bare addresses) still count as delivered', async () => {
  const ledger = memoryLedger();
  await ledger.remember('k2', ['a@corp.test']);
  let stored = 0;
  const r = await deliverOnce('k2', ['a@corp.test'], [], { ledger, storeLocal: async () => { stored++; }, enqueueExternal: async () => undefined });
  assert.equal(stored, 0);
  assert.equal(r.outcomes.get('a@corp.test'), 'delivered');
});

// ── Finding 7: alias mismatch ────────────────────────────────────────────────

test('a full alias target is reported under the alias: NDR only, no "delivered" DSN', async () => {
  const origins = new Map([['full@corp.test', ['sales@corp.test']], ['a@corp.test', ['a@corp.test']]]);
  const outcomes = new Map([['full@corp.test', 'quota' as const], ['a@corp.test', 'delivered' as const]]);
  assert.deepEqual(outcomesByOriginal(origins, outcomes), { delivered: ['a@corp.test'], quota: ['sales@corp.test'], unknown: [] });
  const { calls, deps } = recordingDeps();
  await notifyLocalOutcomes({
    from: 'alice@corp.test', originals: ['sales@corp.test', 'a@corp.test'], origins, outcomes,
    dsn: { rcpts: { 'sales@corp.test': { notify: ['SUCCESS'] }, 'a@corp.test': { notify: ['SUCCESS'] } } },
    hostname: 'mx', deliveredRaw: RAW, ndrRaw: RAW,
  }, deps);
  assert.deepEqual(calls.success, [['a@corp.test']]);
  assert.deepEqual(calls.quota, [['sales@corp.test']]);
});

// ── Finding 5: success-DSN backscatter on port 25 ────────────────────────────

test('port 25: no success DSN for an unauthenticated MAIL FROM domain; RET forced to HDRS otherwise', async () => {
  const outcomes = new Map([['a@corp.test', 'delivered' as const]]);
  const base = {
    from: 'victim@ext.test', originals: ['a@corp.test'], origins: new Map<string, string[]>(), outcomes,
    dsn: DSN, hostname: 'mx', deliveredRaw: RAW, ndrRaw: RAW,
  };
  const forged = recordingDeps();
  await notifyLocalOutcomes({ ...base, unauthenticated: { senderAuth: { verifiedDomains: ['attacker.test'] } } }, forged.deps);
  assert.deepEqual(forged.calls.success, []);
  assert.equal(successDsnAllowed('victim@ext.test', { verifiedDomains: [] }), false);

  const verified = recordingDeps();
  await notifyLocalOutcomes({ ...base, unauthenticated: { senderAuth: { verifiedDomains: ['mail.ext.test'] } } }, verified.deps);
  assert.deepEqual(verified.calls.success, [['a@corp.test']]);
  assert.equal((verified.calls.dsn[0] as { ret: string }).ret, 'HDRS');

  // authenticated submission: RET as requested
  const sub = recordingDeps();
  await notifyLocalOutcomes(base, sub.deps);
  assert.equal((sub.calls.dsn[0] as { ret: string }).ret, 'FULL');
});

// ── Finding 3 + 7: worker success DSN on retry, aliases ──────────────────────

function workerJob(data: Record<string, unknown>) {
  const job = {
    id: 'j', attemptsMade: 1, opts: { attempts: 5 },
    data: { messageId: 'm', from: 'alice@corp.test', rawMessage: '', ...data } as Record<string, unknown>,
    updateData: async (d: Record<string, unknown>) => { job.data = d; },
  };
  return job;
}

function workerDeps(aliases: Record<string, string> = {}, quota: string[] = []) {
  const reports: Array<Record<string, unknown>> = [];
  return {
    reports,
    deps: {
      isLocalAddress: async (a: string) => a.endsWith('@corp.test'),
      expand: async (a: string[]) => a.map((x) => aliases[x] ?? x),
      storeLocal: async (_raw: Buffer, _from: string, rcpt: string) => (quota.includes(rcpt) ? 'quota' as const : 'stored' as const),
      resolveDkim: async () => ({}),
      relay: async () => ({ delivered: [], failures: [] }),
      bounce: async (o: Record<string, unknown>) => { reports.push(o); },
      hostname: async () => 'mx.corp.test',
    },
  };
}

test('worker retry: a recipient bounced by an earlier attempt never gets a success DSN', async () => {
  const dsn = { rcpts: { 'bob@corp.test': { notify: ['SUCCESS'] }, 'full@corp.test': { notify: ['SUCCESS', 'FAILURE'] } } };
  const job = workerJob({
    to: ['bob@corp.test', 'full@corp.test'], dsn,
    deliveredRcpts: [], bouncedRcpts: ['full@corp.test'],
  });
  const { reports, deps } = workerDeps();
  await deliverOutboundJob(job as never, RAW, deps as never);
  const success = reports.filter((r) => r['action'] === 'delivered');
  assert.equal(success.length, 1);
  assert.deepEqual(success[0]!['originalTo'], ['bob@corp.test']);
});

test('worker: a full alias target gets one NDR under the alias and no success DSN', async () => {
  const dsn = { rcpts: { 'sales@corp.test': { notify: ['SUCCESS', 'FAILURE'] } } };
  const job = workerJob({ to: ['sales@corp.test'], dsn });
  const { reports, deps } = workerDeps({ 'sales@corp.test': 'full@corp.test' }, ['full@corp.test']);
  await assert.rejects(deliverOutboundJob(job as never, RAW, deps as never)); // all failed → dead letter
  assert.equal(reports.filter((r) => r['action'] === 'delivered').length, 0);
  const ndr = reports.filter((r) => r['action'] === undefined);
  assert.equal(ndr.length, 1);
  assert.deepEqual(ndr[0]!['originalTo'], ['sales@corp.test']);
});

// ── Finding 8: transport rules ───────────────────────────────────────────────

test('a transport-rule redirect to a full or unknown local mailbox is bounced, not dropped', async () => {
  const bounced: Record<string, string[]> = { unknown: [], quota: [] };
  const outcome = {
    rejected: false, quarantined: false, redirectedTo: ['full@corp.test', 'gone@corp.test'], additionalRcpts: [], removedRcpts: [],
    appliedRuleIds: ['r1'], headerAdds: [], headerRemoves: [], subjectPrefix: '', subjectSuffix: '', disclaimerHtml: '',
  } satisfies Parameters<typeof handleTransportOutcome>[0];
  const d = await handleTransportOutcome(outcome, {
    raw: RAW, fromAddr: 'alice@corp.test', rcptTo: 'bob@corp.test', subject: 'Hi', messageId: null,
  }, {
    sendDsn: async () => undefined,
    quarantine: async () => 'q',
    storeLocal: async (_raw, _from, rcpt) => (rcpt === 'full@corp.test' ? 'quota' : 'unknown'),
    bounceUnknown: async (_raw, _from, rcpts) => { bounced['unknown']!.push(...rcpts); },
    bounceQuota: async (_raw, _from, rcpts) => { bounced['quota']!.push(...rcpts); },
    enqueueExternal: async () => undefined,
    isLocalAddress: async () => true,
    expand: async (a) => a,
    claimOnce: async () => true,
    serverHostname: async () => 'mx',
  });
  assert.equal(d, 'stop');
  assert.deepEqual(bounced, { unknown: ['gone@corp.test'], quota: ['full@corp.test'] });
});

// ── Inline images (cid:) in structured queue jobs ────────────────────────────

test('structured attachments with a cid are built as inline parts with a Content-ID', async () => {
  assert.deepEqual(attachmentMimeFields({ cid: 'logo.png@corp', inline: true }), { cid: 'logo.png@corp', contentDisposition: 'inline' });
  assert.deepEqual(attachmentMimeFields({ cid: 'bad id<>' }), {});
  assert.deepEqual(attachmentMimeFields({}), {});
  const raw = (await buildRawFromMessage({
    from: 'alice@corp.test', fromName: '', to: ['bob@ext.test'], cc: [], bcc: [], subject: 'Logo',
    html: '<p><img src="cid:logo.png@corp"></p>', text: '', messageId: '<m@corp.test>', date: new Date(0).toISOString(),
    attachments: [
      { filename: 'logo.png', minioPath: 'outbound-queue/j/logo', contentType: 'image/png', size: 3, cid: 'logo.png@corp', inline: true },
      { filename: 'doc.pdf', minioPath: 'outbound-queue/j/doc', contentType: 'application/pdf', size: 3 },
    ],
  }, async () => Buffer.from('abc'))).toString();
  assert.match(raw, /Content-ID: <logo\.png@corp>/i);
  assert.match(raw, /Content-Disposition: inline; filename=logo\.png/i);
  assert.match(raw, /Content-Disposition: attachment; filename=doc\.pdf/i);
});
