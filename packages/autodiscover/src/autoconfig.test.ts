/**
 * Thunderbird autoconfig (v8.1): document content, XML escaping, no user enumeration,
 * foreign domains 404, host-based lookup on autoconfig.<domain>, rate limit, caching.
 * Run: node --import tsx --test src/autoconfig.test.ts
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['AUTOCONFIG_RATE_LIMIT'] = '1000';

const state = {
  domains: [{ name: 'example.com' }, { name: 'Other.ORG' }],
  domainReads: 0,
  settings: {
    publicHostname: 'mail.example.com', useHttps: true, httpPort: 443,
    owaUrl: 'https://mail.example.com/', easUrl: 'https://mail.example.com/Microsoft-Server-ActiveSync',
    autodiscoverBase: 'https://autodiscover.example.com',
    imapHost: 'imap.example.com', imapPort: 993, imapSsl: true,
    pop3Host: 'pop.example.com', pop3Port: 995, pop3Ssl: true,
    smtpHost: 'smtp.example.com', smtpPort: 587, smtpTls: true,
    orgName: 'Acme <Mail> & "Co"',
  } as Record<string, unknown>,
};

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  serverSettings: { findUnique: async () => state.settings },
  domain: {
    // only active domains are requested
    findMany: async (a: { where?: { active?: boolean } }) => {
      state.domainReads++;
      assert.equal(a.where?.active, true);
      return state.domains;
    },
  },
};

const { createAutodiscoverApp } = await import('./app.js');
const ac = await import('./autoconfig.js');
const settings = await import('./settings.js');
const { FixedWindowLimiter } = await import('./rate-limit.js');

const server = createAutodiscoverApp().listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

beforeEach(() => {
  ac.resetAutoconfigForTests();
  settings.resetSettingsCacheForTests();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5_000) });
/** node:http request (fetch does not let a test set the Host header). */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const WK = '/.well-known/autoconfig/mail/config-v1.1.xml';

test('config-v1.1.xml: IMAP 993/143, POP3 995/110, SMTP 465/587, cleartext password, %EMAILADDRESS%', async () => {
  const res = await get(`${WK}?emailaddress=alice%40example.com`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/xml/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<clientConfig version="1.1">/);
  assert.match(xml, /<emailProvider id="example.com">\n {4}<domain>example.com<\/domain>/);
  const servers = [...xml.matchAll(/<(incoming|outgoing)Server type="(\w+)">\s*<hostname>([^<]+)<\/hostname>\s*<port>(\d+)<\/port>\s*<socketType>(\w+)<\/socketType>/g)]
    .map((m) => `${m[2]} ${m[3]}:${m[4]} ${m[5]}`);
  assert.deepEqual(servers, [
    'imap imap.example.com:993 SSL',
    'imap imap.example.com:143 STARTTLS',
    'pop3 pop.example.com:995 SSL',
    'pop3 pop.example.com:110 STARTTLS',
    // configured submission port first, then the implicit-TLS variant
    'smtp smtp.example.com:587 STARTTLS',
    'smtp smtp.example.com:465 SSL',
  ]);
  assert.equal((xml.match(/<authentication>password-cleartext<\/authentication>/g) ?? []).length, 6);
  assert.equal((xml.match(/<username>%EMAILADDRESS%<\/username>/g) ?? []).length, 8);
  assert.doesNotMatch(xml, /plain<\/socketType>/);
  // CalDAV/CardDAV hints (Thunderbird 102+)
  assert.match(xml, /<addressBook type="carddav">[\s\S]*<serverURL>https:\/\/mail.example.com\/dav\/<\/serverURL>/);
  assert.match(xml, /<calendar type="caldav">[\s\S]*<serverURL>https:\/\/mail.example.com\/dav\/<\/serverURL>/);
});

test('XML escaping of settings values', async () => {
  const xml = await (await get(`${WK}?emailaddress=a%40example.com`)).text();
  assert.match(xml, /<displayName>Acme &lt;Mail&gt; &amp; &quot;Co&quot;<\/displayName>/);
  assert.doesNotMatch(xml, /<Mail>/);
  assert.equal(ac.xmlEscape(`<a href='x'>&\u0001`), '&lt;a href=&apos;x&apos;&gt;&amp;');
});

test('no user enumeration: every address of a served domain gets the identical answer', async () => {
  const a = await (await get(`${WK}?emailaddress=alice%40example.com`)).text();
  const b = await (await get(`${WK}?emailaddress=no.such.user.${Date.now()}%40example.com`)).text();
  const c = await (await get(`${WK}?emailaddress=%3Cscript%3E%40EXAMPLE.com`)).text();
  assert.equal(a, b);
  assert.equal(a, c);
  assert.doesNotMatch(a, /alice|script/);
});

test('foreign, inactive or malformed domains get 404 with the same body', async () => {
  for (const q of ['bob%40foreign.net', 'bob%40', 'bob%40exa_mple.com', 'nobody', '']) {
    const res = await get(`${WK}?emailaddress=${q}`);
    assert.equal(res.status, 404, q);
    assert.equal(await res.text(), 'Not found');
  }
  const arr = await get(`${WK}?emailaddress=a%40example.com&emailaddress=b%40example.com`);
  assert.equal(arr.status, 404, 'repeated parameter is rejected');
});

test('domain match is case-insensitive', async () => {
  const res = await get(`${WK}?emailaddress=x%40other.org`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<emailProvider id="other.org">/);
});

test('autoconfig.<domain>/mail/config-v1.1.xml works without emailaddress (Host / X-Forwarded-Host)', async () => {
  const viaHost = await rawGet('/mail/config-v1.1.xml', { host: 'autoconfig.example.com' });
  assert.equal(viaHost.status, 200);
  assert.match(viaHost.body, /<domain>example.com<\/domain>/);
  // the gateway forwards the client Host as X-Forwarded-Host (loopback peer → trusted)
  const viaFwd = await get('/mail/config-v1.1.xml', { 'x-forwarded-host': 'autoconfig.other.org:443' });
  assert.equal(viaFwd.status, 200);
  const foreign = await rawGet('/mail/config-v1.1.xml', { host: 'autoconfig.foreign.net' });
  assert.equal(foreign.status, 404);
});

test('domains are cached (one DB read for many requests)', async () => {
  state.domainReads = 0;
  for (let i = 0; i < 5; i++) await get(`${WK}?emailaddress=u${i}%40example.com`);
  assert.equal(state.domainReads, 1);
});

test('custom implicit-TLS submission port and STARTTLS-only IMAP are announced first', async () => {
  const saved = state.settings;
  state.settings = { ...saved, smtpPort: 465, imapPort: 143, imapSsl: false, useHttps: false, httpPort: 8080 };
  try {
    const xml = await (await get(`${WK}?emailaddress=a%40example.com`)).text();
    const ports = [...xml.matchAll(/<port>(\d+)<\/port>\s*<socketType>(\w+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(ports, ['143 STARTTLS', '993 SSL', '995 SSL', '110 STARTTLS', '465 SSL', '587 STARTTLS']);
    assert.match(xml, /<serverURL>http:\/\/mail.example.com:8080\/dav\/<\/serverURL>/);
  } finally {
    state.settings = saved;
  }
});

test('rate limit: 429 with Retry-After once the per-IP budget is used up', () => {
  let now = 1_000;
  const l = new FixedWindowLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  assert.equal(l.hit('1.2.3.4').ok, true);
  assert.equal(l.hit('1.2.3.4').ok, true);
  assert.equal(l.hit('1.2.3.4').ok, true);
  const r = l.hit('1.2.3.4');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.retryAfterSec, 60);
  assert.equal(l.hit('5.6.7.8').ok, true, 'other IPs unaffected');
  now += 60_000;
  assert.equal(l.hit('1.2.3.4').ok, true, 'new window');
});

test('rate limit: key map is bounded (overflow bucket)', () => {
  const l = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 0 });
  l.hit('a'); l.hit('b');
  for (let i = 0; i < 10; i++) assert.equal(l.hit(`x${i}`).ok, true);
  assert.equal(l.hit('x-last').ok, false, 'overflow bucket allows limit*10');
});

test('the handler answers 429 when the limiter refuses', async () => {
  process.env['AUTOCONFIG_RATE_LIMIT'] = '2';
  ac.resetAutoconfigForTests();
  try {
    assert.equal((await get(`${WK}?emailaddress=a%40example.com`)).status, 200);
    assert.equal((await get(`${WK}?emailaddress=a%40example.com`)).status, 200);
    const res = await get(`${WK}?emailaddress=a%40example.com`);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  } finally {
    process.env['AUTOCONFIG_RATE_LIMIT'] = '1000';
    ac.resetAutoconfigForTests();
  }
});

test('database down without a known value → 503, not a guessed config', async () => {
  const saved = (globalThis as Record<string, any>)['__prisma'].domain.findMany;
  (globalThis as Record<string, any>)['__prisma'].domain.findMany = async () => { throw new Error('db down'); };
  try {
    const res = await get(`${WK}?emailaddress=a%40example.com`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    (globalThis as Record<string, any>)['__prisma'].domain.findMany = saved;
  }
});
