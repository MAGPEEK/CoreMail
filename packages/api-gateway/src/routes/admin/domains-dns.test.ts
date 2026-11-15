/**
 * dns-check (v8.1): client auto-setup records (RFC 6186/8314 SRV, _autodiscover._tcp,
 * autoconfig host, RFC 6764 CalDAV/CardDAV SRV + TXT path) are reported as
 * `recommended`, next to the unchanged required records. DNS is faked.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/domains-dns.test.ts
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
  domain: {
    findUnique: () => ({ id: 'd1', name: 'example.com', dkimSelector: 'coremail', dkimPrivateKey: dkimKey, active: true, primary: true }),
  },
  serverSettings: { findUnique: () => ({ publicHostname: 'mail.example.com', useHttps: true, httpPort: 443 }) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const domains = await import('./domains.js');

type Srv = { priority: number; weight: number; port: number; name: string };
const notFound = () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
let zone: { srv: Record<string, Srv[]>; txt: Record<string, string[][]>; cname: Record<string, string[]>; a: Record<string, string[]> };

const fakeDns: import('./domains.js').DnsResolverLike = {
  resolve4: (n) => (zone.a[n] ? Promise.resolve(zone.a[n]!) : notFound()),
  resolveMx: () => notFound(),
  resolveTxt: (n) => (zone.txt[n] ? Promise.resolve(zone.txt[n]!) : notFound()),
  resolveCname: (n) => (zone.cname[n] ? Promise.resolve(zone.cname[n]!) : notFound()),
  resolveSrv: (n) => (zone.srv[n] ? Promise.resolve(zone.srv[n]!) : notFound()),
  reverse: () => notFound(),
};

const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's-admin', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  domains.setDnsResolverForTests(fakeDns);
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/domains', requireAuth, domains.adminDomainsRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { domains.setDnsResolverForTests(null); server?.close(); });

type Rec = { type: string; name: string; expected: string; ok: boolean; found: string | null; warning?: string; recommended?: boolean };
async function dnsCheck(): Promise<{ records: Record<string, Rec>; clientSetup: Record<string, Rec>; certificateHostnames: string[] }> {
  const r = await fetch(`${base}/api/v1/admin/domains/d1/dns-check`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 200);
  return r.json() as never;
}

const EXPECTED: Record<string, [string, string, string]> = {
  submissions:     ['SRV',   '_submissions._tcp', '0 1 465 mail.example.com.'],
  submission:      ['SRV',   '_submission._tcp',  '0 1 587 mail.example.com.'],
  imaps:           ['SRV',   '_imaps._tcp',       '0 1 993 mail.example.com.'],
  imap:            ['SRV',   '_imap._tcp',        '0 1 143 mail.example.com.'],
  pop3s:           ['SRV',   '_pop3s._tcp',       '0 1 995 mail.example.com.'],
  autodiscoverSrv: ['SRV',   '_autodiscover._tcp', '0 0 443 mail.example.com.'],
  autoconfig:      ['CNAME', 'autoconfig',        'mail.example.com'],
  caldavs:         ['SRV',   '_caldavs._tcp',     '0 1 443 mail.example.com.'],
  caldavsPath:     ['TXT',   '_caldavs._tcp',     'path=/dav/'],
  carddavs:        ['SRV',   '_carddavs._tcp',    '0 1 443 mail.example.com.'],
  carddavsPath:    ['TXT',   '_carddavs._tcp',    'path=/dav/'],
};

test('empty zone: all client-setup records reported as recommended + missing (no warning)', async () => {
  zone = { srv: {}, txt: {}, cname: {}, a: {} };
  const body = await dnsCheck();
  assert.deepEqual(Object.keys(body.clientSetup).sort(), Object.keys(EXPECTED).sort());
  for (const [key, [type, name, expected]] of Object.entries(EXPECTED)) {
    const r = body.clientSetup[key]!;
    assert.deepEqual([r.type, r.name, r.expected], [type, name, expected], key);
    assert.equal(r.recommended, true, key);
    assert.equal(r.ok, false, key);
    assert.equal(r.found, null, key);
    assert.equal(r.warning, undefined, key);
  }
  // required records unchanged (BCP VISIBLE_DNS_KEYS stays consistent)
  assert.deepEqual(Object.keys(body.records).sort(), ['a', 'autodiscover', 'dkim', 'dmarc', 'mx', 'ptr', 'spf']);
  assert.ok(Object.values(body.records).every((r) => r.recommended === undefined));
  assert.deepEqual(body.certificateHostnames, ['mail.example.com', 'autodiscover.example.com', 'autoconfig.example.com']);
});

test('correct zone: every client-setup record is ok', async () => {
  const s = (port: number, w = 1): Srv[] => [{ priority: 0, weight: w, port, name: 'MAIL.example.com' }];
  zone = {
    srv: {
      '_submissions._tcp.example.com': s(465), '_submission._tcp.example.com': s(587),
      '_imaps._tcp.example.com': s(993), '_imap._tcp.example.com': s(143), '_pop3s._tcp.example.com': s(995),
      '_autodiscover._tcp.example.com': s(443, 0),
      '_caldavs._tcp.example.com': s(443), '_carddavs._tcp.example.com': s(443),
    },
    txt: { '_caldavs._tcp.example.com': [['path=/dav/']], '_carddavs._tcp.example.com': [['path=/dav']] },
    cname: { 'autoconfig.example.com': ['mail.example.com.'] },
    a: {},
  };
  const body = await dnsCheck();
  for (const key of Object.keys(EXPECTED)) assert.equal(body.clientSetup[key]!.ok, true, key);
  assert.equal(body.clientSetup['imaps']!.found, '0 1 993 mail.example.com.');
});

test('wrong values: ok=false with a warning (shown yellow, never red)', async () => {
  zone = {
    srv: { '_imaps._tcp.example.com': [{ priority: 0, weight: 1, port: 993, name: 'other.host' }] },
    txt: { '_caldavs._tcp.example.com': [['path=/caldav/']] },
    cname: { 'autoconfig.example.com': ['elsewhere.example.net'] },
    a: {},
  };
  const { clientSetup } = await dnsCheck();
  assert.equal(clientSetup['imaps']!.ok, false);
  assert.match(clientSetup['imaps']!.warning ?? '', /mail\.example\.com:993/);
  assert.equal(clientSetup['caldavsPath']!.ok, false);
  assert.ok(clientSetup['caldavsPath']!.warning);
  assert.equal(clientSetup['autoconfig']!.ok, false);
  assert.match(clientSetup['autoconfig']!.warning ?? '', /elsewhere/);
});

test('autoconfig as an A record pointing at the server is accepted', async () => {
  zone = { srv: {}, txt: {}, cname: {}, a: { 'autoconfig.example.com': ['192.0.2.10'], 'mail.example.com': ['192.0.2.10'] } };
  const { clientSetup } = await dnsCheck();
  assert.equal(clientSetup['autoconfig']!.ok, true);
  assert.equal(clientSetup['autoconfig']!.found, '192.0.2.10');
});

test('HTTPS SRV records follow a configured HTTPS port', async () => {
  zone = { srv: {}, txt: {}, cname: {}, a: {} };
  const r = await domains.checkClientSetupRecords(fakeDns, 'example.com', 'mail.example.com', 8443);
  assert.equal(r['caldavs']!.expected, '0 1 8443 mail.example.com.');
  assert.equal(r['autodiscoverSrv']!.expected, '0 0 8443 mail.example.com.');
  assert.equal(r['imaps']!.expected, '0 1 993 mail.example.com.');
});
