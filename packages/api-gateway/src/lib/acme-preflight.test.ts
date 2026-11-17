/**
 * Let's Encrypt pre-flight checks (BCP "Check prerequisites"): DNS, IPv6,
 * same address as the server host name, CAA, local token serving, public
 * fetch (warning only — hairpin NAT), external staging validation gating.
 * Fake resolver / serving — no network.
 * Run: node --import tsx --test src/lib/acme-preflight.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCaa, definiteDnsProblem, runPreflight, type PreflightResolver, type CaaRecordLike } from './acme-preflight.js';
import { makeFakeServing } from '../test-support/fake-acme.js';

const err = (code: string) => Object.assign(new Error(code), { code });

function resolver(zone: {
  a?: Record<string, string[]>; aaaa?: Record<string, string[]>;
  caa?: Record<string, CaaRecordLike[] | string>; nx?: string[];
}): PreflightResolver {
  const lookup = <T>(map: Record<string, T> | undefined, n: string): Promise<T> => {
    if (zone.nx?.includes(n)) return Promise.reject(err('ENOTFOUND'));
    const v = map?.[n];
    if (v === undefined) return Promise.reject(err('ENODATA'));
    if (typeof v === 'string') return Promise.reject(err(v));
    return Promise.resolve(v);
  };
  return {
    resolve4: (n) => lookup(zone.a, n),
    resolve6: (n) => lookup(zone.aaaa, n),
    resolveCaa: (n) => lookup(zone.caa as Record<string, CaaRecordLike[] | string> | undefined, n) as Promise<CaaRecordLike[]>,
  };
}

test('CAA: closest record set decides; letsencrypt.org allowed, other CAs only = error, lookup failure = warning', async () => {
  assert.equal((await checkCaa('mail.example.com', resolver({}))).status, 'ok');
  assert.equal((await checkCaa('mail.example.com', resolver({ caa: { 'example.com': [{ critical: 0, issue: 'letsencrypt.org' }] } }))).status, 'ok');
  const other = await checkCaa('mail.example.com', resolver({ caa: { 'example.com': [{ critical: 0, issue: 'sectigo.com' }, { critical: 0, iodef: 'mailto:x@example.com' }] } }));
  assert.equal(other.status, 'error');
  assert.match(other.message, /sectigo\.com/);
  assert.match(other.message, /letsencrypt\.org/);
  // closer set wins over the parent
  assert.equal((await checkCaa('mail.example.com', resolver({ caa: {
    'mail.example.com': [{ critical: 0, issue: 'letsencrypt.org; validationmethods=http-01' }],
    'example.com': [{ critical: 0, issue: 'sectigo.com' }],
  } }))).status, 'ok');
  assert.equal((await checkCaa('mail.example.com', resolver({ caa: { 'example.com': [{ critical: 0, issuewild: 'sectigo.com' }] } }))).status, 'ok', 'issuewild does not restrict normal names');
  assert.equal((await checkCaa('mail.example.com', resolver({ caa: { 'example.com': [{ critical: 128, foo: 'bar' }] } }))).status, 'error');
  assert.equal((await checkCaa('mail.example.com', resolver({ caa: { 'mail.example.com': 'ESERVFAIL' } }))).status, 'warn');
});

test('definite DNS problems (checked before ordering): NXDOMAIN and CAA exclusion, but not lookup timeouts', async () => {
  assert.equal((await definiteDnsProblem('mail.example.com', resolver({ nx: ['mail.example.com'] })))?.code, 'dns');
  assert.equal((await definiteDnsProblem('mail.example.com', resolver({ a: { 'mail.example.com': ['203.0.113.10'] }, caa: { 'example.com': [{ critical: 0, issue: 'digicert.com' }] } })))?.code, 'caa');
  assert.equal(await definiteDnsProblem('mail.example.com', resolver({ a: { 'mail.example.com': 'ETIMEOUT' } as unknown as Record<string, string[]> })), null);
  assert.equal(await definiteDnsProblem('mail.example.com', resolver({ a: { 'mail.example.com': ['203.0.113.10'] } })), null);
});

test('report: DNS/IPv6/server address/CAA/local/public per domain; public failure is only a warning; external test runs', async () => {
  const { serving, served } = makeFakeServing({ public: 'hang' });
  let externalCalled: string[] | null = null;
  const report = await runPreflight(['mail.example.com', 'autodiscover.example.com'], {
    resolver: resolver({
      a: { 'mail.example.com': ['203.0.113.10'], 'autodiscover.example.com': ['198.51.100.7'] },
      aaaa: { 'mail.example.com': ['2001:db8::1'] },
    }),
    serving,
    fetchTimeoutMs: 50,
    serverHost: { hostname: 'mx.example.com', ipv4: ['203.0.113.10'] },
    external: async (d) => { externalCalled = d; return { status: 'ok', message: 'validated' }; },
  });
  const mail = report.domains[0]!;
  const byId = (d: typeof mail, id: string) => d.checks.find(c => c.id === id);
  assert.equal(byId(mail, 'dns')?.status, 'ok');
  assert.equal(byId(mail, 'ipv6')?.status, 'warn');
  assert.equal(byId(mail, 'server-ip')?.status, 'ok');
  assert.equal(byId(mail, 'caa')?.status, 'ok');
  assert.equal(byId(mail, 'local')?.status, 'ok');
  assert.equal(byId(mail, 'public')?.status, 'warn');
  assert.match(byId(mail, 'public')!.message, /own public address/);
  const ad = report.domains[1]!;
  assert.equal(byId(ad, 'server-ip')?.status, 'warn');
  assert.match(byId(ad, 'server-ip')!.message, /198\.51\.100\.7/);
  assert.deepEqual(externalCalled, ['mail.example.com', 'autodiscover.example.com']);
  assert.equal(report.external.status, 'ok');
  assert.equal(report.ok, true, 'warnings do not block');
  assert.equal(served.size, 0, 'self-test tokens removed');
});

test('errors block: missing DNS or a broken local path → external test skipped, ok=false; external failure → ok=false', async () => {
  const { serving } = makeFakeServing({ local: 404, public: 'refused' });
  let called = false;
  const r1 = await runPreflight(['mail.example.com'], {
    resolver: resolver({ a: { 'mail.example.com': ['203.0.113.10'] } }), serving,
    external: async () => { called = true; return { status: 'ok', message: '' }; },
  });
  assert.equal(r1.domains[0]!.checks.find(c => c.id === 'local')?.status, 'error');
  assert.equal(r1.external.status, 'skip');
  assert.equal(called, false);
  assert.equal(r1.ok, false);

  const r2 = await runPreflight(['nx.example.com'], { resolver: resolver({ nx: ['nx.example.com'] }), serving: makeFakeServing().serving });
  assert.equal(r2.domains[0]!.checks.find(c => c.id === 'dns')?.status, 'error');
  assert.equal(r2.ok, false);

  const r3 = await runPreflight(['mail.example.com'], {
    resolver: resolver({ a: { 'mail.example.com': ['203.0.113.10'] } }), serving: makeFakeServing().serving,
    external: async () => ({ status: 'error', code: 'connection', message: 'Let\'s Encrypt could not connect … Connection refused' }),
  });
  assert.equal(r3.external.status, 'error');
  assert.equal(r3.external.code, 'connection');
  assert.equal(r3.ok, false);
});
