/**
 * Regression (e2e 7.0.0): /auth/app-passwords accepted the access token of a
 * logged-out session (only the JWT signature was checked) — a stolen access
 * token could mint a persistent app password after the victim logged out.
 * v8.1: creating an app password needs re-authentication (currentPassword or
 * mfaCode) and sends a security notice to the user's INBOX; the old admin
 * session-revocation endpoint answers 410.
 * 9.4: with Webmail switched off, the account-security routes answer 403
 * PROTOCOL_DISABLED to accounts without an admin role; admins keep them.
 * Run: node --import tsx --test src/router/app-passwords.test.ts  (in packages/auth-service)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null; // policy change events: publish nothing

const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const { createApp } = await import('../app.js');

const notices: Array<{ userId: string; subject: string; bodyText: string }> = [];
sauth.setSecurityNotifier(async (n) => { notices.push(n); });

const PW = 'correct horse battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let server: Server;
let base = '';

before(async () => {
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: 'mail.example.org' } });
  await db.user.create({ data: { email: 'bob@example.com', passwordHash: await core.hashPassword(PW) } });
  const carol = await db.user.create({ data: { email: 'carol@example.com', passwordHash: await core.hashPassword(PW) } });
  await db.userMfa.create({ data: { userId: carol['id'], totpSecret: sauth.encryptMfaSecret(SECRET), totpEnabled: true } });
  await new Promise<void>((resolve) => { server = createApp().listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

test('app passwords: live session may create; after logout the access token is refused', async () => {
  const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = String(login.body['accessToken']);
  const before = db.appPassword.rows.length;
  assert.equal((await call('POST', '/auth/app-passwords', { name: 'phone', currentPassword: PW }, token)).status, 201);

  assert.equal((await call('POST', '/auth/logout', { refreshToken: login.body['refreshToken'] })).status, 200);
  assert.equal((await call('POST', '/auth/app-passwords', { name: 'attacker', currentPassword: PW }, token)).status, 401);
  assert.equal((await call('GET', '/auth/app-passwords', undefined, token)).status, 401);
  assert.equal(db.appPassword.rows.length, before + 1);
});

test('9.4 webmail policy: module "App-Passwörter" off → list and create 403 FEATURE_DISABLED, revoke still works', async () => {
  const storage = await import('@coremail/storage');
  const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  const token = String(login.body['accessToken']);
  const created = await call('POST', '/auth/app-passwords', { name: 'tablet', currentPassword: PW }, token);
  assert.equal(created.status, 201);
  await storage.updateWebmailPolicy({ level: 'global' }, { features: { appPasswords: 'off' } });
  try {
    const list = await call('GET', '/auth/app-passwords', undefined, token);
    assert.equal(list.status, 403);
    assert.equal(list.body['code'], 'FEATURE_DISABLED');
    assert.equal((await call('POST', '/auth/app-passwords', { name: 'x', currentPassword: PW }, token)).status, 403);
    assert.equal((await call('DELETE', `/auth/app-passwords/${String(created.body['id'])}`, undefined, token)).status, 200);
  } finally {
    await storage.updateWebmailPolicy({ level: 'global' }, { features: { appPasswords: 'on' } });
  }
});

test('app passwords: creation needs re-authentication (REAUTH_REQUIRED / REAUTH_FAILED)', async () => {
  const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  const token = String(login.body['accessToken']);
  const before = db.appPassword.rows.length;

  const missing = await call('POST', '/auth/app-passwords', { name: 'no-reauth' }, token);
  assert.equal(missing.status, 403);
  assert.equal(missing.body['code'], 'REAUTH_REQUIRED');

  const wrong = await call('POST', '/auth/app-passwords', { name: 'wrong', currentPassword: 'nope' }, token);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body['code'], 'REAUTH_FAILED');

  const badCode = await call('POST', '/auth/app-passwords', { name: 'wrong', mfaCode: '123456' }, token);
  assert.equal(badCode.status, 403);
  assert.equal(db.appPassword.rows.length, before, 'nothing created');
});

test('app passwords: creation sends a security notice to the own INBOX', async () => {
  const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  const token = String(login.body['accessToken']);
  const bob = db.user.rows.find((u) => u['email'] === 'bob@example.com')!;
  notices.length = 0;
  const r = await call('POST', '/auth/app-passwords', { name: 'Thunderbird', currentPassword: PW }, token);
  assert.equal(r.status, 201);
  assert.match(String(r.body['password']), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  await new Promise((res) => setImmediate(res));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.userId, bob['id']);
  assert.match(notices[0]!.subject, /app password/i);
  assert.match(notices[0]!.bodyText, /Thunderbird/);
  assert.ok(!notices[0]!.bodyText.includes(String(r.body['password'])), 'the secret is never mailed');
});

test('app passwords: an MFA user can re-authenticate with a TOTP code instead of the password', async () => {
  const login = await call('POST', '/auth/login', { email: 'carol@example.com', password: PW });
  assert.equal(login.body['mfaRequired'], true);
  const verified = await call('POST', '/auth/mfa/verify', { challengeToken: login.body['challengeToken'], code: sauth.totpCode(SECRET) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const token = String(verified.body['accessToken']);
  // the login code was consumed (replay protection) — use the next step's code
  const next = sauth.totpCode(SECRET, Date.now() + 30_000);
  const r = await call('POST', '/auth/app-passwords', { name: 'tablet', mfaCode: next }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('sessions: the old admin revoke endpoint is gone (410), even for admins', async () => {
  const admin = await db.user.create({ data: { email: 'admin@example.com', passwordHash: await core.hashPassword(PW), role: 'ORGANIZATION_MANAGEMENT' } });
  const bob = db.user.rows.find((u) => u['email'] === 'bob@example.com')!;
  const login = await call('POST', '/auth/login', { email: 'admin@example.com', password: PW });
  const sessionsBefore = db.session.rows.filter((s) => s['userId'] === bob['id']).length;
  const r = await call('DELETE', `/auth/sessions/admin/${String(bob['id'])}`, undefined, String(login.body['accessToken']));
  assert.equal(r.status, 410);
  assert.equal(r.body['code'], 'ENDPOINT_REMOVED');
  assert.equal(db.session.rows.filter((s) => s['userId'] === bob['id']).length, sessionsBefore, 'nothing revoked');
  assert.ok(admin['id']);
});

test('9.4: Webmail off → account-security routes 403 PROTOCOL_DISABLED, admins keep them, login refused for users', async () => {
  const storage = await import('@coremail/storage');
  const userLogin = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  const adminLogin = await call('POST', '/auth/login', { email: 'admin@example.com', password: PW });
  await db.protocolPolicy.create({ data: { id: 'global', webmail: 'OFF' } });
  storage.invalidateProtocolAccessCache();
  try {
    const refused = await call('GET', '/auth/app-passwords', undefined, String(userLogin.body['accessToken']));
    assert.equal(refused.status, 403);
    assert.equal(refused.body['code'], 'PROTOCOL_DISABLED');
    assert.equal((await call('GET', '/auth/sessions', undefined, String(userLogin.body['accessToken']))).status, 403);
    assert.equal((await call('GET', '/auth/mfa/status', undefined, String(userLogin.body['accessToken']))).status, 403);
    assert.equal((await call('GET', '/auth/mfa/status', undefined, String(adminLogin.body['accessToken']))).status, 200);
    const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
    assert.equal(login.status, 403);
    assert.equal(login.body['code'], 'PROTOCOL_DISABLED');
    assert.equal((await call('POST', '/auth/refresh', { refreshToken: userLogin.body['refreshToken'] })).status, 403);
  } finally {
    db.protocolPolicy.rows = [];
    storage.invalidateProtocolAccessCache();
  }
  assert.equal((await call('GET', '/auth/app-passwords', undefined, String(userLogin.body['accessToken']))).status, 200);
});
