/**
 * Gateway auth HTTP contract (v7.0.0): /auth/login, /auth/refresh, /auth/logout,
 * password reset, revocation hooks (password change, admin reset/deactivate)
 * and requireAdmin MFA enforcement (fail closed).
 * Express app on an ephemeral loopback port; Prisma via globalThis.__prisma,
 * Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/routes/auth.test.ts  (in packages/api-gateway)
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
const { authRouter } = await import('./auth.js');
const { userRouter } = await import('./user.js');
const { adminMailboxesRouter } = await import('./admin/mailboxes.js');
const { requireAdmin } = await import('../middleware/auth.js');

const PW = 'correct horse battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let pwHash = '';
let server: Server;
let base = '';

before(async () => {
  pwHash = await core.hashPassword(PW);
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/api/v1/user', userRouter);
  app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
  app.get('/api/v1/admin/ping', requireAdmin, (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
});

async function post(path: string, body: unknown, token?: string, method = 'POST') {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function addUser(email: string, extra: Record<string, unknown> = {}) {
  return db.user.create({ data: { email, passwordHash: pwHash, displayName: email, ...extra } });
}

async function loginOk(email: string) {
  const r = await post('/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { accessToken: string; refreshToken: string };
}

test('POST /auth/login: 400 / 401 / 200 tokens / MFA challenge / 503 maintenance', async () => {
  const u = await addUser('alice@example.com');
  await addUser('admin@example.com', { role: 'SERVER_MANAGEMENT' });
  assert.equal((await post('/auth/login', { email: 'nope' })).status, 400);
  assert.equal((await post('/auth/login', { email: 'alice@example.com', password: 'bad' })).status, 401);
  assert.equal((await post('/auth/login', { email: 'ghost@example.com', password: PW })).status, 401);
  const ok = await loginOk('alice@example.com');
  assert.ok(ok.accessToken && ok.refreshToken);
  assert.equal(db.session.rows[0]!['tokenHash'], sauth.hashRefreshToken(ok.refreshToken));

  await db.userMfa.create({ data: { userId: u['id'], totpSecret: sauth.encryptMfaSecret(SECRET), totpEnabled: true } });
  const mfa = await post('/auth/login', { email: 'alice@example.com', password: PW });
  assert.equal(mfa.status, 200);
  assert.equal(mfa.body['mfaRequired'], true);
  assert.match(String(mfa.body['challengeToken']), /^[0-9a-f]{64}$/);
  assert.equal(mfa.body['accessToken'], undefined);

  await db.serverSettings.create({ data: { id: 'singleton', maintenanceMode: true, maintenanceMessage: 'later' } });
  const m = await post('/auth/login', { email: 'alice@example.com', password: PW });
  assert.equal(m.status, 503);
  assert.deepEqual(m.body, { error: 'maintenance', message: 'later' });
  assert.equal((await post('/auth/login', { email: 'admin@example.com', password: PW })).status, 200);
});

test('POST /auth/refresh: rotation, reuse revokes, inactive user rejected', async () => {
  const u = await addUser('alice@example.com');
  const t = await loginOk('alice@example.com');
  const r1 = await post('/auth/refresh', { refreshToken: t.refreshToken });
  assert.equal(r1.status, 200);
  assert.ok(r1.body['refreshToken'] && r1.body['refreshToken'] !== t.refreshToken);
  const reuse = await post('/auth/refresh', { refreshToken: t.refreshToken });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body['code'], 'REFRESH_REUSED');
  assert.equal((await post('/auth/refresh', { refreshToken: r1.body['refreshToken'] })).status, 401, 'family revoked');

  const t2 = await loginOk('alice@example.com');
  await db.user.update({ where: { id: u['id'] }, data: { active: false } });
  const inactive = await post('/auth/refresh', { refreshToken: t2.refreshToken });
  assert.equal(inactive.status, 401);
  assert.equal(inactive.body['code'], 'REFRESH_INACTIVE');
});

test('POST /auth/logout: revokes the session, refresh then fails', async () => {
  await addUser('alice@example.com');
  const t = await loginOk('alice@example.com');
  assert.deepEqual((await post('/auth/logout', { refreshToken: t.refreshToken })).body, { ok: true });
  assert.equal(db.session.rows.length, 0);
  assert.equal((await post('/auth/refresh', { refreshToken: t.refreshToken })).status, 401);
  assert.equal((await post('/auth/logout', {})).status, 200);
});

test('change-password: min length from settings, other sessions revoked, current kept', async () => {
  await db.serverSettings.create({ data: { id: 'singleton', minPasswordLength: 14 } });
  await addUser('alice@example.com');
  const current = await loginOk('alice@example.com');
  const other = await loginOk('alice@example.com');
  const short = await post('/api/v1/user/change-password', { currentPassword: PW, newPassword: 'twelve-chars' }, current.accessToken);
  assert.equal(short.status, 400);
  const ok = await post('/api/v1/user/change-password', { currentPassword: PW, newPassword: 'a-much-longer-password' }, current.accessToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.session.rows.length, 1);
  assert.equal((await post('/auth/refresh', { refreshToken: other.refreshToken })).status, 401);
  assert.equal((await post('/auth/refresh', { refreshToken: current.refreshToken })).status, 200);
  // The other session's access token is rejected immediately
  const r = await fetch(`${base}/api/v1/admin/ping`, { headers: { Authorization: `Bearer ${other.accessToken}` } });
  assert.equal(r.status, 401);
});

test('admin: password reset and deactivation revoke the target user sessions; min length enforced', async () => {
  await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  const target = await addUser('bob@example.com');
  const admin = await loginOk('admin@example.com');
  const bob = await loginOk('bob@example.com');
  const tooShort = await post(`/api/v1/admin/mailboxes/${target['id']}`, { password: 'short' }, admin.accessToken, 'PUT');
  assert.equal(tooShort.status, 400);
  const reset = await post(`/api/v1/admin/mailboxes/${target['id']}`, { password: 'new-secure-password' }, admin.accessToken, 'PUT');
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(db.session.rows.filter((s) => s['userId'] === target['id']).length, 0);
  assert.equal((await post('/auth/refresh', { refreshToken: bob.refreshToken })).status, 401);

  await db.user.update({ where: { id: target['id'] }, data: { passwordHash: pwHash } });
  const bob2 = await loginOk('bob@example.com');
  await db.appPassword.create({ data: { userId: target['id'], name: 'phone', hash: 'h' } });
  const deact = await post(`/api/v1/admin/mailboxes/${target['id']}`, { active: false }, admin.accessToken, 'PUT');
  assert.equal(deact.status, 200);
  assert.equal((await post('/auth/refresh', { refreshToken: bob2.refreshToken })).status, 401);
  assert.equal(db.appPassword.rows.length, 1, 'app passwords are kept on deactivation');
});

test('requireAdmin: requireMfaForAdmins needs enrolment AND an MFA-verified session; fails closed', async () => {
  const a = await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  const ping = (tok: string) => fetch(`${base}/api/v1/admin/ping`, { headers: { Authorization: `Bearer ${tok}` } })
    .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  const t = await loginOk('admin@example.com');
  assert.equal((await ping(t.accessToken)).status, 200);

  await db.serverSettings.create({ data: { id: 'singleton', requireMfaForAdmins: true } });
  assert.equal((await ping(t.accessToken)).body['code'], 'MFA_REQUIRED');

  await db.userMfa.create({ data: { userId: a['id'], totpSecret: sauth.encryptMfaSecret(SECRET), totpEnabled: true } });
  assert.equal((await ping(t.accessToken)).body['code'], 'MFA_NOT_VERIFIED');

  const ch = await post('/auth/login', { email: 'admin@example.com', password: PW });
  const verified = await sauth.completeMfaLogin(
    { challengeToken: String(ch.body['challengeToken']), code: sauth.totpCode(SECRET) },
    { ip: '127.0.0.1', userAgent: 't' },
  );
  assert.equal(verified.kind, 'tokens');
  if (verified.kind !== 'tokens') return;
  assert.equal((await ping(verified.tokens.accessToken)).status, 200);
  // mfaVerified survives refresh
  const r = await post('/auth/refresh', { refreshToken: verified.tokens.refreshToken });
  assert.equal((await ping(String(r.body['accessToken']))).status, 200);

  const orig = db.serverSettings.findUnique;
  db.serverSettings.findUnique = async () => { throw new Error('db down'); };
  try {
    assert.equal((await ping(verified.tokens.accessToken)).status, 503);
  } finally {
    db.serverSettings.findUnique = orig;
  }
});

test('password reset: single use over HTTP', async () => {
  const u = await addUser('alice@example.com');
  const raw = await sauth.createPasswordResetToken(u['id'] as string, 'ip');
  assert.equal((await post('/auth/reset-password', { token: raw, newPassword: 'another-good-password' })).status, 200);
  assert.equal((await post('/auth/reset-password', { token: raw, newPassword: 'another-good-password' })).status, 400);
});
