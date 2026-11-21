/**
 * 10.6: MFA policy API — PUT/GET /admin/settings/mfa-policy (organisation),
 * per-user overrides /admin/user-mfa (recipients, scoped, admins never weakened
 * by non-org admins), remembered-device revocation (admin + own), the admin
 * MFA status for the BCP prompt, and the audit entries. Infra-free.
 * Run: node --import tsx --test src/routes/admin/mfa-policy.test.ts  (in packages/api-gateway)
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
const { adminGlobalSettingsRouter } = await import('./global-settings.js');
const { adminUserMfaRouter, adminMfaStatusRouter, overrideChangeAllowed } = await import('./user-mfa.js');
const { trustedDevicesRouter } = await import('../trusted-devices.js');
const { mfaEnforcementRouter } = await import('../mfa-enforcement.js');
const { clearCurrentRoleCache } = await import('../../middleware/auth.js');

let server: Server;
let base = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/settings', adminGlobalSettingsRouter);
  app.use('/api/v1/admin/user-mfa', adminUserMfaRouter);
  app.use('/api/v1/admin/mfa-status', adminMfaStatusRouter);
  app.use('/api/v1/user/trusted-devices', trustedDevicesRouter);
  app.use('/api/v1/user/mfa-enforcement', mfaEnforcementRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const SECRET_MFA = { totpEnabled: true, webAuthnCredentials: [] };

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'serverSettings', 'domain', 'adminScope', 'mfaTrustedDevice'] as const) db[t].rows = [];
  redis.store.clear();
  auditRows.length = 0;
  sauth.invalidateMfaEnforcementCache();
  clearCurrentRoleCache();
  await db.domain.create({ data: { id: 'dA', name: 'a.example', primary: true } });
  await db.domain.create({ data: { id: 'dB', name: 'b.example' } });
  await db.serverSettings.create({ data: { id: 'singleton' } });
  // accounts: org admin, scoped recipient manager (domain A), help desk (domain A), users in A and B
  await db.user.create({ data: { id: 'org', email: 'org@a.example', role: 'ORGANIZATION_MANAGEMENT', domainId: 'dA', displayName: 'Org' } });
  await db.user.create({ data: { id: 'srv', email: 'srv@a.example', role: 'SERVER_MANAGEMENT', domainId: 'dA', displayName: 'Srv' } });
  await db.user.create({ data: { id: 'rm', email: 'rm@a.example', role: 'RECIPIENT_MANAGEMENT', domainId: 'dA', displayName: 'Rm' } });
  await db.adminScope.create({ data: { userId: 'rm', domainId: 'dA', domain: { id: 'dA', name: 'a.example' } } });
  await db.user.create({ data: { id: 'hd', email: 'hd@a.example', role: 'HELP_DESK', domainId: 'dA', displayName: 'Hd' } });
  await db.user.create({ data: { id: 'ua', email: 'ua@a.example', domainId: 'dA', displayName: 'Ua' } });
  await db.user.create({ data: { id: 'ub', email: 'ub@b.example', domainId: 'dB', displayName: 'Ub' } });
  for (const id of ['org', 'srv', 'rm']) await db.userMfa.create({ data: { userId: id, ...SECRET_MFA } });
});

function token(userId: string, role: string, domainId = 'dA'): string {
  return core.signAccessToken({
    sub: userId, email: `${userId}@a.example`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
    domainId, sessionId: `s-${userId}`, mfaVerified: true,
  });
}
const ORG = () => token('org', 'ORGANIZATION_MANAGEMENT');
const SRV = () => token('srv', 'SERVER_MANAGEMENT');
const RM = () => token('rm', 'RECIPIENT_MANAGEMENT');
const HD = () => token('hd', 'HELP_DESK');

async function call(method: string, path: string, tok?: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown>, headers: r.headers };
}
const tick = () => new Promise((r) => setTimeout(r, 20)); // audit() is fire-and-forget

// ── Policy (organisation) ─────────────────────────────────────────────────────

test('PUT /settings/mfa-policy: organisation management only; both forms written; audited', async () => {
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', SRV(), { users: 'required' })).status, 403, 'read-only for SERVER_MANAGEMENT');
  assert.equal((await call('GET', '/api/v1/admin/settings/mfa-policy', SRV())).status, 200);
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', RM(), { users: 'required' })).status, 403, 'scoped admins never');

  const r = await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(),
    { users: 'required', admins: 'required', graceDays: 10, adminGraceDays: 7, rememberDays: 60, rememberDaysAdmins: 14 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.serverSettings.rows[0]!;
  assert.equal(row['mfaUserPolicy'], 'REQUIRED');
  assert.equal(row['requireMfaForAllUsers'], true, 'legacy switch in step');
  assert.equal(row['mfaAdminPolicy'], 'REQUIRED');
  assert.equal(row['requireMfaForAdmins'], true);
  assert.ok(row['mfaEnforcementSince'] instanceof Date && row['mfaAdminEnforcementSince'] instanceof Date);
  assert.deepEqual((r.body['policy'] as Record<string, unknown>)['rememberDays'], 60);
  await tick();
  const entry = auditRows.find((a) => a['action'] === 'settings.mfa-policy.update');
  assert.ok(entry, 'audited');
  assert.deepEqual((entry!['changes'] as Record<string, unknown>)['users'], { from: 'optional', to: 'required' });

  // validation: admin grace ≤ 14, admin remember ≤ users remember, unknown fields refused
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { adminGraceDays: 15 })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { rememberDaysAdmins: 61 })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { rememberDays: 366 })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { requireMfaForAdmins: true })).status, 400);
});

test('GET /settings/mfa-policy lists admin accounts with enrolment and effective level (warning data)', async () => {
  await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { admins: 'as_users', users: 'optional' });
  const r = await call('GET', '/api/v1/admin/settings/mfa-policy', ORG());
  const admins = r.body['admins'] as Array<Record<string, unknown>>;
  const hd = admins.find((a) => a['id'] === 'hd')!;
  assert.equal(hd['enrolled'], false);
  assert.deepEqual(hd['effective'], { level: 'optional', source: 'global' }, 'an admin without MFA requirement');
  assert.equal(admins.some((a) => a['id'] === 'ua'), false, 'plain users are not listed');
});

// ── Per-user overrides (recipients, scope) ────────────────────────────────────

test('overrides: a scoped admin sees and changes only its domains (others 404); help desk reads only', async () => {
  const list = await call('GET', '/api/v1/admin/user-mfa', RM());
  const ids = (list.body['items'] as Array<Record<string, unknown>>).map((i) => i['id']);
  assert.ok(ids.includes('ua') && !ids.includes('ub'), 'domain B is outside the scope');
  assert.equal((await call('GET', '/api/v1/admin/user-mfa/ub', RM())).status, 404);
  assert.equal((await call('PUT', '/api/v1/admin/user-mfa/ub', RM(), { mfaPolicy: 'required' })).status, 404);
  assert.equal((await call('PUT', '/api/v1/admin/user-mfa/ua', HD(), { mfaPolicy: 'required' })).status, 403, 'help desk: read only');
  assert.equal((await call('GET', '/api/v1/admin/user-mfa/ua', HD())).status, 200);
  assert.equal((await call('GET', '/api/v1/admin/user-mfa', token('ua', 'USER'))).status, 403);

  db.user.rows.find((u) => u['id'] === 'ua')!['mfaGraceStartedAt'] = new Date('2026-01-01T00:00:00Z');
  const r = await call('PUT', '/api/v1/admin/user-mfa/ua', RM(), { mfaPolicy: 'required' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['effective'], { level: 'required', source: 'user' });
  const ua = db.user.rows.find((u) => u['id'] === 'ua')!;
  assert.equal(ua['mfaPolicy'], 'REQUIRED');
  assert.equal(ua['mfaGraceStartedAt'], null, 'a new override starts a new grace period');
  await tick();
  const entry = auditRows.find((a) => a['action'] === 'mfa.policy.override');
  assert.deepEqual((entry!['changes'] as Record<string, unknown>)['mfaPolicy'], { from: 'inherit', to: 'required' });
  assert.equal((await call('GET', '/api/v1/admin/user-mfa?overrides=1', RM())).body['items'] instanceof Array, true);
  assert.equal((await call('PUT', '/api/v1/admin/user-mfa/ua', RM(), { mfaPolicy: 'inherit' })).status, 200);
  assert.equal(db.user.rows.find((u) => u['id'] === 'ua')!['mfaPolicy'], null);
});

test('overrides: only organisation management may weaken an admin; others may keep or strengthen it', async () => {
  await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { admins: 'required' });
  // help desk account in domain A: effective "required" (admin rule)
  const weaken = await call('PUT', '/api/v1/admin/user-mfa/hd', RM(), { mfaPolicy: 'optional' });
  assert.equal(weaken.status, 403);
  assert.equal(weaken.body['code'], 'MFA_POLICY_WEAKEN_ADMIN');
  assert.equal((await call('PUT', '/api/v1/admin/user-mfa/hd', RM(), { mfaPolicy: 'off' })).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/user-mfa/hd', RM(), { mfaPolicy: 'required' })).status, 200, 'strengthening / keeping is fine');
  const org = await call('PUT', '/api/v1/admin/user-mfa/hd', ORG(), { mfaPolicy: 'optional' });
  assert.equal(org.status, 200);
  assert.equal(org.body['adminWithoutMfaRequirement'], true, 'the UI warns: admin without MFA requirement');
  // pure rule
  assert.equal(overrideChangeAllowed('RECIPIENT_MANAGEMENT', 'USER', 'required', 'off'), true);
  assert.equal(overrideChangeAllowed('RECIPIENT_MANAGEMENT', 'HELP_DESK', 'optional', 'required'), true);
  assert.equal(overrideChangeAllowed('RECIPIENT_MANAGEMENT', 'HELP_DESK', 'required', 'optional'), false);
  assert.equal(overrideChangeAllowed('ORGANIZATION_MANAGEMENT', 'HELP_DESK', 'required', 'off'), true);
});

// ── Remembered devices ────────────────────────────────────────────────────────

async function device(userId: string): Promise<string> {
  const d = await sauth.issueTrustedDevice(userId, 'webmail', 30, { ip: '203.0.113.5', userAgent: 'Mozilla/5.0 Firefox/130.0' });
  return d.id;
}

test('devices: an admin revokes a user\'s devices (audited); admin accounts only by organisation management', async () => {
  await device('ua');
  await device('hd');
  const detail = await call('GET', '/api/v1/admin/user-mfa/ua', RM());
  assert.equal((detail.body['trustedDevices'] as unknown[]).length, 1);
  assert.equal((await call('DELETE', '/api/v1/admin/user-mfa/hd/trusted-devices', RM())).status, 403, 'admin account');
  const r = await call('DELETE', '/api/v1/admin/user-mfa/ua/trusted-devices', RM());
  assert.equal(r.status, 200);
  assert.equal(r.body['revoked'], 1);
  assert.equal((await sauth.listTrustedDevices('ua')).length, 0);
  await tick();
  assert.ok(auditRows.some((a) => a['action'] === 'mfa.trusted-devices.revoke' && a['targetId'] === 'ua'));
  assert.equal((await call('DELETE', '/api/v1/admin/user-mfa/hd/trusted-devices', ORG())).status, 200);
});

test('devices: users list and revoke only their own (audited)', async () => {
  const mine = await device('ua');
  const other = await device('ub');
  const ua = token('ua', 'USER');
  const list = await call('GET', '/api/v1/user/trusted-devices', ua);
  assert.deepEqual((list.body['devices'] as Array<Record<string, unknown>>).map((d) => d['id']), [mine]);
  assert.equal((await call('DELETE', `/api/v1/user/trusted-devices/${other}`, ua)).status, 404, 'not the device of another user');
  assert.equal((await call('DELETE', `/api/v1/user/trusted-devices/${mine}`, ua)).status, 200);
  assert.equal((await sauth.listTrustedDevices('ub')).length, 1);
  await tick();
  assert.ok(auditRows.some((a) => a['action'] === 'user.mfa.trusted-device.revoke'));
  await device('ua');
  assert.equal((await call('DELETE', '/api/v1/user/trusted-devices', ua)).body['revoked'], 1);
});

// ── Admin grace prompt ────────────────────────────────────────────────────────

test('admin grace: /admin/mfa-status and /user/mfa-enforcement name the deadline; after it the admin API answers MFA_REQUIRED', async () => {
  await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { admins: 'required', adminGraceDays: 14 });
  const hd = HD(); // help desk without MFA
  const s = await call('GET', '/api/v1/admin/mfa-status', hd);
  assert.equal(s.status, 200);
  assert.equal(s.body['state'], 'grace');
  assert.ok(s.headers.get('x-coremail-mfa-grace-until'), 'every admin answer carries the prompt flag');
  const e = await call('GET', '/api/v1/user/mfa-enforcement', hd);
  assert.equal(e.body['state'], 'off', 'the webmail is not blocked by the admin rule');
  assert.equal((e.body['admin'] as Record<string, unknown>)['state'], 'grace');
  assert.equal((await call('GET', '/api/v1/admin/mfa-status', token('ua', 'USER'))).status, 403);

  // 15 days later (the rule was switched on before the grace started)
  db.serverSettings.rows[0]!['mfaAdminEnforcementSince'] = new Date(Date.now() - 16 * 86_400_000);
  db.user.rows.find((u) => u['id'] === 'hd')!['mfaGraceStartedAt'] = new Date(Date.now() - 15 * 86_400_000);
  sauth.invalidateMfaEnforcementCache();
  const after = await call('GET', '/api/v1/admin/user-mfa/ua', hd);
  assert.equal(after.status, 403);
  assert.equal(after.body['code'], 'MFA_REQUIRED');
  // the enrolment state stays readable in the webmail
  assert.equal((await call('GET', '/api/v1/user/mfa-enforcement', hd)).status, 200);
});

test('policy "off": enrolment is not offered (webmail hint)', async () => {
  await call('PUT', '/api/v1/admin/settings/mfa-policy', ORG(), { users: 'off' });
  const e = await call('GET', '/api/v1/user/mfa-enforcement', token('ua', 'USER'));
  assert.equal(e.body['policy'], 'off');
  assert.equal(e.body['enrolmentOffered'], false);
});
