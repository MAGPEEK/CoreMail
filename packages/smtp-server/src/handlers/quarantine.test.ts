/**
 * Quarantine store path + transport-rule routing actions (reject / quarantine /
 * redirect / addRecipient / removeRecipient) + internal-header forging.
 * Run: node --import tsx --test src/handlers/quarantine.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

let quarantineRows: Record<string, unknown>[] = [];
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  quarantine: {
    create: async ({ data }: { data: Record<string, unknown> }) => { quarantineRows.push(data); return data; },
  },
  systemLog: { create: async () => ({}) },
};

const { quarantineMessage } = await import('./quarantine.js');
const { handleTransportOutcome, applyRecipientChanges, planRecipient } = await import('./transport-actions.js');
const { stripHeaders, INTERNAL_MAIL_HEADERS, QUARANTINE_RELEASE_HEADER } = await import('@coremail/storage');
type Outcome = Parameters<typeof handleTransportOutcome>[0];
type Deps = NonNullable<Parameters<typeof handleTransportOutcome>[2]>;

const RAW = Buffer.from(
  'From: Mallory <mallory@evil.test>\r\nTo: bob@corp.test\r\nSubject: Invoice\r\nMessage-ID: <m1@evil.test>\r\n\r\nhello\r\n',
);

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    rejected: false, quarantined: false, redirectedTo: [], additionalRcpts: [], removedRcpts: [],
    headerAdds: [], headerRemoves: [], subjectPrefix: '', subjectSuffix: '', disclaimerHtml: '',
    appliedRuleIds: ['r1'], ...over,
  };
}

interface Calls {
  dsn: Parameters<Deps['sendDsn']>[0][];
  quarantine: Parameters<Deps['quarantine']>[0][];
  local: { rcpt: string; opts: unknown }[];
  external: string[][];
}
let calls: Calls;
let claimed: Set<string>;

function deps(localDomains = ['corp.test']): Deps {
  return {
    sendDsn: async (o) => { calls.dsn.push(o); },
    quarantine: async (i) => { calls.quarantine.push(i); return 'q1'; },
    storeLocal: async (_raw, _from, rcpt, opts) => { calls.local.push({ rcpt, opts }); },
    enqueueExternal: async (_raw, _from, to) => { calls.external.push(to); },
    isLocalAddress: async (a) => localDomains.includes(a.split('@')[1] ?? ''),
    expand: async (a) => a,
    claimOnce: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    serverHostname: async () => 'mail.corp.test',
  };
}

const ctx = (over: Record<string, unknown> = {}) => ({
  raw: RAW, fromAddr: 'mallory@evil.test', rcptTo: 'bob@corp.test', subject: 'Invoice', messageId: '<m1@evil.test>', ...over,
});

beforeEach(() => {
  quarantineRows = [];
  calls = { dsn: [], quarantine: [], local: [], external: [] };
  claimed = new Set();
});

// ── quarantine store ──────────────────────────────────────────────────────────

test('quarantineMessage stores raw in object storage + row with full envelope, reason and score', async () => {
  const uploads: { key: string; buf: Buffer }[] = [];
  const id = await quarantineMessage(
    { raw: RAW, from: 'mallory@evil.test', recipients: ['Bob@corp.test', 'carol@corp.test'], reason: 'VIRUS',
      details: { virusName: 'EICAR' }, spamScore: 4.2 },
    { upload: async (key, buf) => { uploads.push({ key, buf }); }, keyFor: (i) => `quarantine/${i}.eml`, notify: async () => undefined },
  );
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.key, `quarantine/${id}.eml`);
  assert.ok(uploads[0]!.buf.equals(RAW));
  assert.equal(quarantineRows.length, 1);
  const row = quarantineRows[0]!;
  assert.equal(row['id'], id);
  assert.equal(row['rawPath'], `quarantine/${id}.eml`);
  assert.equal(row['reason'], 'VIRUS');
  assert.equal(row['toAddr'], 'bob@corp.test');
  assert.equal(row['subject'], 'Invoice');
  assert.deepEqual(row['details'], {
    virusName: 'EICAR',
    envelope: { from: 'mallory@evil.test', recipients: ['bob@corp.test', 'carol@corp.test'] },
    spamScore: 4.2,
  });
});

test('transport-rule quarantine → quarantine store, no delivery', async () => {
  const d = await handleTransportOutcome(outcome({ quarantined: true }), ctx({ spamScore: 3 }), deps());
  assert.equal(d, 'stop');
  assert.equal(calls.quarantine.length, 1);
  assert.deepEqual(calls.quarantine[0]!.recipients, ['bob@corp.test']);
  assert.equal(calls.quarantine[0]!.from, 'mallory@evil.test');
  assert.equal(calls.quarantine[0]!.reason, 'POLICY');
  assert.equal(calls.quarantine[0]!.spamScore, 3);
  assert.ok(calls.quarantine[0]!.raw.equals(RAW));
  assert.equal(calls.local.length + calls.external.length + calls.dsn.length, 0);
});

test('released message (internal flag) is not re-quarantined', async () => {
  const d = await handleTransportOutcome(outcome({ quarantined: true }), ctx({ quarantineRelease: true }), deps());
  assert.equal(d, 'continue');
  assert.equal(calls.quarantine.length, 0);
});

// ── reject → DSN ─────────────────────────────────────────────────────────────

test('rule reject → DSN to the envelope sender (external allowed), no delivery', async () => {
  const d = await handleTransportOutcome(outcome({ rejected: true, rejectReason: 'No invoices' }), ctx(), deps());
  assert.equal(d, 'stop');
  assert.equal(calls.dsn.length, 1);
  const dsn = calls.dsn[0]!;
  assert.equal(dsn.originalFrom, 'mallory@evil.test');
  assert.deepEqual(dsn.originalTo, ['bob@corp.test']);
  assert.equal(dsn.failureReason, 'No invoices');
  assert.equal(dsn.smtpCode, 550);
  assert.equal(dsn.deliverExternal, true);
  assert.equal(calls.local.length + calls.external.length + calls.quarantine.length, 0);
});

test('rule reject with null sender → no DSN (backscatter protection)', async () => {
  for (const from of ['', '<>']) {
    const d = await handleTransportOutcome(outcome({ rejected: true }), ctx({ fromAddr: from }), deps());
    assert.equal(d, 'stop');
  }
  assert.equal(calls.dsn.length, 0);
});

test('rule reject on a multi-recipient message → only one DSN', async () => {
  const dp = deps();
  await handleTransportOutcome(outcome({ rejected: true }), ctx({ rcptTo: 'bob@corp.test' }), dp);
  await handleTransportOutcome(outcome({ rejected: true }), ctx({ rcptTo: 'carol@corp.test' }), dp);
  assert.equal(calls.dsn.length, 1);
});

// ── recipient-set math ───────────────────────────────────────────────────────

test('applyRecipientChanges: redirect replaces, add appends, remove wins, dedup + lower-case', () => {
  const none = { redirectedTo: [], additionalRcpts: [], removedRcpts: [] };
  assert.deepEqual(applyRecipientChanges(['a@x.test', 'b@x.test'], none), ['a@x.test', 'b@x.test']);
  assert.deepEqual(applyRecipientChanges(['a@x.test', 'b@x.test'], { ...none, redirectedTo: ['R@x.test'] }), ['r@x.test']);
  assert.deepEqual(applyRecipientChanges(['a@x.test'], { ...none, additionalRcpts: ['audit@x.test', 'A@x.test'] }),
    ['a@x.test', 'audit@x.test']);
  assert.deepEqual(applyRecipientChanges(['a@x.test', 'b@x.test'], { ...none, removedRcpts: ['B@X.TEST'] }), ['a@x.test']);
  assert.deepEqual(
    applyRecipientChanges(['a@x.test'], { redirectedTo: ['r@x.test'], additionalRcpts: ['c@x.test'], removedRcpts: ['c@x.test'] }),
    ['r@x.test'],
  );
});

test('planRecipient separates the original recipient from extra deliveries', () => {
  const none = { redirectedTo: [], additionalRcpts: [], removedRcpts: [] };
  assert.deepEqual(planRecipient('Bob@corp.test', { ...none, additionalRcpts: ['audit@corp.test'] }),
    { keepOriginal: true, extra: ['audit@corp.test'] });
  assert.deepEqual(planRecipient('bob@corp.test', { ...none, redirectedTo: ['x@corp.test'] }),
    { keepOriginal: false, extra: ['x@corp.test'] });
  assert.deepEqual(planRecipient('bob@corp.test', { ...none, removedRcpts: ['bob@corp.test'] }),
    { keepOriginal: false, extra: [] });
});

test('redirect → delivered only to the redirect target (local + external), loop-guarded', async () => {
  const d = await handleTransportOutcome(
    outcome({ redirectedTo: ['legal@corp.test', 'ext@partner.test'] }), ctx(), deps(),
  );
  assert.equal(d, 'stop');                                        // original not delivered
  assert.deepEqual(calls.local, [{ rcpt: 'legal@corp.test', opts: { skipTransportRules: true } }]);
  assert.deepEqual(calls.external, [['ext@partner.test']]);
});

test('addRecipient (compliance BCC) → original kept + one extra copy per message', async () => {
  const dp = deps();
  const d1 = await handleTransportOutcome(outcome({ additionalRcpts: ['archive@corp.test'] }), ctx({ rcptTo: 'bob@corp.test' }), dp);
  const d2 = await handleTransportOutcome(outcome({ additionalRcpts: ['archive@corp.test'] }), ctx({ rcptTo: 'carol@corp.test' }), dp);
  assert.equal(d1, 'continue');
  assert.equal(d2, 'continue');
  assert.deepEqual(calls.local.map((c) => c.rcpt), ['archive@corp.test']);
});

test('removeRecipient → original recipient dropped, others unaffected', async () => {
  const o = outcome({ removedRcpts: ['bob@corp.test'] });
  assert.equal(await handleTransportOutcome(o, ctx({ rcptTo: 'Bob@corp.test' }), deps()), 'stop');
  assert.equal(await handleTransportOutcome(o, ctx({ rcptTo: 'carol@corp.test' }), deps()), 'continue');
  assert.equal(calls.local.length + calls.external.length, 0);
});

test('no rule matched → continue without side effects', async () => {
  assert.equal(await handleTransportOutcome(outcome({ appliedRuleIds: [] }), ctx(), deps()), 'continue');
  assert.equal(calls.dsn.length + calls.quarantine.length + calls.local.length + calls.external.length, 0);
});

// ── internal "released" marker cannot be forged ──────────────────────────────

test('inbound strip removes a forged quarantine-release header (incl. folded lines, any case)', () => {
  const forged = Buffer.from(
    `x-coremail-quarantine-released: q-123\r\n\tcontinued\r\n${QUARANTINE_RELEASE_HEADER}: q-456\r\n` +
    'Subject: hi\r\n\r\nbody: X-CoreMail-Quarantine-Released: stays\r\n',
  );
  const clean = stripHeaders(forged, INTERNAL_MAIL_HEADERS).toString();
  assert.equal(clean, 'Subject: hi\r\n\r\nbody: X-CoreMail-Quarantine-Released: stays\r\n');
  assert.ok(stripHeaders(RAW, INTERNAL_MAIL_HEADERS) === RAW, 'unchanged buffer is returned as-is');
});

test('a forged release header does not bypass transport-rule quarantine (flag only)', async () => {
  const forged = Buffer.concat([Buffer.from(`${QUARANTINE_RELEASE_HEADER}: q-1\r\n`), RAW]);
  const d = await handleTransportOutcome(outcome({ quarantined: true }), ctx({ raw: forged }), deps());
  assert.equal(d, 'stop');
  assert.equal(calls.quarantine.length, 1);
});
