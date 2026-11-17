/**
 * 9.3 dns-check: an MX that is an IP literal or a CNAME is an error with the
 * suggestion mail.<domain>; a host with an A record is fine. DNS is faked.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/domains-mx.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

const { generateDkimPrivateKey } = await import('../../lib/dkim.js');
const dkimKey = generateDkimPrivateKey();
installFakePrisma({
  user: { findUnique: () => ({ role: 'ORGANIZATION_MANAGEMENT', active: true }) },
  domain: { findUnique: () => ({ id: 'd1', name: 'example.com', dkimSelector: 'coremail', dkimPrivateKey: dkimKey, active: true, primary: true }) },
  serverSettings: { findUnique: () => ({ publicHostname: 'mail.example.com', useHttps: true, httpPort: 443 }) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const domains = await import('./domains.js');

const notFound = () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
const noData = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
let mx: { priority: number; exchange: string }[] = [];
const cnames: Record<string, string[]> = {};
const fakeDns: import('./domains.js').DnsResolverLike = {
  resolve4: (n) => (n === 'mail.example.com' ? Promise.resolve(['203.0.113.5']) : notFound()),
  resolveMx: () => (mx.length ? Promise.resolve(mx) : notFound()),
  resolveTxt: () => notFound(),
  resolveCname: (n) => (cnames[n] ? Promise.resolve(cnames[n]!) : noData()),
  resolveSrv: () => notFound(),
  reverse: () => notFound(),
};

const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's-admin', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  domains.setDnsResolverForTests(fakeDns);
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use('/api/v1/admin/domains', requireAuth, domains.adminDomainsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { domains.setDnsResolverForTests(null); server?.close(); });

async function mxRecord(): Promise<{ ok: boolean; found: string | null; error?: string; suggestion?: string }> {
  const r = await fetch(`${base}/api/v1/admin/domains/d1/dns-check`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 200);
  return ((await r.json()) as { records: { mx: never } }).records.mx;
}

test('MX pointing to an IP literal → error with suggestion mail.<domain>', async () => {
  mx = [{ priority: 10, exchange: '203.0.113.5' }];
  const rec = await mxRecord();
  assert.equal(rec.ok, false);
  assert.equal(rec.found, '10 203.0.113.5');
  assert.match(rec.error!, /IP address/);
  assert.equal(rec.suggestion, 'mail.example.com');
});

test('MX pointing to a CNAME → error naming the alias target', async () => {
  mx = [{ priority: 10, exchange: 'mx.example.com' }];
  cnames['mx.example.com'] = ['mail.example.com'];
  const rec = await mxRecord();
  assert.equal(rec.ok, false);
  assert.match(rec.error!, /is a CNAME \(→ mail\.example\.com\)/);
  assert.equal(rec.suggestion, 'mail.example.com');
});

test('MX naming a host with an A record is ok', async () => {
  mx = [{ priority: 10, exchange: 'mail.example.com' }];
  const rec = await mxRecord();
  assert.equal(rec.ok, true);
  assert.equal(rec.error, undefined);
});

test('mxTargetProblem: IPv6 literal and lower-priority offenders are detected too', async () => {
  const r1 = await domains.mxTargetProblem(fakeDns, [{ priority: 10, exchange: '2001:db8::1' }], 'example.com');
  assert.match(r1!.error, /IP address/);
  const r2 = await domains.mxTargetProblem(fakeDns, [
    { priority: 10, exchange: 'mail.example.com' }, { priority: 20, exchange: '198.51.100.1.' },
  ], 'example.com');
  assert.match(r2!.error, /198\.51\.100\.1 is an IP address/);
  assert.equal(await domains.mxTargetProblem(fakeDns, [{ priority: 10, exchange: 'mail.example.com' }], 'example.com'), null);
});
