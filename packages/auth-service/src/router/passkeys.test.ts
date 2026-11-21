/**
 * 10.6: passkey routes of the auth-service over HTTP with the software
 * authenticator — sign-in (cm_pk flow cookie, refresh cookie), registration
 * with re-authentication, list / rename / delete, passkey re-auth, recovery
 * links, the deprecated security-key endpoints and the policy switch.
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/router/passkeys.test.ts  (in packages/auth-service)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['WEBAUTHN_RP_ID'];
delete process.env['WEBAUTHN_ORIGIN'];
delete process.env['COREMAIL_PUBLIC_URL'];

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;
(db as Record<string, unknown>)['ipAccessRule'] = { findMany: async () => [] };

const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const storage = await import('@coremail/storage');
const wa = await import('@coremail/storage/auth/webauthn');
const { SoftAuthenticator } = await import('@coremail/storage/auth/webauthn/testing');
const { createApp } = await import('../app.js');

const HOST = 'mail.example.org';
const ORIGIN = `https://${HOST}:8443`;
const PW = 'correct horse battery';
let pwHash = '';
let server: Server;
let base = '';
type Json = Record<string, unknown>;

before(async () => {
  pwHash = await core.hashPassword(PW);
  await new Promise<void>((resolve) => { server = createApp().listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sauth.setSecurityNotifier(async () => undefined);
  sauth.setAuthAuditSink(() => undefined);
});
after(() => { server.close(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'serverSettings', 'webAuthnCredential', 'passkeyRecoveryToken', 'passkeyPolicy', 'protocolPolicy'] as const) db[t].rows = [];
  redis.store.clear();
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: HOST, useHttps: true, httpPort: 8443, passkeysEnabled: true, passkeyPasswordlessEnabled: true, passkeyRpId: null, passkeyRelatedOrigins: [], jmapEnabled: true } });
  sauth.invalidatePasskeyPolicyCache();
  storage.invalidateProtocolAccessCache();
  storage.configureMailAuth({ onLockoutEvent: () => undefined });
});

interface Res { status: number; body: Json; cookies: string[] }
async function call(method: string, path: string, body?: unknown, opts: { token?: string; cookie?: string | undefined; web?: boolean; bcp?: boolean } = {}): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.web ? { 'X-CoreMail-Client': 'web', Origin: ORIGIN } : {}),
      ...(opts.bcp ? { 'X-CoreMail-App': 'bcp' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json, cookies: r.headers.getSetCookie() };
}

async function userWithSession(email = 'alice@example.org') {
  const u = await db.user.create({ data: { email, passwordHash: pwHash, displayName: 'Alice' } });
  const r = await call('POST', '/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: u['id'] as string, token: String(r.body['accessToken']) };
}

const soft = () => new SoftAuthenticator({ rpId: HOST, origin: ORIGIN });

async function registerViaApi(token: string, a = soft(), name = 'Laptop') {
  const o = await call('POST', '/auth/passkeys/registration/options', { currentPassword: PW }, { token });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const v = await call('POST', '/auth/passkeys/registration/verify', { flowId: o.body['flowId'], response: a.register(o.body['publicKey'] as Json), name }, { token });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { a, credential: v.body['credential'] as Json };
}

async function signIn(a: InstanceType<typeof SoftAuthenticator>, opts: { web?: boolean; bcp?: boolean; noCookie?: boolean } = {}) {
  const o = await call('POST', '/auth/passkey/login/options', {}, { web: opts.web ?? true, bcp: opts.bcp ?? false });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const flowCookie = o.cookies.find((c) => c.startsWith('cm_pk='));
  assert.ok(flowCookie && /HttpOnly/.test(flowCookie) && /SameSite=Strict/.test(flowCookie) && /Path=\/auth\/passkey/.test(flowCookie));
  const cookie = flowCookie.split(';')[0];
  return call('POST', '/auth/passkey/login/verify', { flowId: o.body['flowId'], response: a.assert(o.body['publicKey'] as Json) }, {
    web: opts.web ?? true, bcp: opts.bcp ?? false, ...(opts.noCookie ? {} : { cookie }),
  });
}

test('status + options: enabled only while passkeys and the passwordless sign-in are on', async () => {
  assert.deepEqual((await call('GET', '/auth/passkey/status')).body, { enabled: true });
  db.serverSettings.rows[0]!['passkeysEnabled'] = false;
  sauth.invalidatePasskeyPolicyCache();
  assert.deepEqual((await call('GET', '/auth/passkey/status')).body, { enabled: false });
  const o = await call('POST', '/auth/passkey/login/options', {});
  assert.equal(o.body['code'], 'PASSKEYS_DISABLED');
  await db.domain.create({ data: { name: 'example.org', dkimPrivateKey: '' } });
  await sauth.writePasskeyLevel({ level: 'domain', domainId: String(db.domain.rows[0]!['id']) }, 'on');
  assert.deepEqual((await call('GET', '/auth/passkey/status')).body, { enabled: true });
});

test('registration needs re-authentication; sign-in issues the refresh cookie and an MFA-verified session', async () => {
  const { id, token } = await userWithSession();
  assert.equal((await call('POST', '/auth/passkeys/registration/options', {}, { token })).body['code'], 'REAUTH_REQUIRED');
  const { a, credential } = await registerViaApi(token);
  assert.equal(credential['kind'], 'passkey');
  assert.equal(credential['legacy'], false);
  const list = await call('GET', '/auth/passkeys', undefined, { token });
  assert.equal((list.body['passkeys'] as Json[]).length, 1);
  assert.equal(list.body['allowed'], true);
  assert.equal(list.body['rpId'], HOST);
  const status = await call('GET', '/auth/mfa/status', undefined, { token });
  assert.equal(status.body['passkeyCount'], 1);
  assert.equal(status.body['webauthnCount'], 1);

  const r = await signIn(a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body['accessToken'] && !r.body['refreshToken'], 'browser: refresh token only as cookie');
  assert.ok(r.cookies.some((c) => c.startsWith('cm_rt=') && /HttpOnly/.test(c)));
  assert.ok(r.cookies.some((c) => c.startsWith('cm_pk=;')), 'flow cookie cleared');
  assert.equal(core.verifyAccessToken(String(r.body['accessToken']))?.mfaVerified, true);
  const bcp = await signIn(a, { bcp: true });
  assert.ok(bcp.cookies.some((c) => c.startsWith('cm_rt_bcp=')));
  assert.equal(db.session.rows.filter((s) => s['authMethod'] === 'passkey' && s['userId'] === id).length, 2);
});

test('sign-in: the flow is bound to the cm_pk cookie of the browser that asked for it', async () => {
  const { token } = await userWithSession();
  const { a } = await registerViaApi(token);
  assert.equal((await signIn(a, { noCookie: true })).body['code'], 'PASSKEY_CHALLENGE_EXPIRED');
  const o = await call('POST', '/auth/passkey/login/options', {}, { web: true });
  const other = await call('POST', '/auth/passkey/login/options', {}, { web: true });
  const otherCookie = other.cookies.find((c) => c.startsWith('cm_pk='))!.split(';')[0];
  const r = await call('POST', '/auth/passkey/login/verify', { flowId: o.body['flowId'], response: a.assert(o.body['publicKey'] as Json) }, { web: true, cookie: otherCookie });
  assert.equal(r.body['code'], 'PASSKEY_CHALLENGE_EXPIRED');
  // a non-browser client may send only the cookie
  const o3 = await call('POST', '/auth/passkey/login/options', {});
  const c3 = o3.cookies.find((c) => c.startsWith('cm_pk='))!.split(';')[0];
  assert.equal((await call('POST', '/auth/passkey/login/verify', { response: a.assert(o3.body['publicKey'] as Json) }, { cookie: c3 })).status, 200);
});

test('rename, delete with re-auth, passkey re-auth for an app password, signal data', async () => {
  const { id, token } = await userWithSession();
  const { a, credential } = await registerViaApi(token);
  const pid = String(credential['id']);
  assert.equal((await call('PATCH', `/auth/passkeys/${pid}`, { name: 'Phone' }, { token })).status, 200);
  assert.equal(db.webAuthnCredential.rows[0]!['name'], 'Phone');
  assert.equal((await call('PATCH', '/auth/passkeys/nope', { name: 'x' }, { token })).status, 404);

  // passkey re-auth instead of the password
  const ro = await call('POST', '/auth/passkeys/reauth/options', {}, { token });
  assert.equal(ro.status, 200);
  const ap = await call('POST', '/auth/app-passwords', {
    name: 'mail client', webauthnFlowId: ro.body['flowId'], webauthnResponse: a.assert(ro.body['publicKey'] as Json),
  }, { token });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));

  const sig = await call('GET', '/auth/passkeys/signal', undefined, { token });
  assert.deepEqual(sig.body['allAcceptedCredentialIds'], [a.credentialId]);
  assert.equal(sig.body['name'], 'alice@example.org');

  assert.equal((await call('DELETE', `/auth/passkeys/${pid}`, {}, { token })).body['code'], 'REAUTH_REQUIRED');
  // passkey-only: the last passkey cannot go
  db.user.rows.find((u) => u['id'] === id)!['passwordLoginDisabled'] = true;
  const ro2 = await call('POST', '/auth/passkeys/reauth/options', {}, { token });
  const del = await call('DELETE', `/auth/passkeys/${pid}`, { webauthnFlowId: ro2.body['flowId'], webauthnResponse: a.assert(ro2.body['publicKey'] as Json) }, { token });
  assert.equal(del.status, 409);
  assert.equal(del.body['code'], 'LAST_PASSKEY');
  db.user.rows.find((u) => u['id'] === id)!['passwordLoginDisabled'] = false;
  assert.equal((await call('DELETE', `/auth/passkeys/${pid}`, { currentPassword: PW }, { token })).status, 200);
  assert.equal(db.webAuthnCredential.rows.length, 0);
  assert.equal((await call('POST', '/auth/passkeys/reauth/options', {}, { token })).status, 404);
});

test('policy off for the user: no registration, no sign-in; OIDC-only accounts get no passkeys', async () => {
  const { id, token } = await userWithSession();
  const { a } = await registerViaApi(token);
  await sauth.writePasskeyLevel({ level: 'user', userId: id }, 'off');
  assert.equal((await call('POST', '/auth/passkeys/registration/options', { currentPassword: PW }, { token })).body['code'], 'PASSKEYS_DISABLED');
  assert.equal((await signIn(a)).body['code'], 'PASSKEYS_DISABLED');
  await sauth.writePasskeyLevel({ level: 'user', userId: id }, 'inherit');
  db.user.rows.find((u) => u['id'] === id)!['authSource'] = 'OIDC';
  assert.equal((await call('POST', '/auth/passkeys/registration/options', { currentPassword: PW }, { token })).body['code'], 'PASSKEYS_DISABLED');
});

test('recovery link: options + verify over HTTP, then sign-in with the new passkey', async () => {
  const { id } = await userWithSession();
  const { token } = await sauth.issuePasskeyRecoveryToken(id, 'admin');
  assert.equal((await call('POST', '/auth/passkey/recovery/options', { token: 'x'.repeat(43) })).body['code'], 'PASSKEY_RECOVERY_INVALID');
  const o = await call('POST', '/auth/passkey/recovery/options', { token });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const a = soft();
  const v = await call('POST', '/auth/passkey/recovery/verify', { token, flowId: o.body['flowId'], response: a.register(o.body['publicKey'] as Json), name: 'Recovered' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(db.session.rows.length, 0, 'every session revoked');
  assert.equal((await call('POST', '/auth/passkey/recovery/options', { token })).body['code'], 'PASSKEY_RECOVERY_INVALID');
  assert.equal((await signIn(a)).status, 200);
});

test('deprecated /auth/mfa/webauthn/register/*: writes a second-factor security key (no UV needed)', async () => {
  const { token } = await userWithSession();
  const s = await call('POST', '/auth/mfa/webauthn/register/start', { email: 'alice@example.org', currentPassword: PW }, { token });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((s.body['authenticatorSelection'] as Json)['userVerification'], 'discouraged');
  const a = soft();
  const f = await call('POST', '/auth/mfa/webauthn/register/finish', { response: a.register(s.body, { uv: false }), name: 'YubiKey' }, { token });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(db.webAuthnCredential.rows[0]!['kind'], 'security_key');
  assert.equal((await signIn(a)).body['code'], 'PASSKEY_NOT_ELIGIBLE');
  // the second factor after the password
  const l = await call('POST', '/auth/login', { email: 'alice@example.org', password: PW });
  assert.equal(l.body['mfaRequired'], true);
  const st = await call('POST', '/auth/mfa/webauthn/auth/start', { challengeToken: l.body['challengeToken'] });
  const v = await call('POST', '/auth/mfa/verify', { challengeToken: l.body['challengeToken'], webauthnResponse: a.assert(st.body, { uv: false }) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  void wa;
});
