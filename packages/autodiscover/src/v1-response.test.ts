/**
 * Autodiscover v1 responses (MS-OXDSCLI / MS-ASCMD Autodiscover) and v2 routing:
 * own-address only (no disclosure of other accounts), AcceptableResponseSchema
 * (outlook / mobilesync / unsupported → 601), unauthenticated requests cause no
 * database writes, database errors never serve the built-in mail.local defaults.
 * 9.4: only protocols switched on are announced (v1: per account, v2: per domain).
 * Express app on an ephemeral loopback port, fake Prisma via globalThis.__prisma.
 * Run: node --import tsx --test src/v1-response.test.ts (in packages/autodiscover)
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const SETTINGS = {
  owaUrl: 'https://mail.example.com/owa/', easUrl: 'https://mail.example.com/Microsoft-Server-ActiveSync',
  autodiscoverBase: 'https://autodiscover.example.com', imapHost: 'imap.example.com', imapPort: 993, imapSsl: true,
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: true,
};
const state = { settingsDown: false, settings: { ...SETTINGS } as typeof SETTINGS | null, settingsReads: 0, systemLogs: 0 };
const user = (id: string, email: string, displayName: string) => ({
  id, email, displayName, domainId: 'd1', role: 'USER', active: true, passwordHash: 'hash:pw',
  authSource: 'LOCAL', mfa: null, mailbox: { id: `mb-${id}` },
});
const users = [user('cuidA', 'alice@example.com', 'Alice <A&B>'), user('cuidSECRETB', 'ceo@example.com', 'Chief Exec')];
const aliases = [{ id: 'al1', address: 'info@example.com', targetUserId: 'cuidA' }, { id: 'al2', address: 'boss@example.com', targetUserId: 'cuidSECRETB' }];
/** 9.4: ProtocolPolicy rows (protocol switches). */
const policies: Array<Record<string, unknown>> = [];

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: { findFirst: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null },
  appPassword: { findMany: async () => [], update: async () => ({}) },
  domain: {
    findFirst: async () => ({ name: 'example.com' }),
    findUnique: async ({ where }: { where: { name: string } }) => (where.name === 'example.com' ? { id: 'd1' } : null),
  },
  protocolPolicy: { findMany: async () => policies },
  emailAlias: {
    findFirst: async ({ where }: { where: { address: string; targetUserId: string } }) =>
      aliases.find((a) => a.address === where.address && a.targetUserId === where.targetUserId) ?? null,
  },
  serverSettings: {
    findUnique: async (args?: { select?: { jmapEnabled?: boolean } }) => {
      // The protocol switch read (JMAP server level) is not part of the settings outage simulated here.
      if (args?.select?.jmapEnabled) return null;
      state.settingsReads++;
      if (state.settingsDown) throw new Error('db down');
      return state.settings;
    },
  },
  systemLog: { create: async () => { state.systemLogs++; return {}; } },
};
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { createAutodiscoverApp } = await import('./app.js');
const { NS_OUTLOOK, NS_MOBILESYNC, xmlElementText } = await import('./v1.js');
const settings = await import('./settings.js');

const server = createAutodiscoverApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

beforeEach(() => {
  settings.resetSettingsCacheForTests();
  state.settingsDown = false;
  state.settings = { ...SETTINGS };
});

const basic = (login: string, pw = 'pw') => `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}`;
function requestXml(email: string | null, schema: string | null = NS_OUTLOOK): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    ${email !== null ? `<EMailAddress>${email}</EMailAddress>` : ''}
    ${schema !== null ? `<AcceptableResponseSchema>${schema}</AcceptableResponseSchema>` : ''}
  </Request>
</Autodiscover>`;
}
async function post(body: string, auth: string | null = basic('alice@example.com')) {
  const res = await fetch(`${base}/Autodiscover/Autodiscover.xml`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', ...(auth ? { Authorization: auth } : {}) },
    body,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const withoutTime = (xml: string) => xml.replace(/Time="[^"]*"/, '');

test('own address: 200 with the outlook schema, IMAP 993/SSL, SMTP 587/TLS, XML-escaped, no ActiveSync account', async () => {
  const r = await post(requestXml('alice@example.com'));
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`<Response xmlns="${NS_OUTLOOK}">`));
  assert.match(r.text, /<DisplayName>Alice &lt;A&amp;B&gt;<\/DisplayName>/);
  assert.match(r.text, /<Type>IMAP<\/Type>\s*<Server>imap\.example\.com<\/Server>\s*<Port>993<\/Port>/);
  assert.match(r.text, /<SSL>on<\/SSL>/);
  assert.match(r.text, /<Type>SMTP<\/Type>\s*<Server>smtp\.example\.com<\/Server>\s*<Port>587<\/Port>/);
  assert.match(r.text, /<Encryption>TLS<\/Encryption>/);
  assert.equal((r.text.match(/<Account>/g) ?? []).length, 1, 'one Account (MS-OXDSCLI maxOccurs=1)');
  assert.doesNotMatch(r.text, /ActiveSync/, 'ActiveSync is announced through the mobilesync schema only');
});

test('another user\'s address, an unknown account and a foreign domain get the same Error 500, no name or id', async () => {
  const other = await post(requestXml('ceo@example.com'));
  const unknown = await post(requestXml('nobody@example.com'));
  const foreign = await post(requestXml('nobody@gmail.com'));
  const otherAlias = await post(requestXml('boss@example.com'));
  for (const r of [other, unknown, foreign, otherAlias]) {
    assert.equal(r.status, 200);
    assert.match(r.text, /<ErrorCode>500<\/ErrorCode>/);
    assert.doesNotMatch(r.text, /Chief Exec|cuidSECRETB|cn=|nobody|<Protocol>/);
  }
  assert.equal(withoutTime(other.text), withoutTime(unknown.text));
  assert.equal(withoutTime(unknown.text), withoutTime(foreign.text));
});

test('an alias of the caller and a different spelling of the own address are answered', async () => {
  const alias = await post(requestXml('info@example.com'));
  assert.equal(alias.status, 200);
  assert.match(alias.text, /<AutoDiscoverSMTPAddress>info@example\.com<\/AutoDiscoverSMTPAddress>/);
  const upper = await post(requestXml('Alice@Example.com'));
  assert.match(upper.text, /<Type>IMAP<\/Type>/);
});

test('mobilesync schema (ActiveSync clients): MobileSync server URL; an unknown schema: Error 601', async () => {
  const r = await post(requestXml('alice@example.com', NS_MOBILESYNC));
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`<Response xmlns="${NS_MOBILESYNC}">`));
  assert.match(r.text, /<Type>MobileSync<\/Type>\s*<Url>https:\/\/mail\.example\.com\/Microsoft-Server-ActiveSync<\/Url>/);
  assert.match(r.text, /<EMailAddress>alice@example\.com<\/EMailAddress>/);
  assert.doesNotMatch(r.text, /<Type>IMAP<\/Type>/);

  const bad = await post(requestXml('alice@example.com', 'http://example.invalid/responseschema/2099'));
  assert.equal(bad.status, 200);
  assert.match(bad.text, /<ErrorCode>601<\/ErrorCode>/);
  assert.doesNotMatch(bad.text, /<Protocol>|MobileSync/);
});

test('without AcceptableResponseSchema the outlook schema is used; a missing address means the caller\'s own', async () => {
  const r = await post(requestXml(null, null));
  assert.equal(r.status, 200);
  assert.match(r.text, /<AutoDiscoverSMTPAddress>alice@example\.com<\/AutoDiscoverSMTPAddress>/);
});

test('namespace prefixes and XML entities in the request are understood', async () => {
  const body = `<?xml version="1.0"?><a:Autodiscover xmlns:a="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><a:Request>
    <a:EMailAddress>info&#64;example.com</a:EMailAddress><a:AcceptableResponseSchema>${NS_MOBILESYNC}</a:AcceptableResponseSchema></a:Request></a:Autodiscover>`;
  const r = await post(body);
  assert.match(r.text, /<EMailAddress>info@example\.com<\/EMailAddress>/);
  assert.equal(xmlElementText('<x:A>a&amp;b</x:A>', 'A'), 'a&b');
});

test('Bearer / Negotiate / missing auth: 401 with the Basic challenge, no database read or write', async () => {
  const reads = state.settingsReads;
  const logs = state.systemLogs;
  const payload = Buffer.from(JSON.stringify({ iss: 'x'.repeat(10_000) })).toString('base64url');
  for (const auth of [`Bearer e30.${payload}.sig`, 'Negotiate abc', 'NTLM abc', null]) {
    const r = await post(requestXml('alice@example.com'), auth);
    assert.equal(r.status, 401, String(auth));
    assert.equal(r.headers.get('www-authenticate'), 'Basic realm="CoreMail Autodiscover"');
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(state.systemLogs, logs, 'no SystemLog row for unauthenticated requests');
  assert.equal(state.settingsReads, reads, 'no settings query for unauthenticated requests');
});

test('lowercase "basic" scheme is accepted; a wrong password gets 401', async () => {
  const ok = await post(requestXml('alice@example.com'), `basic ${Buffer.from('alice@example.com:pw').toString('base64')}`);
  assert.equal(ok.status, 200);
  const bad = await post(requestXml('alice@example.com'), basic('alice@example.com', 'wrong'));
  assert.equal(bad.status, 401);
});

test('GET with a repeated emailaddress parameter: Error 600 instead of a crash', async () => {
  const res = await fetch(`${base}/Autodiscover/Autodiscover.xml?emailaddress=a@example.com&emailaddress=b@example.com`, {
    headers: { Authorization: basic('alice@example.com') }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<ErrorCode>600<\/ErrorCode>/);
});

test('database error without a known value: 503, never the built-in mail.local defaults', async () => {
  state.settingsDown = true;
  const r = await post(requestXml('alice@example.com'));
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.text, /mail\.local/);
  // The failure is not cached: once the database is back, real settings are served.
  state.settingsDown = false;
  const ok = await post(requestXml('alice@example.com'));
  assert.match(ok.text, /imap\.example\.com/);
});

test('database error after a successful read: the last known settings are served (stale), not the defaults', async () => {
  await settings.getServerConfig(0);
  state.settingsDown = true;
  const cfg = await settings.getServerConfig(10 * 60_000); // cache expired
  assert.equal(cfg.imapHost, 'imap.example.com');
  settings.invalidateSettingsCache(); // a Redis reload signal keeps the outage fallback
  assert.equal((await settings.getServerConfig(20 * 60_000)).imapHost, 'imap.example.com');
});

test('no settings row yet (fresh install): environment defaults, not cached', async () => {
  state.settings = null;
  const fresh = await settings.getServerConfig(0);
  assert.equal(fresh.imapPort, 993);
  state.settings = { ...SETTINGS };
  assert.equal((await settings.getServerConfig(1)).imapHost, 'imap.example.com');
});

test('SMTP on port 465 is announced as implicit TLS (v1 SSL, v2 SSL)', async () => {
  state.settings = { ...SETTINGS, smtpPort: 465 };
  const r = await post(requestXml('alice@example.com'));
  assert.match(r.text, /<Encryption>SSL<\/Encryption>/);
  const v2 = await fetch(`${base}/autodiscover/autodiscover.json/v1.0/alice%40example.com?Protocol=SMTP`);
  assert.deepEqual(await v2.json(), { Protocol: 'SMTP', Hostname: 'smtp.example.com', Port: 465, SSL: 'SSL' });
});

test('v2: the query-string form is routed; a repeated Protocol is a 404, not a crash; DB error → 503', async () => {
  const q = await fetch(`${base}/autodiscover/autodiscover.json?Email=alice%40example.com&Protocol=AutodiscoverV1`);
  assert.equal(q.status, 200);
  assert.deepEqual(await q.json(), { Protocol: 'AutodiscoverV1', Url: 'https://autodiscover.example.com/Autodiscover/Autodiscover.xml' });
  const arr = await fetch(`${base}/autodiscover/autodiscover.json?Email=alice%40example.com&Protocol=IMAP&Protocol=SMTP`);
  assert.equal(arr.status, 404);
  settings.resetSettingsCacheForTests();
  state.settingsDown = true;
  const down = await fetch(`${base}/autodiscover/autodiscover.json?Email=alice%40example.com&Protocol=IMAP`);
  assert.equal(down.status, 503);
});

test('9.4 v1: only protocols switched on for the account are announced (IMAP off → POP3, nothing → Error 500)', async () => {
  policies.push({ id: 'p-a', userId: 'cuidA', domainId: null, imap: 'OFF', activesync: 'OFF' });
  storage.invalidateProtocolAccessCache();
  try {
    const r = await post(requestXml('alice@example.com'));
    assert.doesNotMatch(r.text, /<Type>IMAP<\/Type>/);
    assert.match(r.text, /<Type>POP3<\/Type>\s*<Server>[^<]+<\/Server>\s*<Port>995<\/Port>/);
    assert.match(r.text, /<Type>SMTP<\/Type>/);
    const eas = await post(requestXml('alice@example.com', NS_MOBILESYNC));
    assert.match(eas.text, /<ErrorCode>500<\/ErrorCode>\s*<Message>No client protocol is enabled for this account\.<\/Message>/);
    policies[0]!['pop3'] = 'OFF';
    policies[0]!['smtp'] = 'OFF';
    storage.invalidateProtocolAccessCache();
    const none = await post(requestXml('alice@example.com'));
    assert.match(none.text, /<ErrorCode>500<\/ErrorCode>/);
    assert.doesNotMatch(none.text, /<Protocol>/);
  } finally {
    policies.length = 0;
    storage.invalidateProtocolAccessCache();
  }
});

test('9.4 v2 (anonymous): per mail domain — a protocol switched off for the domain is NoSuchProtocol', async () => {
  policies.push({ id: 'p-d1', domainId: 'd1', userId: null, activesync: 'OFF' });
  storage.invalidateProtocolAccessCache();
  try {
    const eas = await fetch(`${base}/autodiscover/autodiscover.json/v1.0/alice%40example.com?Protocol=ActiveSync`);
    assert.equal(eas.status, 404);
    assert.equal(((await eas.json()) as { ErrorCode: string }).ErrorCode, 'NoSuchProtocol');
    assert.equal((await fetch(`${base}/autodiscover/autodiscover.json/v1.0/alice%40example.com?Protocol=IMAP`)).status, 200);
    const foreign = await fetch(`${base}/autodiscover/autodiscover.json/v1.0/x%40other.test?Protocol=ActiveSync`);
    assert.equal(foreign.status, 200, 'another domain: server level');
  } finally {
    policies.length = 0;
    storage.invalidateProtocolAccessCache();
  }
});

test('9.4: outlookProtocols — IMAP before POP3, SMTP, the MAPI switch announces nothing yet', async () => {
  const { outlookProtocols } = await import('./v1.js');
  assert.deepEqual(outlookProtocols({ imap: true, pop3: true, smtp: true, mapi: true }), ['IMAP', 'SMTP']);
  assert.deepEqual(outlookProtocols({ imap: false, pop3: true, smtp: false, mapi: false }), ['POP3']);
  assert.deepEqual(outlookProtocols({ imap: false, pop3: false, smtp: false, mapi: true }), []);
});
