/**
 * SSO HTTP contract, end to end over loopback: gateway routes (/auth/sso/*,
 * admin SSO + LDAP responses) against a fake IdP issuing RS256 ID tokens.
 * Run: node --import tsx --test src/routes/sso.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const { FakeIdp } = await import('@coremail/auth-sso/testing');
const { invalidateOidcClient } = await import('@coremail/auth-sso');
const { ssoRouter } = await import('./sso.js');
const { adminSsoRouter } = await import('./admin/sso.js');
const { adminLdapRouter } = await import('./admin/ldap.js');

const idp = new FakeIdp('gw-client', 'gw-secret-xyz');
let server: Server;
let base = '';
let providerId = '';
let domainId = '';

before(async () => {
  await idp.start();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/auth/sso', ssoRouter);
  app.use('/api/v1/admin/sso', adminSsoRouter);
  app.use('/api/v1/admin/ldap', adminLdapRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['COREMAIL_PUBLIC_URL'] = base;
});
after(async () => { server.close(); await idp.stop(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'domain', 'oidcProvider', 'ldapConfig', 'mailbox', 'folder', 'calendar', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
  invalidateOidcClient();
  domainId = (await db.domain.create({ data: { name: 'example.com' } }))['id'] as string;
  providerId = (await db.oidcProvider.create({
    data: { domainId, name: 'Entra ID', discoveryUrl: idp.discoveryUrl, clientId: idp.clientId, clientSecret: idp.clientSecret },
  }))['id'] as string;
});

const get = (path: string, cookie?: string) =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown>, headers: r.headers };
}

/** Browser-side SSO login up to the redirect back into the SPA. */
async function browserLogin(target: 'mwa' | 'bcp', claims: Record<string, unknown>) {
  const start = await get(`/auth/sso/${providerId}/start?target=${target}`);
  assert.equal(start.status, 302);
  const setCookie = start.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^cm_sso=[A-Za-z0-9_-]{43}; Path=\/auth\/sso; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const cookie = setCookie.split(';')[0]!;
  const back = idp.authorize(start.headers.get('location')!, { sub: 'sub-1', claims });
  assert.equal(back.redirectUri, `${base}/auth/sso/${providerId}/callback`);
  const cb = await get(`/auth/sso/${providerId}/callback?code=${back.code}&state=${back.state}`, cookie);
  assert.equal(cb.status, 302);
  return { cookie, location: cb.headers.get('location')!, back };
}

test('GET /auth/sso/providers is public and hides client data', async () => {
  await db.oidcProvider.create({ data: { domainId, name: 'Hidden', discoveryUrl: 'https://x', clientId: 'c', clientSecret: 's', active: false } });
  const r = await fetch(`${base}/auth/sso/providers`);
  const list = await r.json() as Record<string, unknown>[];
  assert.deepEqual(list, [{ id: providerId, name: 'Entra ID' }]);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('end to end: start → IdP → callback → exchange (MWA), tokens never in a URL', async () => {
  const { cookie, location } = await browserLogin('mwa', { email: 'Alice@Example.com', email_verified: true });
  const url = new URL(location, base);
  assert.equal(url.pathname, '/sso/callback');
  assert.deepEqual([...url.searchParams.keys()], ['code']);
  assert.ok(!/token/i.test(location));

  const code = url.searchParams.get('code')!;
  const noCookie = await postJson('/auth/sso/exchange', { code });
  assert.equal(noCookie.status, 401, 'exchange is bound to the browser cookie');

  // fresh login (the failed exchange consumed the code)
  const again = await browserLogin('mwa', { email: 'alice@example.com', email_verified: true });
  const code2 = new URL(again.location, base).searchParams.get('code')!;
  const ex = await postJson('/auth/sso/exchange', { code: code2 }, { Cookie: again.cookie });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.ok(typeof ex.body['accessToken'] === 'string' && typeof ex.body['refreshToken'] === 'string');
  assert.match(ex.headers.get('set-cookie') ?? '', /cm_sso=; .*Max-Age=0/);
  const payload = core.verifyAccessToken(ex.body['accessToken'] as string)!;
  assert.equal(payload.email, 'alice@example.com');
  assert.equal((await postJson('/auth/sso/exchange', { code: code2 }, { Cookie: again.cookie })).status, 401, 'single use');
  // the session is a normal CoreMail session: refresh works
  const rot = await sauth.rotateSession(ex.body['refreshToken'] as string, { ip: '127.0.0.1', userAgent: 't' });
  assert.equal(rot.ok, true);
});

test('BCP target redirects into /bcp; errors land on the login page', async () => {
  const ok = await browserLogin('bcp', { email: 'admin@example.com', email_verified: true });
  assert.match(ok.location, /^\/bcp\/sso\/callback\?code=/);

  const bad = await browserLogin('bcp', { email: 'admin@example.com', email_verified: false });
  assert.equal(bad.location, '/bcp/login?sso_error=email_unverified');

  // callback without the cookie / with a used state
  const start = await get(`/auth/sso/${providerId}/start`);
  const back = idp.authorize(start.headers.get('location')!, { sub: 's', claims: { email: 'a@example.com', email_verified: true } });
  const noCookie = await get(`/auth/sso/${providerId}/callback?code=${back.code}&state=${back.state}`);
  assert.equal(noCookie.headers.get('location'), '/login?sso_error=invalid_state');
  const replay = await get(`/auth/sso/${providerId}/callback?code=${ok.back.code}&state=${ok.back.state}`, ok.cookie);
  assert.equal(replay.headers.get('location'), '/login?sso_error=invalid_state');

  const unknown = await get('/auth/sso/does-not-exist/start');
  assert.equal(unknown.headers.get('location'), '/login?sso_error=provider_unavailable');
});

test('admin SSO + LDAP responses never contain secrets', async () => {
  const admin = await db.user.create({ data: { email: 'root@example.com', role: 'SERVER_MANAGEMENT', domainId } });
  const { accessToken } = await sauth.issueSession(
    { id: admin['id'] as string, email: 'root@example.com', role: 'SERVER_MANAGEMENT', domainId },
    { ip: '127.0.0.1', userAgent: 't', mfaVerified: true },
  );
  const auth = { Authorization: `Bearer ${accessToken}` };

  const r = await fetch(`${base}/api/v1/admin/sso/providers`, { headers: auth });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes(idp.clientSecret) && !text.includes('clientSecret"'));
  const p = (JSON.parse(text) as Record<string, unknown>[])[0]!;
  assert.equal(p['hasClientSecret'], true);
  assert.equal(p['redirectUri'], `${base}/auth/sso/${providerId}/callback`);

  const disc = await postJson('/api/v1/admin/sso/test-discovery', { discoveryUrl: idp.discoveryUrl }, auth);
  assert.equal(disc.body['success'], true);
  assert.equal(disc.body['pkceS256'], true);

  // empty secret on update keeps the stored one
  const put = await fetch(`${base}/api/v1/admin/sso/providers/${providerId}`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientSecret: '', allowLinking: true }),
  });
  assert.equal(put.status, 200);
  assert.equal(db.oidcProvider.rows[0]!['clientSecret'], idp.clientSecret);
  assert.equal(db.oidcProvider.rows[0]!['allowLinking'], true);

  const ldapBody = {
    host: 'dc.example.com', port: 636, ssl: true, baseDN: 'dc=example,dc=com', bindDN: 'cn=svc', bindPassword: 'ldap-bind-secret',
    userDN: 'ou=people,dc=example,dc=com', userFilter: '(sAMAccountName={{username}})',
  };
  const saved = await fetch(`${base}/api/v1/admin/ldap/${domainId}`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(ldapBody),
  });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.ok(!savedText.includes('ldap-bind-secret'));
  const one = await (await fetch(`${base}/api/v1/admin/ldap/${domainId}`, { headers: auth })).text();
  assert.ok(!one.includes('ldap-bind-secret') && one.includes('"hasBindPassword":true'));
  // update without a password keeps it
  await fetch(`${base}/api/v1/admin/ldap/${domainId}`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ldapBody, bindPassword: '' }),
  });
  assert.equal(db.ldapConfig.rows[0]!['bindPassword'], 'ldap-bind-secret');
});
