/**
 * SPF/DKIM/DMARC run on the real SMTP session (MAIL FROM, HELO, client IP),
 * DMARC policies are applied, local domains cannot be spoofed from outside,
 * and an internal pipeline error defers instead of accepting.
 * Run: node --import tsx --test src/spf-dkim/auth.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { authenticateMail, dmarcDisposition, domainsAligned, isDomainAuthenticated } = await import('./index.js');
const { runContentChecks, decideAuthentication } = await import('../pipeline/index.js');
const { parseContentContext, contentErrorResult } = await import('../content-request.js');

type Auth = Awaited<ReturnType<typeof authenticateMail>>;

/** Fake DNS: TXT records per name, everything else ENOTFOUND. */
function dns(records: Record<string, string>) {
  return async (name: string, rr: string): Promise<unknown> => {
    const v = records[name.toLowerCase()];
    if (rr === 'TXT' && v !== undefined) return [[v]];
    const err = new Error(`no ${rr} for ${name}`) as Error & { code: string };
    err.code = 'ENOTFOUND';
    throw err;
  };
}

const MSG = (from: string) => Buffer.from(`From: ${from}\r\nTo: u@corp.test\r\nSubject: hi\r\nMessage-ID: <1@x>\r\n\r\nbody\r\n`);

test('SPF is evaluated for the envelope MAIL FROM and client IP (not our own hostname)', async () => {
  const resolver = dns({
    'sender.example': 'v=spf1 ip4:203.0.113.9 -all',
    '_dmarc.sender.example': 'v=DMARC1; p=reject',
  });
  const pass = await authenticateMail(MSG('a@sender.example'), { ip: '203.0.113.9', helo: 'mx.sender.example', mailFrom: 'a@sender.example', mta: 'mx.corp.test' }, resolver);
  assert.equal(pass.spf, 'pass');
  assert.equal(pass.spfDomain, 'sender.example');
  assert.equal(pass.dmarc, 'pass');
  assert.deepEqual(pass.verifiedDomains.sort(), ['sender.example']);
  assert.match(pass.authHeaders, /^Received-SPF: pass/m);
  assert.match(pass.authHeaders, /^Authentication-Results: mx\.corp\.test;/m);

  const fail = await authenticateMail(MSG('a@sender.example'), { ip: '198.51.100.66', helo: 'evil.example', mailFrom: 'a@sender.example', mta: 'mx.corp.test' }, resolver);
  assert.equal(fail.spf, 'fail');
  assert.equal(fail.dmarc, 'fail');
  assert.equal(fail.dmarcPolicy, 'reject');
  assert.deepEqual(fail.verifiedDomains, []);
  assert.equal(dmarcDisposition(fail), 'reject');
});

test('DMARC disposition follows the published policy; none/temperror never reject', () => {
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'quarantine' }), 'quarantine');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: 'none' }), 'none');
  assert.equal(dmarcDisposition({ dmarc: 'fail', dmarcPolicy: null }), 'none');
  assert.equal(dmarcDisposition({ dmarc: 'pass', dmarcPolicy: 'reject' }), 'none');
  assert.equal(dmarcDisposition({ dmarc: 'temperror', dmarcPolicy: 'reject' }), 'none');
  assert.equal(dmarcDisposition({ dmarc: 'none', dmarcPolicy: null }), 'none');
});

test('relaxed alignment helper', () => {
  assert.equal(domainsAligned('corp.test', 'corp.test'), true);
  assert.equal(domainsAligned('corp.test', 'mail.corp.test'), true);
  assert.equal(domainsAligned('mail.corp.test', 'corp.test'), true);
  assert.equal(domainsAligned('corp.test', 'corp.test.evil.example'), false);
  assert.equal(domainsAligned('corp.test', 'evilcorp.test'), false);
  assert.equal(isDomainAuthenticated('corp.test', []), false);
});

const baseAuth = (over: Partial<Auth> = {}): Auth => ({
  spf: 'none', dkim: 'none', dmarc: 'none', arc: 'none', dmarcPolicy: null, headerFromDomain: null,
  spfDomain: null, dkimDomains: [], verifiedDomains: [], summary: 's', authHeaders: 'Authentication-Results: mx.corp.test; none\r\n', ...over,
});
const isLocal = async (d: string) => d === 'corp.test';
const ctx = { senderIp: '198.51.100.66', mailFrom: 'x@ext.example', rcptTo: 'u@corp.test' };

test('anti-spoofing: a local domain in MAIL FROM or header From needs an aligned pass', async () => {
  // header From = local domain, nothing authenticated → reject
  const r1 = await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test' }), ctx, isLocal);
  assert.ok(r1 && 'action' in r1 && r1.action === 'reject');
  // MAIL FROM = local domain → reject
  const r2 = await decideAuthentication(baseAuth(), { ...ctx, mailFrom: 'ceo@CORP.test' }, isLocal);
  assert.ok(r2 && 'action' in r2 && r2.action === 'reject');
  // SPF pass for an unrelated domain does not help
  const r3 = await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test', spf: 'pass', spfDomain: 'ext.example', verifiedDomains: ['ext.example'] }), ctx, isLocal);
  assert.ok(r3 && 'action' in r3 && r3.action === 'reject');
  // our own DKIM signature (forwarded back to us) → fine
  assert.equal(await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test', dkim: 'pass', dkimDomains: ['corp.test'], verifiedDomains: ['corp.test'] }), ctx, isLocal), null);
  // authenticated SMTP session → not checked here
  assert.equal(await decideAuthentication(baseAuth({ headerFromDomain: 'corp.test' }), { ...ctx, authUser: 'ceo@corp.test' }, isLocal), null);
  // foreign domains without DMARC record → continue
  assert.equal(await decideAuthentication(baseAuth({ headerFromDomain: 'ext.example' }), ctx, isLocal), null);
});

test('DMARC p=reject fails with reject, p=quarantine delivers to Junk with the AR header', async () => {
  const deps = (auth: Auth) => ({
    dnsbl: async () => { throw new Error('unused'); },
    country: async () => { throw new Error('unused'); },
    greylist: async () => { throw new Error('unused'); },
    authenticate: async (_raw: Buffer, input: unknown) => { seen.push(input); return auth; },
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [] }),
    clamav: async () => ({ status: 'clean' as const, clean: true }),
    rspamd: async (_raw: Buffer, meta: unknown) => { rspamdMeta.push(meta); return { score: 1, action: 'no action' as const, symbols: {}, isSpam: false }; },
    isLocalDomain: isLocal,
  }) as never;
  const seen: unknown[] = [];
  const rspamdMeta: unknown[] = [];
  const fullCtx = { ...ctx, helo: 'mx.ext.example', hostname: 'mx.corp.test', rcpts: ['u@corp.test', 'v@corp.test'] };

  const rej = await runContentChecks(MSG('a@ext.example'), fullCtx, {}, deps(baseAuth({ dmarc: 'fail', dmarcPolicy: 'reject', headerFromDomain: 'ext.example' })));
  assert.equal(rej.action, 'reject');
  assert.match(rej.reason, /DMARC/);
  assert.deepEqual(seen[0], { ip: '198.51.100.66', helo: 'mx.ext.example', mailFrom: 'x@ext.example', mta: 'mx.corp.test' });

  const q = await runContentChecks(MSG('a@ext.example'), fullCtx, {}, deps(baseAuth({ dmarc: 'fail', dmarcPolicy: 'quarantine', headerFromDomain: 'ext.example' })));
  assert.equal(q.action, 'accept');
  assert.equal(q.junkFolder, true);
  assert.match(q.authHeaders ?? '', /^Authentication-Results: mx\.corp\.test;/);

  const ok = await runContentChecks(MSG('a@ext.example'), fullCtx, {}, deps(baseAuth({ dmarc: 'pass', headerFromDomain: 'ext.example', verifiedDomains: ['ext.example'] })));
  assert.equal(ok.action, 'accept');
  assert.equal(ok.junkFolder, false);
  assert.deepEqual(ok.verifiedDomains, ['ext.example']);
  assert.deepEqual(rspamdMeta.at(-1), { ip: '198.51.100.66', helo: 'mx.ext.example', from: 'x@ext.example', rcpts: ['u@corp.test', 'v@corp.test'], hostname: 'mx.corp.test' });
});

test('X-Filter-Context validation', () => {
  assert.equal(parseContentContext('nope'), null);
  assert.equal(parseContentContext('{"senderIp":"not-an-ip"}'), null);
  assert.deepEqual(parseContentContext(JSON.stringify({ senderIp: '192.0.2.1', mailFrom: 'a@b.c', rcpts: ['x@y.z', 5], helo: 'h', hostname: 'mx', authUser: 7 })),
    { senderIp: '192.0.2.1', mailFrom: 'a@b.c', rcptTo: 'x@y.z', rcpts: ['x@y.z'], helo: 'h', hostname: 'mx' });
});

test('an unexpected pipeline error defers by default; SECURITY_FILTER_FAIL_OPEN=true accepts', () => {
  assert.equal(contentErrorResult({}).action, 'defer');
  assert.equal(contentErrorResult({ SECURITY_FILTER_FAIL_OPEN: 'false' }).action, 'defer');
  assert.equal(contentErrorResult({ SECURITY_FILTER_FAIL_OPEN: 'true' }).action, 'accept');
});
