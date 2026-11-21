/**
 * 10.6: admin passkey API — policy (organisation area, unscoped), per-mailbox
 * credentials / recovery link / passkey-only / MFA reset (recipients area,
 * MFA-verified acting admin, admin accounts only by ORGANIZATION_MANAGEMENT),
 * the admin MFA rule with a passkey and /.well-known/webauthn.
 * Express app on a loopback port; Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/passkeys.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';
delete process.env['WEBAUTHN_RP_ID'];
delete process.env['WEBAUTHN_ORIGIN'];
delete process.env['COREMAIL_PUBLIC_URL'];

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
const auditRows: Record<string, unknown>[] = [];
(db as unknown as Record<string, unknown>)['auditLog'] = {
  create: async (a: { data: Record<string, unknown> }) => { auditRows.push(a.data); return a.data; },
};
(db as unknown as Record<string, unknown>)['ipAccessRule'] = { findMany: async () => [] };
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const sauth = await import('@coremail/storage/auth');
const storage = await import('@coremail/storage');
const wa = await import('@coremail/storage/auth/webauthn');
const { SoftAuthenticator } = await import('@coremail/storage/auth/webauthn/testing');
const { adminPasskeyPolicyRouter, adminMailboxPasskeysRouter } = await import('./passkeys.js');
const { requireAdmin, clearCurrentRoleCache } = await import('../../middleware/auth.js');
const { authRouter } = await import('../auth.js');
const { wellKnownWebauthn } = await import('../../lib/passkeys-well-known.js');

const HOST = 'mail.example.com';
const ORIGIN = `https://${HOST}`;
const PW = 'correct horse battery';
let pwHash = '';
let server: Server;
let base = '';
type Json = Record<string, unknown>;

before(async () => {
  pwHash = await core.hashPassword(PW);
  sauth.setSecurityNotifier(async () => undefined);
  sauth.setAuthAuditSink(() => undefined);
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/api/v1/admin/authentication/passkeys', adminPasskeyPolicyRouter);
  app.use('/api/v1/admin/mailboxes', adminMailboxPasskeysRouter);
  app.get('/api/v1/admin/ping', requireAdmin, (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'serverSettings', 'domain', 'webAuthnCredential', 'passkeyRecoveryToken', 'passkeyPolicy', 'adminScope', 'protocolPolicy'] as const) db[t].rows = [];
  redis.store.clear();
  auditRows.length = 0;
  clearCurrentRoleCache();
  sauth.invalidatePasskeyPolicyCache();
  storage.invalidateProtocolAccessCache();
  wa.invalidateRpConfigCache();
  await db.domain.create({ data: { id: 'dom1', name: 'example.com', primary: true, dkimPrivateKey: '' } });
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: HOST, useHttps: true, httpPort: 443, passkeysEnabled: false, passkeyPasswordlessEnabled: true, passkeyRpId: null, passkeyRelatedOrigins: [], jmapEnabled: true } });
});

async function call(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json, headers: r.headers };
}

async function addUser(email: string, role = 'USER', extra: Json = {}) {
  return db.user.create({ data: { email, passwordHash: pwHash, displayName: email, domainId: 'dom1', role, ...extra } });
}
async function tokenOf(user: Json, mfaVerified = true) {
  const t = await sauth.issueSession({ id: String(user['id']), email: String(user['email']), role: String(user['role']), domainId: 'dom1' }, { ip: '203.0.113.5', userAgent: 't', mfaVerified });
  return t.accessToken;
}
async function registerPasskey(user: Json, synced = false) {
  const a = new SoftAuthenticator({ rpId: HOST, origin: ORIGIN, backupEligible: synced, backupState: synced });
  const o = await wa.passkeyRegistrationOptions({ id: String(user['id']), email: String(user['email']) }, { purpose: 'register' });
  const r = await wa.verifyPasskeyRegistration({ userId: String(user['id']), flowId: o.flowId, response: a.register(o.publicKey as unknown as Json), name: 'Key' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return a;
}

test('policy: organisation area — ORGANIZATION_MANAGEMENT writes, SERVER_MANAGEMENT reads, others 403; audited', async () => {
  const org = await addUser('org@example.com', 'ORGANIZATION_MANAGEMENT');
  const srv = await addUser('srv@example.com', 'SERVER_MANAGEMENT');
  const rcp = await addUser('rcp@example.com', 'RECIPIENT_MANAGEMENT');
  const user = await addUser('u@example.com');
  const g = await call('GET', '/api/v1/admin/authentication/passkeys', await tokenOf(org));
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body['enabled'], false, 'default off');
  assert.equal((g.body['rp'] as Json)['rpId'], HOST);
  assert.equal((g.body['readiness'] as Json)['ready'], true);
  assert.equal((await call('GET', '/api/v1/admin/authentication/passkeys', await tokenOf(srv))).status, 200);
  assert.equal((await call('PUT', '/api/v1/admin/authentication/passkeys', await tokenOf(srv), { enabled: true })).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/authentication/passkeys', await tokenOf(rcp))).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/authentication/passkeys', await tokenOf(user))).status, 403);

  assert.equal((await call('PUT', '/api/v1/admin/authentication/passkeys', await tokenOf(org), { relatedOrigins: ['http://x.example'] })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/authentication/passkeys', await tokenOf(org), { relatedOrigins: ['https://x.example/path'] })).status, 400);
  const p = await call('PUT', '/api/v1/admin/authentication/passkeys', await tokenOf(org), { enabled: true, relatedOrigins: ['https://webmail.example.org'] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body['enabled'], true);
  assert.deepEqual(p.body['relatedOrigins'], ['https://webmail.example.org']);
  assert.ok(auditRows.some((r) => r['action'] === 'settings.passkey-policy.update'));
  assert.deepEqual(await wellKnownWebauthn(), { origins: [ORIGIN, 'https://webmail.example.org'] });

  // a scoped admin never reaches the organisation area
  // (the fake ignores `select`, so the row carries the selected domain relation itself)
  await db.adminScope.create({ data: { userId: srv['id'], domainId: 'dom1', domain: { id: 'dom1', name: 'example.com' } } });
  clearCurrentRoleCache();
  assert.equal((await call('GET', '/api/v1/admin/authentication/passkeys', await tokenOf(srv))).status, 403);

  // domain level
  const d = await call('PUT', '/api/v1/admin/authentication/passkeys/domains/dom1', await tokenOf(org), { setting: 'off' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body['effective'], false);
  assert.equal((await call('PUT', '/api/v1/admin/authentication/passkeys/domains/nope', await tokenOf(org), { setting: 'on' })).status, 404);
});

test('well-known: 404 data while passkeys are off or no related origin is set', async () => {
  assert.equal(await wellKnownWebauthn(), null);
  db.serverSettings.rows[0]!['passkeyRelatedOrigins'] = ['https://a.example'];
  sauth.invalidatePasskeyPolicyCache();
  assert.equal(await wellKnownWebauthn(), null, 'passkeys off');
});

test('mailbox: list (read), remove (write + MFA-verified), admin accounts only by ORGANIZATION_MANAGEMENT', async () => {
  db.serverSettings.rows[0]!['passkeysEnabled'] = true;
  const org = await addUser('org@example.com', 'ORGANIZATION_MANAGEMENT');
  const rcp = await addUser('rcp@example.com', 'RECIPIENT_MANAGEMENT');
  const hd = await addUser('hd@example.com', 'HELP_DESK');
  const user = await addUser('u@example.com');
  await registerPasskey(user);
  const uid = String(user['id']);
  const list = await call('GET', `/api/v1/admin/mailboxes/${uid}/passkeys`, await tokenOf(hd));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const pk = (list.body['passkeys'] as Json[])[0]!;
  assert.equal(pk['kind'], 'passkey');
  assert.equal(pk['publicKey'], undefined, 'never the key');
  assert.equal((await call('DELETE', `/api/v1/admin/mailboxes/${uid}/passkeys/${pk['id']}`, await tokenOf(hd))).status, 403);
  const noMfa = await call('DELETE', `/api/v1/admin/mailboxes/${uid}/passkeys/${pk['id']}`, await tokenOf(rcp, false));
  assert.equal(noMfa.body['code'], 'MFA_NOT_VERIFIED');
  assert.equal((await call('DELETE', `/api/v1/admin/mailboxes/${uid}/passkeys/${pk['id']}`, await tokenOf(rcp))).status, 200);
  assert.equal(db.webAuthnCredential.rows.length, 0);

  // an admin account: only ORGANIZATION_MANAGEMENT
  const srv = await addUser('srv@example.com', 'SERVER_MANAGEMENT');
  await registerPasskey(srv);
  const sid = String(srv['id']);
  assert.equal((await call('DELETE', `/api/v1/admin/mailboxes/${sid}/passkeys`, await tokenOf(rcp))).body['code'], 'FORBIDDEN_ROLE');
  const all = await call('DELETE', `/api/v1/admin/mailboxes/${sid}/passkeys`, await tokenOf(org));
  assert.equal(all.status, 200);
  assert.equal(all.body['removed'], 1);
  assert.equal((await call('GET', '/api/v1/admin/mailboxes/unknown/passkeys', await tokenOf(org))).status, 404);
});

test('mailbox: recovery link (shown once, fragment), passkey-only preconditions, MFA reset', async () => {
  const org = await addUser('org@example.com', 'ORGANIZATION_MANAGEMENT');
  const user = await addUser('u@example.com');
  const uid = String(user['id']);
  const tok = await tokenOf(org);
  assert.equal((await call('POST', `/api/v1/admin/mailboxes/${uid}/passkey-recovery`, tok)).body['code'], 'PASSKEYS_DISABLED');
  db.serverSettings.rows[0]!['passkeysEnabled'] = true;
  sauth.invalidatePasskeyPolicyCache();
  const rec = await call('POST', `/api/v1/admin/mailboxes/${uid}/passkey-recovery`, tok);
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  const url = String(rec.body['url']);
  assert.match(url, /^https:\/\/mail\.example\.com\/passkey-recovery#[A-Za-z0-9_-]{40,}$/);
  const token = url.split('#')[1]!;
  assert.notEqual(db.passkeyRecoveryToken.rows[0]!['tokenHash'], token, 'only the hash is stored');
  assert.ok(auditRows.some((r) => r['action'] === 'passkey.admin_recovery_issue'));
  const o = await wa.recoveryRegistrationOptions(token);
  assert.ok('flowId' in o);

  // passkey-only: one device-bound passkey is not enough
  await registerPasskey(user, false);
  const refused = await call('PUT', `/api/v1/admin/mailboxes/${uid}/passkey-policy`, tok, { passwordLoginDisabled: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body['code'], 'NEEDS_PASSKEYS');
  await registerPasskey(user, true);
  const ok = await call('PUT', `/api/v1/admin/mailboxes/${uid}/passkey-policy`, tok, { passwordLoginDisabled: true, passkeys: 'on' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body['passwordLoginDisabled'], true);
  assert.equal((ok.body['policy'] as Json)['setting'], 'on');
  const pw = await call('POST', '/auth/login', undefined, { email: 'u@example.com', password: PW });
  assert.equal(pw.status, 403);
  assert.equal(pw.body['code'], 'PASSWORD_LOGIN_DISABLED');
  assert.equal((await call('POST', '/auth/login', undefined, { email: 'u@example.com', password: 'wrong' })).status, 401);

  // full MFA reset: credentials + TOTP gone, password sign-in back
  await db.userMfa.create({ data: { userId: uid, totpEnabled: true, totpSecret: 'x', backupCodes: ['a'] } });
  const reset = await call('POST', `/api/v1/admin/mailboxes/${uid}/mfa-reset`, tok);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(db.webAuthnCredential.rows.length, 0);
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], false);
  assert.equal(db.user.rows.find((u) => u['id'] === uid)!['passwordLoginDisabled'], false);
  assert.ok(auditRows.some((r) => r['action'] === 'mailbox.mfa.reset'));
});

test('admin MFA rule: a passkey counts as enrolled factor (no grace prompt); a passkey session is MFA-verified', async () => {
  db.serverSettings.rows[0]!['requireMfaForAdmins'] = true;
  db.serverSettings.rows[0]!['passkeysEnabled'] = true;
  sauth.invalidateMfaPolicyCache();
  sauth.invalidateMfaEnforcementCache();
  const srv = await addUser('srv@example.com', 'SERVER_MANAGEMENT');
  // no factor: the admin grace period applies (admin API works, the grace header is set)
  const grace = await call('GET', '/api/v1/admin/ping', await tokenOf(srv, false));
  assert.equal(grace.status, 200, JSON.stringify(grace.body));
  assert.ok(grace.headers.get('x-coremail-mfa-grace-until'), 'grace header without a factor');
  const a = await registerPasskey(srv);
  await sauth.publishUserAuthChange(String(srv['id']), 'mfa-change'); // the per-user state cache (15 s)
  // enrolled (a passkey): no grace any more — the session itself must be MFA-verified
  assert.equal((await call('GET', '/api/v1/admin/ping', await tokenOf(srv, false))).body['code'], 'MFA_NOT_VERIFIED');
  const opts = (await wa.passkeyLoginOptions('admin'))!;
  const out = await wa.completePasskeyLogin(opts.flowId, a.assert(opts.publicKey as unknown as Json), { ip: '203.0.113.9', userAgent: 't', surface: 'admin' });
  assert.equal(out.kind, 'tokens', JSON.stringify(out));
  if (out.kind !== 'tokens') return;
  const ok = await call('GET', '/api/v1/admin/ping', out.tokens.accessToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-coremail-mfa-grace-until'), null, 'no grace prompt for an admin with a passkey');
});
