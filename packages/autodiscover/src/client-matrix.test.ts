/**
 * Autodiscover client matrix: request shapes as sent by Outlook 2010, 2013,
 * 2016, 2019, 2021 and Microsoft 365 (classic Win32), iOS Mail and Android
 * ActiveSync clients — paths, methods, headers and bodies as described in the
 * public MS-OXDSCLI / MS-OXDISCO / MS-ASCMD specifications and typical client
 * behaviour. Every client must
 *  - get 401 + `WWW-Authenticate: Basic` before any answer,
 *  - get IMAP/SMTP (Outlook schema) or the ActiveSync URL (mobilesync schema)
 *    after authenticating — never EXCH/EXPR/MAPI blocks,
 *  - see endpoints that match the enabled listeners (BCP → Dienste),
 *  - learn nothing about other or unknown accounts.
 * Express app on loopback, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test src/client-matrix.test.ts (in packages/autodiscover)
 */
import { test, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const SETTINGS = {
  owaUrl: 'https://mail.example.com/owa/', easUrl: 'https://mail.example.com/Microsoft-Server-ActiveSync',
  autodiscoverBase: 'https://autodiscover.example.com', imapHost: 'mail.example.com', imapPort: 993, imapSsl: true,
  smtpHost: 'mail.example.com', smtpPort: 587, smtpTls: true,
  pop3Host: 'mail.example.com', pop3Port: 995, pop3Ssl: true, publicHostname: 'mail.example.com',
};
type Listener = { service: string; port: number; ssl: boolean; active: boolean };
const DEFAULT_LISTENERS: Listener[] = [
  { service: 'SMTP_RECEIVE', port: 25, ssl: false, active: true },
  { service: 'SMTP_RECEIVE', port: 465, ssl: true, active: true },
  { service: 'SMTP_RECEIVE', port: 587, ssl: false, active: true },
  { service: 'IMAP', port: 143, ssl: false, active: true },
  { service: 'IMAP', port: 993, ssl: true, active: true },
  { service: 'POP3', port: 110, ssl: false, active: true },
  { service: 'POP3', port: 995, ssl: true, active: true },
];
const state = { listeners: DEFAULT_LISTENERS.map((l) => ({ ...l })), listenersDown: false };

const user = { id: 'cuidAlice', email: 'alice@example.com', displayName: 'Alice', domainId: 'd1', role: 'USER', active: true, passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb1' } };
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: { findFirst: async ({ where }: { where: { email: string } }) => (where.email === user.email ? user : null) },
  appPassword: { findMany: async () => [], update: async () => ({}) },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
  emailAlias: { findFirst: async ({ where }: { where: { address: string; targetUserId: string } }) => (where.address === 'info@example.com' && where.targetUserId === user.id ? { id: 'a1' } : null) },
  serverSettings: { findUnique: async () => ({ ...SETTINGS }) },
  serviceListener: {
    findMany: async () => {
      if (state.listenersDown) throw new Error('db down');
      return state.listeners.map((l) => ({ ...l }));
    },
  },
  systemLog: { create: async () => ({}) },
};
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { createAutodiscoverApp } = await import('./app.js');
const { NS_OUTLOOK, NS_MOBILESYNC, plainHttpRedirectTarget } = await import('./v1.js');
const settings = await import('./settings.js');

const server = createAutodiscoverApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

beforeEach(() => {
  settings.resetSettingsCacheForTests();
  state.listeners = DEFAULT_LISTENERS.map((l) => ({ ...l }));
  state.listenersDown = false;
});

const basic = (login = 'alice@example.com', pw = 'pw') => `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}`;

const OUTLOOK_REQ = (email: string) => `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>${NS_OUTLOOK}</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;
const MOBILESYNC_REQ = (email: string) => `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>${NS_MOBILESYNC}</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;

interface ClientShape {
  name: string;
  path: string;
  userAgent: string;
  contentType: string | null;
  extraHeaders?: Record<string, string>;
  body: (email: string) => string;
  schema: 'outlook' | 'mobilesync';
}

const CLIENTS: ClientShape[] = [
  { name: 'Outlook 2010', path: '/autodiscover/autodiscover.xml', schema: 'outlook', contentType: 'text/xml',
    userAgent: 'Microsoft Office/14.0 (Windows NT 6.1; Microsoft Outlook 14.0.7268; Pro)', body: OUTLOOK_REQ },
  { name: 'Outlook 2013', path: '/Autodiscover/Autodiscover.xml', schema: 'outlook', contentType: 'text/xml',
    userAgent: 'Microsoft Office/15.0 (Windows NT 10.0; Microsoft Outlook 15.0.5579; Pro)', body: OUTLOOK_REQ },
  { name: 'Outlook 2016', path: '/autodiscover/autodiscover.xml', schema: 'outlook', contentType: 'text/xml; charset=utf-8',
    userAgent: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.5452; Pro)',
    extraHeaders: { 'X-MapiHttpCapability': '1', 'X-AnchorMailbox': 'alice@example.com' }, body: OUTLOOK_REQ },
  { name: 'Outlook 2019', path: '/AutoDiscover/AutoDiscover.xml', schema: 'outlook', contentType: 'text/xml',
    userAgent: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.10417; Pro)',
    extraHeaders: { 'X-MapiHttpCapability': '1', 'X-AnchorMailbox': 'alice@example.com' }, body: OUTLOOK_REQ },
  { name: 'Outlook 2021', path: '/autodiscover/autodiscover.xml', schema: 'outlook', contentType: 'text/xml',
    userAgent: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.14332; Pro)',
    extraHeaders: { 'X-MapiHttpCapability': '1', 'X-AnchorMailbox': 'alice@example.com', 'X-User-Identity': 'alice@example.com' }, body: OUTLOOK_REQ },
  { name: 'Outlook for Microsoft 365 (classic)', path: '/autodiscover/autodiscover.xml', schema: 'outlook', contentType: 'text/xml',
    userAgent: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)',
    extraHeaders: { 'X-MapiHttpCapability': '1', 'X-AnchorMailbox': 'alice@example.com', 'Accept': '*/*' }, body: OUTLOOK_REQ },
  { name: 'iOS Mail (Exchange account)', path: '/autodiscover/autodiscover.xml', schema: 'mobilesync', contentType: 'text/xml',
    userAgent: 'iOS/17.4 (21E219) dataaccessd/1.0', body: MOBILESYNC_REQ },
  { name: 'Android ActiveSync client', path: '/Autodiscover/Autodiscover.xml', schema: 'mobilesync', contentType: 'text/xml',
    userAgent: 'Android-Mail/2024.01.01', body: MOBILESYNC_REQ },
  { name: 'Android ActiveSync client (application/xml)', path: '/autodiscover/autodiscover.xml', schema: 'mobilesync', contentType: 'application/xml',
    userAgent: 'Android/14-EAS-1.3', body: MOBILESYNC_REQ },
  { name: 'Device client without Content-Type', path: '/autodiscover/autodiscover.xml', schema: 'mobilesync', contentType: null,
    userAgent: 'TestActiveSync/1.0', body: MOBILESYNC_REQ },
];

async function send(c: ClientShape, auth: string | null, email = 'alice@example.com') {
  const res = await fetch(`${base}${c.path}`, {
    method: 'POST',
    headers: {
      'User-Agent': c.userAgent,
      ...(c.contentType ? { 'Content-Type': c.contentType } : {}),
      ...(c.extraHeaders ?? {}),
      ...(auth ? { Authorization: auth } : {}),
    },
    body: c.contentType ? c.body(email) : new Blob([c.body(email)]),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('per client: challenge first, then the right schema', () => {
  for (const c of CLIENTS) {
    test(c.name, async () => {
      const probe = await send(c, null);
      assert.equal(probe.status, 401, 'unauthenticated probe');
      assert.equal(probe.headers.get('www-authenticate'), 'Basic realm="CoreMail Autodiscover"');
      assert.doesNotMatch(probe.text, /example\.com/, 'nothing answered before authentication');

      const r = await send(c, basic());
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/xml/);
      assert.doesNotMatch(r.text, /<Type>(EXCH|EXPR|EXHTTP)<\/Type>|mapiHttp|<EwsUrl>|<RedirectUrl>/i);
      if (c.schema === 'outlook') {
        assert.match(r.text, new RegExp(`<Response xmlns="${NS_OUTLOOK}">`));
        assert.match(r.text, /<Type>IMAP<\/Type>\s*<Server>mail\.example\.com<\/Server>\s*<Port>993<\/Port>/);
        assert.match(r.text, /<SSL>on<\/SSL>\s*<Encryption>SSL<\/Encryption>/);
        assert.match(r.text, /<Type>SMTP<\/Type>\s*<Server>mail\.example\.com<\/Server>\s*<Port>587<\/Port>/);
        assert.match(r.text, /<Encryption>TLS<\/Encryption>\s*<AuthRequired>on<\/AuthRequired>\s*<UsePOPAuth>/);
        assert.match(r.text, /<LoginName>alice@example\.com<\/LoginName>/);
      } else {
        assert.match(r.text, new RegExp(`<Response xmlns="${NS_MOBILESYNC}">`));
        assert.match(r.text, /<Url>https:\/\/mail\.example\.com\/Microsoft-Server-ActiveSync<\/Url>/);
        assert.doesNotMatch(r.text, /<Type>IMAP<\/Type>/);
      }
    });
  }
});

describe('Outlook 2016+ discovery sequence', () => {
  test('v2 JSON (AutodiscoverV1 lookup) points at the v1 endpoint, both URL forms, any path case', async () => {
    for (const path of [
      '/autodiscover/autodiscover.json/v1.0/alice@example.com?Protocol=AutodiscoverV1',
      '/AutoDiscover/AutoDiscover.json?Email=alice%40example.com&Protocol=autodiscoverv1&RedirectCount=1',
    ]) {
      const res = await fetch(`${base}${path}`, { headers: { 'User-Agent': 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)' } });
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), { Protocol: 'AutodiscoverV1', Url: 'https://autodiscover.example.com/Autodiscover/Autodiscover.xml' });
    }
  });

  test('v2 is anonymous and identical for known and unknown addresses (no account disclosure)', async () => {
    const known = await (await fetch(`${base}/autodiscover/autodiscover.json/v1.0/alice@example.com?Protocol=IMAP`)).json();
    const unknown = await (await fetch(`${base}/autodiscover/autodiscover.json/v1.0/nobody@example.com?Protocol=IMAP`)).json();
    assert.deepEqual(known, unknown);
  });
});

describe('authentication never discloses accounts', () => {
  test('unknown account and wrong password: identical 401', async () => {
    const c = CLIENTS[0]!;
    const unknown = await send(c, basic('nobody@example.com', 'pw'));
    const wrong = await send(c, basic('alice@example.com', 'wrong'));
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.headers.get('www-authenticate'), wrong.headers.get('www-authenticate'));
    assert.equal(unknown.text, wrong.text);
  });

  test('alias requested: answered for the primary account (the login identity)', async () => {
    const r = await send(CLIENTS[2]!, basic(), 'info@example.com');
    assert.match(r.text, /<AutoDiscoverSMTPAddress>alice@example\.com<\/AutoDiscoverSMTPAddress>/);
    assert.doesNotMatch(r.text, /<RedirectAddr>/);
  });
});

describe('HTTP redirect method (plain HTTP probe)', () => {
  test('unauthenticated GET over plain HTTP → 302 to the HTTPS endpoint, never a Basic challenge', async () => {
    const res = await fetch(`${base}/autodiscover/autodiscover.xml`, {
      headers: { 'X-Forwarded-Proto': 'http', 'User-Agent': 'Microsoft Office/14.0 (Windows NT 6.1; Microsoft Outlook 14.0.7268; Pro)' },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://autodiscover.example.com/Autodiscover/Autodiscover.xml');
    assert.equal(res.headers.get('www-authenticate'), null);
  });

  test('HTTPS and POST requests are not redirected', async () => {
    const tlsGet = await fetch(`${base}/autodiscover/autodiscover.xml`, { headers: { 'X-Forwarded-Proto': 'https' }, redirect: 'manual' });
    assert.equal(tlsGet.status, 401);
    assert.equal(plainHttpRedirectTarget({ method: 'POST', forwardedProto: 'http', hasAuthorization: false, autodiscoverBase: 'https://a.example.com' }), null);
    assert.equal(plainHttpRedirectTarget({ method: 'GET', forwardedProto: 'http', hasAuthorization: false, autodiscoverBase: 'http://a.example.com' }), null, 'no HTTPS endpoint');
    assert.equal(plainHttpRedirectTarget({ method: 'GET', forwardedProto: 'http', hasAuthorization: false, autodiscoverBase: 'https://a.example.com/' }), 'https://a.example.com/Autodiscover/Autodiscover.xml');
  });
});

describe('endpoints follow the enabled listeners', () => {
  test('pure: configured port kept when no listener contradicts it (NAT mapping)', () => {
    assert.deepEqual(settings.endpointForListeners({ port: 10993, ssl: true }, [{ service: 'IMAP', port: 993, ssl: true, active: true }]), { port: 10993, ssl: true });
    assert.deepEqual(settings.endpointForListeners({ port: 993, ssl: true }, [{ service: 'IMAP', port: 993, ssl: false, active: true }]), { port: 993, ssl: false }, 'TLS mode from the listener');
    assert.deepEqual(settings.endpointForListeners({ port: 993, ssl: true }, [
      { service: 'IMAP', port: 993, ssl: true, active: false },
      { service: 'IMAP', port: 143, ssl: false, active: true },
    ]), { port: 143, ssl: false });
    assert.deepEqual(settings.endpointForListeners({ port: 993, ssl: true }, [{ service: 'IMAP', port: 993, ssl: true, active: false }]), { port: 993, ssl: true }, 'nothing better: keep');
  });

  test('IMAPS switched off → Outlook gets 143 with STARTTLS (Encryption TLS); 587 off → 465 SSL', async () => {
    for (const l of state.listeners) {
      if ((l.service === 'IMAP' && l.port === 993) || (l.service === 'SMTP_RECEIVE' && l.port === 587)) l.active = false;
    }
    const r = await send(CLIENTS[3]!, basic());
    assert.match(r.text, /<Type>IMAP<\/Type>\s*<Server>mail\.example\.com<\/Server>\s*<Port>143<\/Port>/);
    assert.match(r.text, /<SSL>off<\/SSL>\s*<Encryption>TLS<\/Encryption>/);
    assert.match(r.text, /<Type>SMTP<\/Type>\s*<Server>mail\.example\.com<\/Server>\s*<Port>465<\/Port>/);
    assert.match(r.text, /<Encryption>SSL<\/Encryption>\s*<AuthRequired>on<\/AuthRequired>\s*<UsePOPAuth>/);

    const v2 = await (await fetch(`${base}/autodiscover/autodiscover.json/v1.0/alice@example.com?Protocol=SMTP`)).json();
    assert.deepEqual(v2, { Protocol: 'SMTP', Hostname: 'mail.example.com', Port: 465, SSL: 'SSL' });
  });

  test('listener table unreadable: the configured endpoints are announced', async () => {
    state.listenersDown = true;
    const cfg = await settings.getServerConfig(0);
    assert.equal(cfg.imapPort, 993);
    assert.equal(cfg.smtpPort, 587);
  });
});
