/**
 * 10.6 self-service password reset over HTTP (docs/password-reset.md):
 * uniform answer (no enumeration: same status/body for every case, sent before
 * the work), switch off → no mail, unconfirmed recovery address ignored, own
 * mailbox skipped while a delegate can read it, admins excluded, blocked IP
 * ignored, rate limit recorded, MFA step (wrong code does not consume the link),
 * notices after the reset, recovery-address routes (re-auth, hosted address,
 * confirmation, notices), admin settings route + audit rows.
 * Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/routes/password-reset.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
const auditRows: Record<string, unknown>[] = [];
(db as unknown as Record<string, unknown>)['auditLog'] = {
  create: async (a: { data: Record<string, unknown> }) => { auditRows.push(a.data); return a.data; },
};
// the connect guard's block list (empty unless setIpAccessRulesForTests)
(db as unknown as Record<string, unknown>)['ipAccessRule'] = { findMany: async () => [] };
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const sauth = await import('@coremail/storage/auth');
const { authRouter, settleForgotPasswordWork } = await import('./auth.js');
const { recoveryEmailRouter } = await import('./recovery-email.js');
const { adminGlobalSettingsRouter } = await import('./admin/global-settings.js');
const lib = await import('../lib/password-reset.js');

const PW = 'correct horse battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let pwHash = '';
let server: Server;
let base = '';

interface Mail { to: string; subject: string; text: string }
const mails: Mail[] = [];
const notices: { userId: string; subject: string; bodyText: string }[] = [];
const events: { type: string; ip: string | null | undefined }[] = [];
let mailGate: Promise<void> | null = null;

before(async () => {
  pwHash = await core.hashPassword(PW);
  lib.setResetMailer(async (m) => { if (mailGate) await mailGate; mails.push(m); });
  sauth.setSecurityNotifier(async (n) => { notices.push(n); });
  storage.setSecurityEventRecorder({
    record: async (e) => { events.push({ type: e.type, ip: e.ip }); return true; },
    stats: () => ({ written: 0, dropped: 0 }),
  });
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/api/v1/user/recovery-email', recoveryEmailRouter);
  app.use('/api/v1/admin/settings', adminGlobalSettingsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  lib.setResetMailer(null);
  sauth.setSecurityNotifier(null);
  storage.setSecurityEventRecorder(null);
  storage.setIpAccessRulesForTests(null);
});

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings', 'domain',
    'mailbox', 'recoveryEmail', 'mailboxDelegate', 'folderPermission'] as const) db[t].rows = [];
  redis.store.clear();
  mails.length = 0;
  notices.length = 0;
  events.length = 0;
  auditRows.length = 0;
  mailGate = null;
});

async function call(path: string, body?: unknown, opts: { token?: string; method?: string } = {}) {
  const r = await fetch(`${base}${path}`, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
const json = (t: string) => JSON.parse(t) as Record<string, unknown>;

async function addUser(email: string, extra: Record<string, unknown> = {}, mailbox = true) {
  const u = await db.user.create({ data: { email, passwordHash: pwHash, displayName: email, ...extra } });
  if (mailbox) await db.mailbox.create({ data: { userId: u['id'] } });
  return u['id'] as string;
}

async function forgot(email: string) {
  const r = await call('/auth/forgot-password', { email });
  await settleForgotPasswordWork();
  return r;
}

/** The reset token from the last delivered link (own-mailbox notice or external mail). */
function lastToken(): string {
  const all = [...mails.map((m) => m.text), ...notices.map((n) => n.bodyText)];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = /token=([0-9a-f]{64})/.exec(all[i]!);
    if (m) return m[1]!;
  }
  throw new Error('no token delivered');
}

async function loginToken(email: string): Promise<string> {
  const r = await call('/auth/login', { email, password: PW });
  assert.equal(r.status, 200, r.text);
  return String(json(r.text)['accessToken']);
}

test('forgot-password: identical answer for every case, sent before the work (no enumeration)', async () => {
  await addUser('alice@example.com');
  await addUser('ldap@example.com', { authSource: 'LDAP' });
  await addUser('boss@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  // The delivery is held: the answer must not wait for it.
  let release!: () => void;
  mailGate = new Promise<void>((r) => { release = r; });
  await sauth.requestRecoveryEmail((db.user.rows[0]!['id'] as string), 'alice@private.example.net').then((r) => (r.ok ? sauth.confirmRecoveryEmail(r.token) : null));
  const answers = [];
  for (const email of ['alice@example.com', 'nobody@example.com', 'ldap@example.com', 'boss@example.com', 'not-an-email']) {
    const r = await call('/auth/forgot-password', { email });
    answers.push({ status: r.status, text: r.text, type: r.headers.get('content-type') });
  }
  assert.equal(mails.length, 0, 'answered while the delivery was still pending');
  release();
  await settleForgotPasswordWork();
  assert.equal(new Set(answers.map((a) => JSON.stringify(a))).size, 1, JSON.stringify(answers));
  assert.deepEqual(json(answers[0]!.text), { ok: true });
  assert.equal(mails.length, 1, 'only the eligible account got a link');
  assert.equal(mails[0]!.to, 'alice@private.example.net');
});

test('forgot-password: switched off → same answer, no token, no mail; public flag false', async () => {
  await addUser('alice@example.com');
  await db.serverSettings.create({ data: { id: 'singleton', selfServicePasswordReset: false } });
  const r = await forgot('alice@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(json(r.text), { ok: true });
  assert.equal(db.passwordResetToken.rows.length, 0);
  assert.equal(mails.length + notices.length, 0);
  assert.deepEqual(json((await call('/auth/password-reset/available')).text), { enabled: false });
  assert.equal(json((await call('/api/v1/admin/settings/public')).text)['selfServicePasswordReset'], false);
  // switch on but every method off → also unavailable
  await db.serverSettings.update({ where: { id: 'singleton' }, data: { selfServicePasswordReset: true, ssprRecoveryEmailEnabled: false, ssprOwnMailboxEnabled: false } });
  assert.deepEqual(json((await call('/auth/password-reset/available')).text), { enabled: false });
  await db.serverSettings.update({ where: { id: 'singleton' }, data: { ssprOwnMailboxEnabled: true } });
  assert.deepEqual(json((await call('/auth/password-reset/available')).text), { enabled: true });
});

test('forgot-password: own mailbox gets the link directly; skipped while a delegate can read it', async () => {
  const uid = await addUser('alice@example.com');
  await forgot('alice@example.com');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.userId, uid);
  assert.match(notices[0]!.bodyText, /reset-password\?token=/);
  assert.equal(mails.length, 0, 'own mailbox is written directly, never sent by SMTP');

  notices.length = 0;
  await db.mailboxDelegate.create({ data: { mailboxId: db.mailbox.rows[0]!['id'], granteeId: 'bob', permission: 'READ_ONLY' } });
  assert.equal(await lib.requestPasswordReset('alice@example.com', '203.0.113.20'), 'refused');
  assert.equal(notices.length, 0, 'a delegate could read the link');
  const refused = auditRows.find((a) => a['action'] === 'auth.password-reset.refused');
  assert.equal(refused?.['errorMsg'], 'no_channel');
});

test('forgot-password: an unconfirmed recovery address is ignored; admins excluded unless allowed', async () => {
  const uid = await addUser('alice@example.com', {}, false);
  await sauth.requestRecoveryEmail(uid, 'alice@private.example.net'); // pending only
  assert.equal(await lib.requestPasswordReset('alice@example.com', '203.0.113.21'), 'refused');
  assert.equal(mails.length, 0);

  await addUser('admin@example.com', { role: 'HELP_DESK' });
  assert.equal(await lib.requestPasswordReset('admin@example.com', '203.0.113.22'), 'refused');
  assert.equal(notices.length, 0);
  await db.serverSettings.create({ data: { id: 'singleton', ssprAllowAdmins: true } });
  assert.equal(await lib.requestPasswordReset('admin@example.com', '203.0.113.22'), 'sent');
  assert.equal(notices.length, 1);
});

test('forgot-password: blocked IP ignored silently; rate limit recorded as a security event', async () => {
  await addUser('alice@example.com');
  storage.setIpAccessRulesForTests([{ kind: 'BLOCK', cidr: '198.51.100.0/24' }]);
  try {
    assert.equal(await lib.requestPasswordReset('alice@example.com', '198.51.100.9'), 'blocked_ip');
  } finally {
    storage.setIpAccessRulesForTests(null);
  }
  assert.equal(db.passwordResetToken.rows.length, 0);
  for (let i = 0; i < lib.RESET_RATE_LIMIT; i++) assert.equal(await lib.requestPasswordReset('alice@example.com', '203.0.113.30'), 'sent');
  assert.equal(await lib.requestPasswordReset('alice@example.com', '203.0.113.31'), 'rate_limited', 'per e-mail');
  assert.ok(events.some((e) => e.type === 'PASSWORD_RESET_RATE_LIMIT'));
});

test('reset-password: MFA required, wrong code keeps the link, TOTP completes; notices + audit; sessions revoked', async () => {
  const uid = await addUser('alice@example.com');
  await db.userMfa.create({ data: { userId: uid, totpSecret: sauth.encryptMfaSecret(SECRET), totpEnabled: true } });
  await sauth.requestRecoveryEmail(uid, 'alice@private.example.net').then((r) => (r.ok ? sauth.confirmRecoveryEmail(r.token) : null));
  await db.appPassword.create({ data: { userId: uid, name: 'phone', hash: 'h' } });
  await forgot('alice@example.com');
  assert.equal(mails.length, 1);
  assert.equal(notices.length, 1, 'recovery address AND own mailbox (nobody else reads it)');
  const token = lastToken();

  const v = json((await call('/auth/reset-password/verify', { token })).text);
  assert.deepEqual(v, { valid: true, mfaRequired: true, methods: ['totp'] });

  const missing = await call('/auth/reset-password', { token, newPassword: 'brand-new-password' });
  assert.equal(missing.status, 400);
  assert.equal(json(missing.text)['code'], 'MFA_REQUIRED');
  const wrong = await call('/auth/reset-password', { token, newPassword: 'brand-new-password', mfaCode: '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(json(wrong.text)['code'], 'MFA_INVALID');
  assert.equal(json((await call('/auth/reset-password/verify', { token })).text)['valid'], true, 'link not consumed');
  assert.ok(events.some((e) => e.type === 'PASSWORD_RESET_MFA_FAILED'));
  assert.ok(auditRows.some((a) => a['action'] === 'auth.password-reset.mfa-failed' && a['success'] === false));

  mails.length = 0;
  notices.length = 0;
  const ok = await call('/auth/reset-password', { token, newPassword: 'brand-new-password', mfaCode: sauth.totpCode(SECRET) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await core.verifyPassword('brand-new-password', db.user.rows[0]!['passwordHash'] as string), true);
  assert.equal(db.appPassword.rows.length, 0, 'app passwords revoked');
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], true, 'MFA kept');
  await new Promise((r) => setTimeout(r, 30)); // notices are fire-and-forget
  assert.equal(notices.length, 1, 'notice in the own mailbox');
  assert.equal(mails.length, 1, 'notice to the recovery address');
  assert.equal(mails[0]!.to, 'alice@private.example.net');
  assert.ok(auditRows.some((a) => a['action'] === 'auth.password-reset.request' && a['targetId'] === uid));
  assert.ok(auditRows.some((a) => a['action'] === 'auth.password-reset.complete' && a['targetId'] === uid));

  const again = await call('/auth/reset-password', { token, newPassword: 'another-password-1', mfaCode: sauth.totpCode(SECRET) });
  assert.equal(again.status, 400, 'single use');
  assert.equal(json(again.text)['code'], 'INVALID_TOKEN');
});

test('recovery address routes: re-auth, hosted address refused, confirmation, notices, audit', async () => {
  const uid = await addUser('alice@example.com');
  await db.domain.create({ data: { name: 'example.com' } });
  const token = await loginToken('alice@example.com');

  const noAuth = await call('/api/v1/user/recovery-email', { address: 'a@private.example.net' }, { token, method: 'PUT' });
  assert.equal(noAuth.status, 403);
  assert.equal(json(noAuth.text)['code'], 'REAUTH_REQUIRED');
  const hosted = await call('/api/v1/user/recovery-email', { address: 'bob@example.com', currentPassword: PW }, { token, method: 'PUT' });
  assert.equal(hosted.status, 400);
  assert.equal(json(hosted.text)['code'], 'HOSTED_ADDRESS');

  const put = await call('/api/v1/user/recovery-email', { address: 'Alice@Private.Example.net', currentPassword: PW }, { token, method: 'PUT' });
  assert.equal(put.status, 202, put.text);
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.to, 'alice@private.example.net');
  const confirmToken = /token=([0-9a-f]{64})/.exec(mails[0]!.text)![1]!;
  let state = json((await call('/api/v1/user/recovery-email', undefined, { token })).text);
  assert.equal(state['address'], null);
  assert.equal(state['pendingAddress'], 'alice@private.example.net');
  assert.equal((state['account'] as Record<string, unknown>)['eligible'], true);

  assert.equal((await call('/auth/recovery-email/confirm', { token: confirmToken })).status, 200);
  assert.equal((await call('/auth/recovery-email/confirm', { token: confirmToken })).status, 400, 'single use');
  state = json((await call('/api/v1/user/recovery-email', undefined, { token })).text);
  assert.equal(state['address'], 'alice@private.example.net');

  // A change notifies the previously confirmed address and the own mailbox.
  mails.length = 0;
  notices.length = 0;
  const change = await call('/api/v1/user/recovery-email', { address: 'alice@new.example.org', currentPassword: PW }, { token, method: 'PUT' });
  assert.equal(change.status, 202);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(mails.map((m) => m.to).sort(), ['alice@new.example.org', 'alice@private.example.net']);
  assert.equal(notices.filter((n) => n.userId === uid).length, 1);

  const del = await call('/api/v1/user/recovery-email', { currentPassword: PW }, { token, method: 'DELETE' });
  assert.equal(del.status, 200);
  for (const a of ['auth.recovery-email.request', 'auth.recovery-email.confirm', 'auth.recovery-email.remove']) {
    assert.ok(auditRows.some((r) => r['action'] === a), a);
  }
  assert.ok(!JSON.stringify(auditRows).includes('alice@private.example.net'), 'audit rows carry masked addresses');
});

test('admin settings: read + partial update, audited diff, counts', async () => {
  await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  const u = await addUser('alice@example.com');
  await db.recoveryEmail.create({ data: { userId: u, address: 'alice@private.example.net', verifiedAt: new Date() } });
  const token = await loginToken('admin@example.com');
  const g = json((await call('/api/v1/admin/settings/password-reset', undefined, { token })).text);
  assert.equal(g['enabled'], true);
  assert.equal(g['allowAdmins'], false);
  assert.deepEqual(g['stats'], { usersWithRecoveryEmail: 1, localUsers: 2, adminAccounts: 1 });

  const bad = await call('/api/v1/admin/settings/password-reset', { enabled: 'yes' }, { token, method: 'PUT' });
  assert.equal(bad.status, 400);
  const p = await call('/api/v1/admin/settings/password-reset', { ownMailbox: false }, { token, method: 'PUT' });
  assert.equal(p.status, 200, p.text);
  assert.equal(json(p.text)['ownMailbox'], false);
  assert.equal(json(p.text)['recoveryEmail'], true, 'partial update keeps the other values');
  const row = auditRows.find((a) => a['action'] === 'settings.password-reset.update');
  assert.deepEqual(row?.['changes'], { ownMailbox: { from: 'true', to: 'false' } });

  const userToken = await loginToken('alice@example.com');
  assert.equal((await call('/api/v1/admin/settings/password-reset', undefined, { token: userToken })).status, 403);
});
