/**
 * v8.1 review fixes: From-header shape (multiple From = DMARC bypass), local
 * anti-spoofing that follows the local domain's own policy, LOCAL_SPOOF_ALLOW,
 * ARC_TRUSTED_SEALERS and the DMARC pct sampling.
 * Run: node --import tsx --test src/spf-dkim/local-spoof.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const {
  authenticateMail, dmarcDisposition, applyDmarcPct, fromHeaderShape, countMailboxes,
} = await import('./index.js');
const { decideAuthentication, loadSpoofPolicyOptions, runContentChecks, arcOverride } = await import('../pipeline/index.js');
const { parseContentContext } = await import('../content-request.js');

type Auth = Awaited<ReturnType<typeof authenticateMail>>;

const baseAuth = (over: Partial<Auth> = {}): Auth => ({
  spf: 'none', dkim: 'none', dmarc: 'none', arc: 'none', dmarcPolicy: null, headerFromDomain: null,
  spfDomain: null, dkimDomains: [], verifiedDomains: [], summary: 's',
  authHeaders: 'Authentication-Results: mx.corp.test; none\r\n',
  fromHeaderFields: 1, fromMailboxes: 1, ...over,
});
const isLocal = async (d: string) => d === 'corp.test';
const ctx = { senderIp: '198.51.100.66', mailFrom: 'x@ext.example', rcptTo: 'u@corp.test' };
const policy = loadSpoofPolicyOptions({});

function dns(records: Record<string, string>) {
  return async (name: string, rr: string): Promise<unknown> => {
    const v = records[name.toLowerCase()];
    if (rr === 'TXT' && v !== undefined) return [[v]];
    const err = new Error(`no ${rr} for ${name}`) as Error & { code: string };
    err.code = 'ENOTFOUND';
    throw err;
  };
}

// ── Finding 1: multiple / missing From ──────────────────────────────────────

test('From header shape: fields and mailboxes are counted (quotes, comments, groups)', () => {
  const shape = (h: string) => fromHeaderShape(Buffer.from(`${h}\r\nSubject: x\r\n\r\nbody\r\n`));
  assert.deepEqual(shape('From: ceo@corp.test'), { fromHeaderFields: 1, fromMailboxes: 1 });
  assert.deepEqual(shape('From: ceo@corp.test, x@evil.test'), { fromHeaderFields: 1, fromMailboxes: 2 });
  assert.deepEqual(shape('From: "Doe, John" <j@ext.example>'), { fromHeaderFields: 1, fromMailboxes: 1 });
  assert.deepEqual(shape('From: j@ext.example (a, b)'), { fromHeaderFields: 1, fromMailboxes: 1 });
  assert.deepEqual(shape('From: a@corp.test\r\nFrom: b@evil.test'), { fromHeaderFields: 2, fromMailboxes: 2 });
  assert.deepEqual(shape('From: undisclosed:;'), { fromHeaderFields: 1, fromMailboxes: 0 });
  assert.deepEqual(shape('From: grp: a@x.test, b@y.test;'), { fromHeaderFields: 1, fromMailboxes: 2 });
  assert.deepEqual(shape('From: <ceo@corp.test>,\r\n <x@evil.test>'), { fromHeaderFields: 1, fromMailboxes: 2 });
  assert.deepEqual(shape('To: a@b.test'), { fromHeaderFields: 0, fromMailboxes: 0 });
  assert.equal(countMailboxes(''), 0);
});

test('multiple From mailboxes are rejected with "multiple or missing From" (real mailauth run)', async () => {
  const resolver = dns({ '_dmarc.corp.test': 'v=DMARC1; p=reject', 'evil.test': 'v=spf1 ip4:198.51.100.66 -all' });
  const raw = Buffer.from('From: ceo@corp.test, x@evil.test\r\nTo: u@corp.test\r\nSubject: pay\r\n\r\nbody\r\n');
  const auth = await authenticateMail(raw, { ip: '198.51.100.66', helo: 'evil.test', mailFrom: 'x@evil.test', mta: 'mx.corp.test' }, resolver);
  assert.equal(auth.headerFromDomain, null);
  assert.equal(auth.fromMailboxes, 2);
  for (const opts of [policy, loadSpoofPolicyOptions({ LOCAL_SPOOF_ACTION: 'junk' })]) {
    const r = await decideAuthentication(auth, { ...ctx, mailFrom: 'x@evil.test' }, isLocal, opts);
    assert.ok(r && 'action' in r && r.action === 'reject');
    assert.equal(r.reason, 'multiple or missing From');
  }
  // two From fields, and a missing From
  for (const over of [{ fromHeaderFields: 2 }, { fromHeaderFields: 0, fromMailboxes: 0 }]) {
    const r = await decideAuthentication(baseAuth(over), ctx, isLocal, policy);
    assert.ok(r && 'action' in r && r.reason === 'multiple or missing From');
  }
  // authenticated submission is not affected
  assert.equal(await decideAuthentication(auth, { ...ctx, authUser: 'ceo@corp.test' }, isLocal, policy), null);
});

// ── Finding 2: local anti-spoofing follows our own policy ────────────────────

test('LOCAL_SPOOF_ACTION=policy: p=reject → 550, p=quarantine / p=none / no record → Junk with a tag', async () => {
  const header = (p: Auth['dmarcPolicy'], extra: Partial<Auth> = {}) =>
    decideAuthentication(baseAuth({ headerFromDomain: 'corp.test', dmarc: p ? 'fail' : 'none', dmarcPolicy: p, ...extra }), ctx, isLocal, policy);
  const rej = await header('reject');
  assert.ok(rej && 'action' in rej && rej.action === 'reject');
  for (const p of ['quarantine', 'none', null] as const) {
    assert.deepEqual(await header(p), { junk: true, cause: 'local-spoof', spoofDomain: 'corp.test' }, String(p));
  }
  // pct=0 on our own p=reject record → sampled down → Junk
  assert.deepEqual(await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test', dmarc: 'fail', dmarcPolicy: 'reject', dmarcPct: 0 }), ctx, isLocal, policy),
    { junk: true, cause: 'local-spoof', spoofDomain: 'corp.test' });
  // MAIL FROM only: SPF hard fail of our domain → 550, otherwise Junk
  const env = (spf: Auth['spf']) => decideAuthentication(baseAuth({ headerFromDomain: 'ext.example', spf }), { ...ctx, mailFrom: 'bounce@corp.test' }, isLocal, policy);
  const envFail = await env('fail');
  assert.ok(envFail && 'action' in envFail && envFail.action === 'reject');
  assert.deepEqual(await env('softfail'), { junk: true, cause: 'local-spoof', spoofDomain: 'corp.test' });
  // authenticated (aligned) → nothing to do
  assert.equal(await header('reject', { dkim: 'pass', dkimDomains: ['corp.test'], verifiedDomains: ['corp.test'], dmarc: 'pass' }), null);
});

test('LOCAL_SPOOF_ACTION=junk never rejects a local claim (also not via our own p=reject)', async () => {
  const junk = loadSpoofPolicyOptions({ LOCAL_SPOOF_ACTION: 'junk' });
  assert.deepEqual(
    await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test', dmarc: 'fail', dmarcPolicy: 'reject', spf: 'fail' }), { ...ctx, mailFrom: 'a@corp.test' }, isLocal, junk),
    { junk: true, cause: 'local-spoof', spoofDomain: 'corp.test' },
  );
  assert.equal(loadSpoofPolicyOptions({ LOCAL_SPOOF_ACTION: 'bogus' }).action, 'policy');
  assert.deepEqual(loadSpoofPolicyOptions({ LOCAL_SPOOF_ACTION: 'bogus' }).invalid, ['LOCAL_SPOOF_ACTION=bogus']);
});

test('LOCAL_SPOOF_ALLOW: trusted IPs/CIDRs and authenticated third-party domains are exempt', async () => {
  const opts = loadSpoofPolicyOptions({ LOCAL_SPOOF_ALLOW: '203.0.113.0/24, 2001:db8::1, sendgrid.net, not a domain!' });
  assert.deepEqual(opts.invalid, ['not', 'a', 'domain!']);
  const auth = baseAuth({ headerFromDomain: 'corp.test', dmarc: 'fail', dmarcPolicy: 'reject' });
  assert.equal(await decideAuthentication(auth, { ...ctx, senderIp: '203.0.113.7' }, isLocal, opts), null);
  assert.equal(await decideAuthentication(auth, { ...ctx, senderIp: '::ffff:203.0.113.7' }, isLocal, opts), null);
  assert.equal(await decideAuthentication(auth, { ...ctx, senderIp: '2001:db8::1' }, isLocal, opts), null);
  // DKIM pass for a subdomain of an allowed domain
  assert.equal(await decideAuthentication({ ...auth, dkim: 'pass', dkimDomains: ['em.sendgrid.net'], verifiedDomains: ['em.sendgrid.net'] }, ctx, isLocal, opts), null);
  // an unlisted IP and an unauthenticated claim of the allowed domain do not count
  const other = await decideAuthentication(auth, { ...ctx, senderIp: '198.51.100.1' }, isLocal, opts);
  assert.ok(other && 'action' in other && other.action === 'reject');
  const forged = await decideAuthentication({ ...auth, spfDomain: 'sendgrid.net', spf: 'fail' }, ctx, isLocal, opts);
  assert.ok(forged && 'action' in forged && forged.action === 'reject');
});

test('ARC_TRUSTED_SEALERS: a passing chain of a trusted sealer overrides the local check and DMARC rejection', async () => {
  const opts = loadSpoofPolicyOptions({ ARC_TRUSTED_SEALERS: 'google.com, lists.example.org' });
  const local = baseAuth({ headerFromDomain: 'corp.test', dmarc: 'fail', dmarcPolicy: 'reject', arc: 'pass', arcSealer: 'google.com' });
  assert.equal(await decideAuthentication(local, ctx, isLocal, opts), null);
  const foreign = baseAuth({ headerFromDomain: 'ext.example', dmarc: 'fail', dmarcPolicy: 'reject', arc: 'pass', arcSealer: 'lists.example.org' });
  assert.equal(await decideAuthentication(foreign, ctx, isLocal, opts), null);
  // untrusted sealer, failed chain, or the sealer saw a DMARC fail → no override
  for (const over of [{ arcSealer: 'evil.example' }, { arc: 'fail' as const }, { arcDmarc: 'fail' }]) {
    const r = await decideAuthentication({ ...foreign, ...over }, ctx, isLocal, opts);
    assert.ok(r && 'action' in r && r.action === 'reject', JSON.stringify(over));
  }
  assert.equal(arcOverride(foreign, []), false);
});

test('the Junk verdict for a local spoof carries an Authentication-Results tag', async () => {
  const deps = {
    authenticate: async () => baseAuth({ headerFromDomain: 'corp.test' }),
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [] }),
    clamav: async () => ({ status: 'clean' as const, clean: true }),
    rspamd: async () => ({ score: 1, action: 'no action' as const, symbols: {}, isSpam: false }),
    isLocalDomain: isLocal,
    spoofOptions: policy,
  } as never;
  const r = await runContentChecks(Buffer.from('From: a@corp.test\r\n\r\nx'), { ...ctx, hostname: 'mx.corp.test' }, {}, deps);
  assert.equal(r.action, 'accept');
  assert.equal(r.junkFolder, true);
  assert.match(r.authHeaders ?? '', /^Authentication-Results: mx\.corp\.test; x-local-spoof=fail .*header\.from=corp\.test\r\n/m);
});

// ── Finding 4: DMARC pct ─────────────────────────────────────────────────────

test('DMARC pct samples the policy and steps down one level when not sampled (RFC 7489 §6.6.4)', () => {
  const hi = () => 0.99; // not sampled for pct < 100
  const lo = () => 0;    // always sampled for pct > 0
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'reject', dmarcPct: 50 }, lo), 'reject');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'reject', dmarcPct: 50 }, hi), 'quarantine');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'quarantine', dmarcPct: 50 }, hi), 'none');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'reject', dmarcPct: 0 }, lo), 'quarantine');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'reject', dmarcPct: 100 }, hi), 'reject');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'reject' }, hi), 'reject'); // absent = 100
  assert.equal(dmarcDisposition({ dmarc: 'pass', dmarcPolicy: 'reject', dmarcPct: 100 }, lo), 'none');
  assert.equal(applyDmarcPct('none', 10, lo), 'none');
  // boundary: rng*100 < pct
  assert.equal(applyDmarcPct('reject', 30, () => 0.2999), 'reject');
  assert.equal(applyDmarcPct('reject', 30, () => 0.3), 'quarantine');
});

test('pct is read from the DMARC record', async () => {
  const resolver = dns({ 'sender.example': 'v=spf1 -all', '_dmarc.sender.example': 'v=DMARC1; p=reject; pct=20' });
  const auth = await authenticateMail(Buffer.from('From: a@sender.example\r\nSubject: x\r\n\r\nb\r\n'),
    { ip: '198.51.100.66', helo: 'evil.example', mailFrom: 'a@sender.example', mta: 'mx.corp.test' }, resolver);
  assert.equal(auth.dmarc, 'fail');
  assert.equal(auth.dmarcPct, 20);
  const r = await decideAuthentication(auth, ctx, isLocal, { ...policy, rng: () => 0.5 });
  assert.deepEqual(r, { junk: true, cause: 'dmarc' });
});

// ── Finding 10: capped recipient list in X-Filter-Context ────────────────────

test('X-Filter-Context carries rcptCount next to a capped rcpts list', () => {
  const parsed = parseContentContext(JSON.stringify({ senderIp: '192.0.2.1', rcpts: ['a@b.c'], rcptCount: 5000 }));
  assert.equal(parsed?.rcptCount, 5000);
  assert.equal(parseContentContext(JSON.stringify({ senderIp: '192.0.2.1', rcptCount: -1 }))?.rcptCount, undefined);
});
