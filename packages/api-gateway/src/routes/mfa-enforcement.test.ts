/**
 * 10.5: "MFA für alle Benutzer erzwingen" at the gateway — the status endpoint,
 * requireAuth gating (403 MFA_ENROLMENT_REQUIRED outside the enrolment
 * allow-list), the grace period, the SSO trust path (an MFA-verified session
 * satisfies the rule), the admin surface, the security-settings save
 * (activation time, audit diff, RBAC) and the pure helpers.
 * Express app on an ephemeral loopback port; Prisma via globalThis.__prisma,
 * Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/routes/mfa-enforcement.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
const auditRows: Record<string, unknown>[] = [];
(db as unknown as Record<string, unknown>)['auditLog'] = {
  create: async (a: { data: Record<string, unknown> }) => { auditRows.push(a.data); return a.data; },
};
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const { authRouter } = await import('./auth.js');
const { userRouter } = await import('./user.js');
const { mfaEnforcementRouter } = await import('./mfa-enforcement.js');
const { adminGlobalSettingsRouter, mfaPolicyChange } = await import('./admin/global-settings.js');
const { requireAuth, requireAdmin, mfaEnrolmentAllowed, clearCurrentRoleCache } = await import('../middleware/auth.js');

const PW = 'correct horse battery';
let pwHash = '';
let server: Server;
let base = '';

before(async () => {
  pwHash = await core.hashPassword(PW);
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/api/v1/user/mfa-enforcement', mfaEnforcementRouter);
  app.use('/api/v1/user', userRouter);
  app.use('/api/v1/admin/settings', adminGlobalSettingsRouter);
  app.get('/api/v1/mail/ping', requireAuth, (_req, res) => { res.json({ ok: true }); });
  app.get('/api/v1/admin/ping', requireAdmin, (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'serverSettings', 'domain', 'webAuthnCredential'] as const) db[t].rows = [];
  redis.store.clear();
  auditRows.length = 0;
  sauth.invalidateMfaEnforcementCache();
  clearCurrentRoleCache();
  await db.domain.create({ data: { id: 'dom1', name: 'example.com', primary: true } });
});

async function call(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function addUser(email: string, extra: Record<string, unknown> = {}) {
  return db.user.create({ data: { email, passwordHash: pwHash, displayName: email, domainId: 'dom1', ...extra } });
}

async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return String(r.body['accessToken']);
}

async function enforce(over: Record<string, unknown> = {}) {
  await db.serverSettings.create({ data: { id: 'singleton', requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0, ...over } });
  sauth.invalidateMfaEnforcementCache();
}

test('switch off (default): no gating, state "off"', async () => {
  await addUser('alice@example.com');
  const t = await login('alice@example.com');
  assert.equal((await call('GET', '/api/v1/mail/ping', t)).status, 200);
  assert.deepEqual((await call('GET', '/api/v1/user/mfa-enforcement', t)).body, { state: 'off', canEnrol: true });
});

test('after the grace period: 403 MFA_ENROLMENT_REQUIRED everywhere except status and profile', async () => {
  await addUser('alice@example.com');
  await enforce();
  const t = await login('alice@example.com'); // the password login itself still works
  const ping = await call('GET', '/api/v1/mail/ping', t);
  assert.equal(ping.status, 403);
  assert.equal(ping.body['code'], 'MFA_ENROLMENT_REQUIRED');
  assert.ok(typeof ping.body['deadline'] === 'string');
  const s = await call('GET', '/api/v1/user/mfa-enforcement', t);
  assert.equal(s.status, 200);
  assert.equal(s.body['state'], 'required');
  assert.equal(s.body['canEnrol'], true);
  assert.equal((await call('GET', '/api/v1/user/profile', t)).status, 200, 'the webmail login loads the profile');
  assert.equal((await call('PUT', '/api/v1/user/profile', t, { displayName: 'x' })).body['code'], 'MFA_ENROLMENT_REQUIRED', 'writes are not allowed');
  assert.equal((await call('POST', '/auth/logout', t, {})).status < 400, true, 'logout stays possible');
});

test('grace period: everything works, state "grace" with the deadline', async () => {
  await addUser('alice@example.com');
  await enforce({ mfaEnforcementGraceDays: 7 });
  const t = await login('alice@example.com');
  assert.equal((await call('GET', '/api/v1/mail/ping', t)).status, 200);
  const s = await call('GET', '/api/v1/user/mfa-enforcement', t);
  assert.equal(s.body['state'], 'grace');
  const deadline = Date.parse(String(s.body['deadline']));
  assert.ok(deadline > Date.now() + 6.9 * 86_400_000 && deadline <= Date.now() + 7 * 86_400_000);
});

test('enrolled accounts are not gated; enrolment (mfa-change) lifts the gate at once', async () => {
  const u = await addUser('alice@example.com');
  await enforce();
  const t = await login('alice@example.com');
  assert.equal((await call('GET', '/api/v1/mail/ping', t)).status, 403);
  // 10.6: a security key / passkey row (the factor helper reads the table)
  await db.webAuthnCredential.create({ data: { userId: u['id'], credentialId: 'k', kind: 'security_key' } });
  await sauth.publishUserAuthChange(String(u['id']), 'mfa-change');
  assert.equal((await call('GET', '/api/v1/mail/ping', t)).status, 200, 'old session: enrolled is enough for the user rule');
});

test('SSO trust path: a session established with (trusted) MFA satisfies the rule', async () => {
  const u = await addUser('sso@example.com', { passwordHash: null, authSource: 'OIDC' });
  await enforce();
  const plain = await sauth.issueSession({ id: String(u['id']), email: 'sso@example.com', role: 'USER', domainId: 'dom1' } as never,
    { ip: '127.0.0.1', userAgent: 't', mfaVerified: false });
  const s = await call('GET', '/api/v1/user/mfa-enforcement', plain.accessToken);
  assert.equal(s.body['state'], 'required');
  assert.equal(s.body['canEnrol'], false, 'SSO-only account: no password to confirm an enrolment');
  const viaIdp = await sauth.issueSession({ id: String(u['id']), email: 'sso@example.com', role: 'USER', domainId: 'dom1' } as never,
    { ip: '127.0.0.1', userAgent: 't', mfaVerified: true });
  assert.equal((await call('GET', '/api/v1/mail/ping', viaIdp.accessToken)).status, 200);
});

test('admin surface: an un-enrolled admin gets MFA_ENROLMENT_REQUIRED (BCP shows the MFA page)', async () => {
  await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  await enforce();
  const t = await login('admin@example.com');
  assert.equal((await call('GET', '/api/v1/admin/ping', t)).body['code'], 'MFA_ENROLMENT_REQUIRED');
});

test('PUT /admin/settings/security: switching on writes mfaEnforcementSince and an audit diff; organisation management only', async () => {
  await addUser('org@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  await addUser('srv@example.com', { role: 'SERVER_MANAGEMENT' });
  await db.serverSettings.create({ data: { id: 'singleton' } });
  const srv = await login('srv@example.com');
  const denied = await call('PUT', '/api/v1/admin/settings/security', srv, { requireMfaForAllUsers: true });
  assert.equal(denied.status, 403, 'SERVER_MANAGEMENT only reads the organisation area');

  const org = await login('org@example.com');
  const r = await call('PUT', '/api/v1/admin/settings/security', org,
    { requireMfaForAllUsers: true, mfaEnforcementGraceDays: 14, mfaEnforcementBlocksPrimaryPassword: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.serverSettings.rows[0]!;
  assert.equal(row['requireMfaForAllUsers'], true);
  assert.equal(row['mfaEnforcementGraceDays'], 14);
  assert.ok(row['mfaEnforcementSince'] instanceof Date);
  await new Promise((res) => setTimeout(res, 20)); // audit() is fire-and-forget
  const entry = auditRows.find((a) => a['action'] === 'settings.mfa-policy.update');
  assert.ok(entry, 'audit entry written');
  assert.deepEqual(entry!['changes'], {
    requireMfaForAllUsers: { from: 'false', to: 'true' },
    mfaEnforcementGraceDays: { from: '7', to: '14' },
    mfaEnforcementBlocksPrimaryPassword: { from: 'false', to: 'true' },
  });

  const since = (row['mfaEnforcementSince'] as Date).getTime();
  auditRows.length = 0;
  await call('PUT', '/api/v1/admin/settings/security', org, { requireMfaForAllUsers: true, minPasswordLength: 10 });
  assert.equal((db.serverSettings.rows[0]!['mfaEnforcementSince'] as Date).getTime(), since, 'staying on keeps the activation time');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(auditRows.filter((a) => a['action'] === 'settings.mfa-policy.update').length, 0, 'no MFA diff, no MFA entry');

  assert.equal((await call('PUT', '/api/v1/admin/settings/security', org, { mfaEnforcementGraceDays: 91 })).status, 400, 'grace bounded to 90 days');
});

test('pure helpers: enrolment allow-list and the MFA policy diff', () => {
  assert.equal(mfaEnrolmentAllowed('GET', '/api/v1/user/mfa-enforcement'), true);
  assert.equal(mfaEnrolmentAllowed('GET', '/api/v1/user/profile?x=1'), true);
  assert.equal(mfaEnrolmentAllowed('PUT', '/api/v1/user/profile'), false);
  assert.equal(mfaEnrolmentAllowed('GET', '/api/v1/user/profile/photo'), false);
  assert.equal(mfaEnrolmentAllowed('GET', '/api/v1/mail/folders'), false);

  const now = new Date('2026-11-20T00:00:00Z');
  assert.deepEqual(mfaPolicyChange({ requireMfaForAllUsers: false }, { requireMfaForAllUsers: true }, now),
    { changes: { requireMfaForAllUsers: { from: 'false', to: 'true' } }, since: now });
  assert.deepEqual(mfaPolicyChange(null, { requireMfaForAdmins: true }, now),
    { changes: { requireMfaForAdmins: { from: 'false', to: 'true' } }, since: null });
  assert.deepEqual(mfaPolicyChange({ requireMfaForAllUsers: true }, { requireMfaForAllUsers: true }, now), { changes: {}, since: null });
  assert.equal(mfaPolicyChange({ requireMfaForAllUsers: true }, { requireMfaForAllUsers: false }, now).since, null);
});
