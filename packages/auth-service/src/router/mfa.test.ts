/**
 * auth-service MFA endpoints (v7.0.0): delegated login + /auth/mfa/verify
 * (TOTP / backup code), re-authentication for MFA changes, WebAuthn auth start
 * bound to the MFA challenge, separate registration/authentication keys.
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/router/mfa.test.ts  (in packages/auth-service)
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

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const { createApp } = await import('../app.js');

const PW = 'correct horse battery';
let pwHash = '';
let server: Server;
let base = '';

before(async () => {
  pwHash = await core.hashPassword(PW);
  await new Promise<void>((resolve) => { server = createApp().listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: 'mail.example.org' } });
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function userWithSession(email = 'alice@example.com') {
  const u = await db.user.create({ data: { email, passwordHash: pwHash } });
  const r = await call('POST', '/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: u['id'] as string, token: String(r.body['accessToken']) };
}

test('TOTP setup / disable / backup codes / WebAuthn registration require re-authentication', async () => {
  const { id, token } = await userWithSession();
  assert.equal((await call('POST', '/auth/mfa/totp/setup', {}, token)).body['code'], 'REAUTH_REQUIRED');
  const wrongPw = await call('POST', '/auth/mfa/totp/setup', { currentPassword: 'wrong' }, token);
  assert.equal(wrongPw.body['code'], 'REAUTH_FAILED');
  assert.equal(wrongPw.status, 403, 'wrong re-auth is 403 so the frontend does not refresh + log out');
  const setup = await call('POST', '/auth/mfa/totp/setup', { currentPassword: PW }, token);
  assert.equal(setup.status, 200);
  const secret = String(setup.body['secret']);
  assert.match(String(db.userMfa.rows[0]!['totpSecret']), /^v1:/, 'secret encrypted at rest');

  assert.equal((await call('POST', '/auth/mfa/totp/confirm', { code: '000000' }, token)).status, 400);
  assert.equal((await call('POST', '/auth/mfa/totp/confirm', { code: sauth.totpCode(secret) }, token)).status, 200);
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], true);

  // An active TOTP is never overwritten silently
  const again = await call('POST', '/auth/mfa/totp/setup', { currentPassword: PW }, token);
  assert.equal(again.status, 409);
  assert.equal(again.body['code'], 'TOTP_ALREADY_ENABLED');

  assert.equal((await call('POST', '/auth/mfa/backup-codes/generate', {}, token)).status, 403);
  const codes = await call('POST', '/auth/mfa/backup-codes/generate', { currentPassword: PW }, token);
  assert.equal((codes.body['codes'] as string[]).length, 10);

  assert.equal((await call('POST', '/auth/mfa/webauthn/register/start', { email: 'alice@example.com' }, token)).status, 403);
  const reg = await call('POST', '/auth/mfa/webauthn/register/start', { email: 'alice@example.com', mfaCode: (codes.body['codes'] as string[])[0] }, token);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal((reg.body['rp'] as { id: string }).id, 'mail.example.org', 'RP ID from publicHostname');
  assert.ok(redis.store.has(`coremail:webauthn:reg:${id}`));

  assert.equal((await call('DELETE', '/auth/mfa/totp', {}, token)).status, 403);
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], true);
  assert.equal((await call('DELETE', '/auth/mfa/totp', { currentPassword: PW }, token)).status, 200);
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], false);
});

test('TOTP setup publishes no mfa-change event; the confirmation does (8.0.0)', async () => {
  const { id, token } = await userWithSession('carol@example.com');
  const events: string[] = [];
  const off = core.onAuthInvalidation((e) => { if (e.userId === id) events.push(String(e.reason)); });
  try {
    const setup = await call('POST', '/auth/mfa/totp/setup', { currentPassword: PW }, token);
    assert.equal(setup.status, 200);
    assert.deepEqual(events, [], 'a pending (unconfirmed) secret ends no live connection');
    const ok = await call('POST', '/auth/mfa/totp/confirm', { code: sauth.totpCode(String(setup.body['secret'])) }, token);
    assert.equal(ok.status, 200);
    assert.deepEqual(events, ['mfa-change']);
  } finally {
    off();
  }
});

test('POST /auth/mfa/verify accepts {challengeToken, code} with a backup code; session is mfaVerified', async () => {
  const { id } = await userWithSession();
  await db.userMfa.upsert({ where: { userId: id }, create: { userId: id, totpSecret: sauth.encryptMfaSecret('JBSWY3DPEHPK3PXP'), totpEnabled: true }, update: {} });
  const codes = await sauth.regenerateBackupCodes(id);
  const ch = await call('POST', '/auth/login', { email: 'alice@example.com', password: PW });
  assert.equal(ch.body['mfaRequired'], true);
  assert.deepEqual(ch.body['methods'], ['totp', 'backup_code']);
  const ok = await call('POST', '/auth/mfa/verify', { challengeToken: ch.body['challengeToken'], code: codes[4]!.toLowerCase() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(core.verifyAccessToken(String(ok.body['accessToken']))!.mfaVerified, true);
  const reuse = await call('POST', '/auth/mfa/verify', { challengeToken: ch.body['challengeToken'], code: codes[5] });
  assert.equal(reuse.status, 401, 'challenge consumed');
});

test('POST /auth/mfa/verify: attempt limit per challenge', async () => {
  const { id } = await userWithSession();
  await db.userMfa.upsert({ where: { userId: id }, create: { userId: id, totpSecret: sauth.encryptMfaSecret('JBSWY3DPEHPK3PXP'), totpEnabled: true }, update: {} });
  const ch = await call('POST', '/auth/login', { email: 'alice@example.com', password: PW });
  let last = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < 5; i++) last = await call('POST', '/auth/mfa/verify', { challengeToken: ch.body['challengeToken'], code: '123456' });
  assert.equal(last.body['code'], 'MFA_CHALLENGE_EXHAUSTED');
  const right = await call('POST', '/auth/mfa/verify', { challengeToken: ch.body['challengeToken'], code: sauth.totpCode('JBSWY3DPEHPK3PXP') });
  assert.equal(right.status, 401);
});

test('POST /auth/mfa/webauthn/auth/start requires a valid MFA challengeToken (not a userId)', async () => {
  const { id } = await userWithSession();
  await db.userMfa.upsert({
    where: { userId: id },
    create: { userId: id, webAuthnCredentials: [{ id: 'Y3JlZDE', publicKey: 'AAAA', counter: 0, name: 'key' }] },
    update: {},
  });
  assert.equal((await call('POST', '/auth/mfa/webauthn/auth/start', { userId: id })).status, 400);
  assert.equal((await call('POST', '/auth/mfa/webauthn/auth/start', { challengeToken: 'a'.repeat(64) })).status, 401);

  const ch = await call('POST', '/auth/login', { email: 'alice@example.com', password: PW });
  assert.equal(ch.body['method'], 'webauthn');
  const token = String(ch.body['challengeToken']);
  const start = await call('POST', '/auth/mfa/webauthn/auth/start', { challengeToken: token });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body['rpId'], 'mail.example.org');
  assert.ok(redis.store.has(`coremail:webauthn:auth:${token}`), 'authentication key bound to the challenge');
  assert.ok(!redis.store.has(`coremail:webauthn:reg:${id}`), 'registration key untouched');
  assert.ok(![...redis.store.keys()].includes(`coremail:webauthn:challenge:${id}`));

  // A TOTP-only challenge cannot start WebAuthn
  db.userMfa.rows = [];
  await db.userMfa.create({ data: { userId: id, totpSecret: sauth.encryptMfaSecret('JBSWY3DPEHPK3PXP'), totpEnabled: true } });
  const ch2 = await call('POST', '/auth/login', { email: 'alice@example.com', password: PW });
  assert.equal((await call('POST', '/auth/mfa/webauthn/auth/start', { challengeToken: ch2.body['challengeToken'] })).status, 401);
});

test('auth-service /auth/login, /auth/refresh, /auth/logout delegate to the shared login service', async () => {
  await db.user.create({ data: { email: 'bob@example.com', passwordHash: pwHash } });
  assert.equal((await call('POST', '/auth/login', { email: 'bob@example.com', password: 'x' })).status, 401);
  const t = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  assert.equal(db.session.rows[0]!['tokenHash'], sauth.hashRefreshToken(String(t.body['refreshToken'])));
  const r = await call('POST', '/auth/refresh', { refreshToken: t.body['refreshToken'] });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: t.body['refreshToken'] })).status, 401);
  await call('POST', '/auth/logout', { refreshToken: r.body['refreshToken'] });
  assert.equal(db.session.rows.length, 0);
});

test('v8.1: /auth/mfa/verify for a browser client sets the refresh cookie (cm_rt / cm_rt_bcp), no body token', async () => {
  const u = await db.user.create({ data: { email: 'dora@example.com', passwordHash: pwHash } });
  await db.userMfa.create({ data: { userId: u['id'], totpSecret: sauth.encryptMfaSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), totpEnabled: true } });
  const verify = async (headers: Record<string, string>, at = Date.now()) => {
    const ch = await call('POST', '/auth/login', { email: 'dora@example.com', password: PW });
    assert.equal(ch.body['mfaRequired'], true);
    const r = await fetch(`${base}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ challengeToken: ch.body['challengeToken'], code: sauth.totpCode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', at) }),
    });
    return { status: r.status, setCookie: r.headers.getSetCookie(), body: (await r.json()) as Record<string, unknown> };
  };
  const web = await verify({ 'X-CoreMail-Client': 'web', Origin: 'https://mail.example.org' });
  assert.equal(web.status, 200, JSON.stringify(web.body));
  assert.ok(web.body['accessToken']);
  assert.equal(web.body['refreshToken'], undefined);
  const c = web.setCookie.find((s) => s.startsWith('cm_rt='))!;
  assert.match(c, /; Path=\/auth;.*; HttpOnly; SameSite=Strict; Secure$/);

  const bcp = await verify({ 'X-CoreMail-Client': 'web', 'X-CoreMail-App': 'bcp' }, Date.now() + 30_000);
  assert.ok(bcp.setCookie.some((s) => s.startsWith('cm_rt_bcp=')));
  assert.ok(!bcp.setCookie.some((s) => /Secure/.test(s)), 'plain http → no Secure');

  await db.userMfa.update({ where: { userId: u['id'] }, data: { totpLastUsedStep: null } }); // allow the current step again
  const cli = await verify({});
  assert.ok(cli.body['refreshToken'], 'non-browser clients keep the body token');
  assert.equal(cli.setCookie.length, 0);
});
