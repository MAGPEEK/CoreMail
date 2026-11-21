/**
 * 10.6: MFA policy model (global × admin rule × per-user override), the admin
 * grace period (≤ 14 days) and remembered MFA devices ("Gerät merken").
 * Infra-free (globalThis.__prisma / __authRedis).
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/auth/mfa-policy.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, createFakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = null;

const core = await import('@coremail/core');
const auth = await import('./index.js');
const mailAuth = await import('../mail-auth.js');
mailAuth.configureMailAuth({ redis: null });

type Settings = import('./mfa-policy.js').MfaPolicySettings;
const DAY = 86_400_000;
const PW = 'correct horse battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const webmail = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0', surface: 'webmail' as const, deviceSurface: 'webmail' as const };
const bcp = { ...webmail, surface: 'admin' as const, deviceSurface: 'bcp' as const };
const cli = { ip: '203.0.113.7', userAgent: 'coremail-cli', surface: 'admin' as const, deviceSurface: null };

const S = (over: Partial<Settings> = {}): Settings => ({ ...auth.MFA_POLICY_DEFAULTS, ...over });

async function settings(over: Record<string, unknown>): Promise<void> {
  db.serverSettings.rows = [];
  await db.serverSettings.create({ data: { id: 'singleton', ...over } });
  auth.invalidateMfaEnforcementCache();
}

let pwHash = '';
async function addUser(id: string, extra: Record<string, unknown> = {}) {
  pwHash ||= await core.hashPassword(PW);
  return db.user.create({ data: { id, email: `${id}@one.test`, domainId: 'd1', passwordHash: pwHash, displayName: id, ...extra } });
}
async function enableTotp(userId: string) {
  await db.userMfa.create({ data: { userId, totpSecret: auth.encryptMfaSecret(SECRET), totpEnabled: true } });
}
/** TOTP replay protection: allow the same code again (tests log in several times per 30 s). */
function resetTotpStep(userId: string) {
  const row = db.userMfa.rows.find((r) => r['userId'] === userId);
  if (row) row['totpLastUsedStep'] = null;
}

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'serverSettings', 'mfaTrustedDevice', 'mcpToken', 'appPassword'] as const) db[t].rows = [];
  redis.store.clear();
  auth.invalidateMfaEnforcementCache();
});

// ── Resolution matrix ─────────────────────────────────────────────────────────

test('resolution: per-user override > admin rule > policy for all users (matrix)', () => {
  const levels = ['required', 'optional', 'off'] as const;
  for (const users of levels) {
    for (const admins of ['required', 'as_users'] as const) {
      const s = S({ users, admins });
      for (const role of ['USER', 'HELP_DESK', 'ORGANIZATION_MANAGEMENT']) {
        for (const override of [null, ...levels]) {
          const r = auth.resolveMfaPolicy(s, { role, mfaPolicy: override });
          const isAdmin = role !== 'USER';
          const expected = override ?? (isAdmin && admins === 'required' ? 'required' : users);
          const expectedSource = override ? 'user' : isAdmin && admins === 'required' ? 'admin' : 'global';
          const ctx = `users=${users} admins=${admins} role=${role} override=${override}`;
          assert.equal(r.level, expected, ctx);
          assert.equal(r.source, expectedSource, ctx);
          assert.equal(r.enrolmentOffered, expected !== 'off', ctx);
          const kind = expected !== 'required' ? 'none' : isAdmin && expectedSource !== 'global' ? 'admin' : 'all';
          assert.equal(r.enforcement, kind, ctx);
        }
      }
    }
  }
});

test('resolution: the database enum values work as overrides; admins never get more than 14 grace days', () => {
  const r = auth.resolveMfaPolicy(S({ adminGraceDays: 99 }), { role: 'SERVER_MANAGEMENT', mfaPolicy: 'REQUIRED' });
  assert.equal(r.level, 'required');
  assert.equal(r.enforcement, 'admin');
  assert.equal(r.graceDays, 14);
  assert.equal(r.since, null, 'an override has no activation time (the route clears the grace start)');
  const g = auth.resolveMfaPolicy(S({ users: 'required', graceDays: 60 }), { role: 'USER', mfaPolicy: null });
  assert.equal(g.graceDays, 60, 'users keep the 0–90 day grace');
  // admins under "wie alle Benutzer" get the users' enforcement (10.5 behaviour)
  assert.equal(auth.resolveMfaPolicy(S({ users: 'required' }), { role: 'HELP_DESK' }).enforcement, 'all');
});

test('remember days: admins get their own value, never more than users', () => {
  const s = auth.mfaPolicySettingsFromRow({ mfaRememberDays: 30, mfaRememberDaysAdmins: 90 });
  assert.equal(s.rememberDaysAdmins, 30, 'capped at the users value');
  assert.equal(auth.resolveMfaPolicy(S({ rememberDays: 30, rememberDaysAdmins: 7 }), { role: 'USER' }).rememberDays, 30);
  assert.equal(auth.resolveMfaPolicy(S({ rememberDays: 30, rememberDaysAdmins: 7 }), { role: 'HELP_DESK' }).rememberDays, 7);
  assert.equal(auth.resolveMfaPolicy(S({ rememberDays: 0, rememberDaysAdmins: 0 }), { role: 'USER' }).rememberDays, 0);
  assert.match(auth.mfaPolicyProblem({ adminGraceDays: 15, rememberDays: 30, rememberDaysAdmins: 0 }) ?? '', /adminGraceDays/);
  assert.match(auth.mfaPolicyProblem({ adminGraceDays: 14, rememberDays: 30, rememberDaysAdmins: 31 }) ?? '', /rememberDaysAdmins/);
  assert.equal(auth.mfaPolicyProblem({ adminGraceDays: 0, rememberDays: 365, rememberDaysAdmins: 365 }), null);
});

test('legacy switches: read when the new columns are empty (existing installs unchanged)', () => {
  assert.deepEqual(
    [auth.mfaPolicySettingsFromRow({}).users, auth.mfaPolicySettingsFromRow({}).admins], ['optional', 'as_users']);
  const old = auth.mfaPolicySettingsFromRow({ requireMfaForAllUsers: true, requireMfaForAdmins: true, mfaEnforcementGraceDays: 3 });
  assert.equal(old.users, 'required');
  assert.equal(old.admins, 'required');
  assert.equal(old.graceDays, 3);
  // the new columns win
  const neu = auth.mfaPolicySettingsFromRow({ requireMfaForAllUsers: true, mfaUserPolicy: 'OFF', requireMfaForAdmins: true, mfaAdminPolicy: 'AS_USERS' });
  assert.equal(neu.users, 'off');
  assert.equal(neu.admins, 'as_users');
  assert.equal(auth.mfaPolicySettingsFromRow(null).rememberDays, 30);
});

test('write data: new columns and legacy switches in step; switching on sets the activation times', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const d = auth.mfaPolicyWriteData(S(), { users: 'required', admins: 'required', adminGraceDays: 10 }, now);
  assert.equal(d['mfaUserPolicy'], 'REQUIRED');
  assert.equal(d['requireMfaForAllUsers'], true);
  assert.equal(d['mfaAdminPolicy'], 'REQUIRED');
  assert.equal(d['requireMfaForAdmins'], true);
  assert.deepEqual(d['mfaEnforcementSince'], now);
  assert.deepEqual(d['mfaAdminEnforcementSince'], now);
  assert.equal(d['mfaAdminGraceDays'], 10);
  const off = auth.mfaPolicyWriteData(S({ users: 'required', admins: 'required' }), { users: 'off', admins: 'as_users' }, now);
  assert.equal(off['requireMfaForAllUsers'], false);
  assert.equal(off['requireMfaForAdmins'], false);
  assert.equal(off['mfaUserPolicy'], 'OFF');
  assert.equal('mfaEnforcementSince' in off, false);
  const same = auth.mfaPolicyWriteData(S({ users: 'required' }), { users: 'required' }, now);
  assert.equal('mfaEnforcementSince' in same, false, 'saving "required" again starts no new grace period');
  // the legacy PUT /settings/security keeps an "off" policy off when it turns the switch off
  assert.deepEqual(auth.legacySwitchesToPolicy(S({ users: 'off' }), { requireMfaForAllUsers: false }), { users: 'off' });
  assert.deepEqual(auth.legacySwitchesToPolicy(S({ users: 'required' }), { requireMfaForAllUsers: false, requireMfaForAdmins: true }),
    { users: 'optional', admins: 'required' });
});

test('weakening order: required > optional > off', () => {
  assert.equal(auth.weakensMfaPolicy('required', 'optional'), true);
  assert.equal(auth.weakensMfaPolicy('optional', 'off'), true);
  assert.equal(auth.weakensMfaPolicy('off', 'required'), false);
  assert.equal(auth.weakensMfaPolicy('required', 'required'), false);
});

// ── Enforcement with the database ─────────────────────────────────────────────

test('admin grace: within → grace (admin API allowed), after 14 days → required; the webmail rule stays off', async () => {
  await settings({ mfaAdminPolicy: 'REQUIRED', requireMfaForAdmins: true, mfaAdminGraceDays: 14 });
  await addUser('adm', { role: 'ORGANIZATION_MANAGEMENT' });
  const t0 = new Date('2026-11-10T08:00:00Z');
  const first = await auth.adminMfaEnforcementFor('adm', { now: t0 });
  assert.equal(first.status.state, 'grace');
  assert.equal('deadline' in first.status && first.status.deadline.toISOString(), '2026-11-24T08:00:00.000Z');
  assert.equal((await auth.mfaEnforcementFor('adm', { now: t0 })).status.state, 'off', 'the admin rule never blocks the webmail');
  auth.invalidateMfaEnforcementCache();
  assert.equal((await auth.adminMfaEnforcementFor('adm', { now: new Date(t0.getTime() + 13 * DAY) })).status.state, 'grace');
  auth.invalidateMfaEnforcementCache();
  assert.equal((await auth.adminMfaEnforcementFor('adm', { now: new Date(t0.getTime() + 14 * DAY) })).status.state, 'required');
  await enableTotp('adm');
  auth.invalidateMfaEnforcementCache();
  assert.equal((await auth.adminMfaEnforcementFor('adm', { now: new Date(t0.getTime() + 20 * DAY) })).status.state, 'satisfied');
});

test('admin grace: 0 days = at once; a plain user is never under the admin rule; an override of an admin is capped at 14 days', async () => {
  await settings({ mfaAdminPolicy: 'REQUIRED', mfaAdminGraceDays: 0 });
  await addUser('adm', { role: 'HELP_DESK' });
  await addUser('usr');
  assert.equal((await auth.adminMfaEnforcementFor('adm')).status.state, 'required');
  assert.equal((await auth.adminMfaEnforcementFor('usr')).status.state, 'off');

  await settings({ mfaAdminPolicy: 'AS_USERS', mfaAdminGraceDays: 99 });
  db.user.rows.find((u) => u['id'] === 'adm')!['mfaPolicy'] = 'REQUIRED';
  db.user.rows.find((u) => u['id'] === 'adm')!['mfaGraceStartedAt'] = null;
  const t0 = new Date('2026-11-01T00:00:00Z');
  const r = await auth.adminMfaEnforcementFor('adm', { now: t0 });
  assert.equal('deadline' in r.status && r.status.deadline.toISOString(), '2026-11-15T00:00:00.000Z', '≤ 14 days even via an override');
});

test('per-user override "required" for a user enforces the 10.5 rules; "off" for a user lifts the global rule', async () => {
  await settings({ mfaUserPolicy: 'OPTIONAL', mfaEnforcementGraceDays: 0 });
  await addUser('u1', { mfaPolicy: 'REQUIRED' });
  await addUser('u2');
  assert.equal((await auth.mfaEnforcementFor('u1')).status.state, 'required');
  assert.equal((await auth.mfaEnforcementFor('u2')).status.state, 'off');
  assert.ok(await auth.mfaEnrolmentRefusal('u1', false));

  await settings({ mfaUserPolicy: 'REQUIRED', requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  db.user.rows.find((u) => u['id'] === 'u2')!['mfaPolicy'] = 'OFF';
  assert.equal((await auth.mfaEnforcementFor('u2')).status.state, 'off');
  assert.equal(await auth.mfaEnrolmentOffered('u2'), false, '"off": enrolment not offered');
  assert.equal(await auth.mfaEnrolmentOffered('u1'), true);
});

test('override change event drops the cached per-user state', async () => {
  await settings({ mfaEnforcementGraceDays: 0 });
  await addUser('u1');
  assert.equal((await auth.mfaEnforcementFor('u1')).status.state, 'off');
  db.user.rows.find((u) => u['id'] === 'u1')!['mfaPolicy'] = 'REQUIRED';
  assert.equal((await auth.mfaEnforcementFor('u1')).status.state, 'off', 'cached (15 s)');
  await core.publishAuthInvalidation({ userId: 'u1', reason: 'mfa-policy-change' }, { redis: null });
  assert.equal((await auth.mfaEnforcementFor('u1')).status.state, 'required');
});

// ── Remembered devices ────────────────────────────────────────────────────────

/** Password + TOTP with "remember this device" → the device token. */
async function rememberedLogin(userId: string, client = webmail): Promise<string> {
  const o = await auth.login(`${userId}@one.test`, PW, client);
  assert.equal(o.kind, 'mfa');
  if (o.kind !== 'mfa') throw new Error('no challenge');
  resetTotpStep(userId);
  const done = await auth.completeMfaLogin({ challengeToken: o.challengeToken, code: auth.totpCode(SECRET), rememberDevice: true }, client);
  assert.equal(done.kind, 'tokens');
  if (done.kind !== 'tokens' || !done.trustedDevice) throw new Error('no device issued');
  return done.trustedDevice.token;
}

test('device: offered and issued after MFA; the next login of the same browser skips the challenge', async () => {
  await settings({ mfaRememberDays: 30 });
  await addUser('u1');
  await enableTotp('u1');
  const first = await auth.login('u1@one.test', PW, webmail);
  assert.equal(first.kind === 'mfa' && first.rememberDays, 30);
  assert.deepEqual(auth.loginOutcomeToHttp(first).body['rememberDevice'], { days: 30 });

  const token = await rememberedLogin('u1');
  const row = db.mfaTrustedDevice.rows[0]!;
  assert.equal(row['tokenHash'], auth.hashDeviceToken(token));
  assert.notEqual(row['tokenHash'], token, 'only the hash is stored');
  assert.equal(row['surface'], 'webmail');
  assert.equal(row['userAgent'], 'Firefox · Windows');
  assert.equal(row['ipPrefix'], '203.0.113.0/24');

  const skip = await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token });
  assert.equal(skip.kind, 'tokens');
  assert.equal(skip.kind === 'tokens' && skip.source, 'trusted-device');
  assert.equal(skip.kind === 'tokens' && core.verifyAccessToken(skip.tokens.accessToken)!.mfaVerified, true);
  assert.ok(db.mfaTrustedDevice.rows[0]!['lastUsedAt'] instanceof Date);
  // the password is still checked
  assert.equal((await auth.login('u1@one.test', 'wrong', webmail, { trustedDeviceToken: token })).kind, 'invalid');
});

test('device: wrong surface, another account, non-browser clients and a missing remember flag never skip', async () => {
  await settings({ mfaRememberDays: 30, mfaRememberDaysAdmins: 30 });
  await addUser('u1');
  await addUser('u2');
  await enableTotp('u1');
  await enableTotp('u2');
  const token = await rememberedLogin('u1');
  assert.equal((await auth.login('u1@one.test', PW, bcp, { trustedDeviceToken: token })).kind, 'mfa', 'webmail device on the BCP');
  assert.equal((await auth.login('u2@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa', 'stolen cookie for another account');
  assert.equal((await auth.login('u1@one.test', PW, cli, { trustedDeviceToken: token })).kind, 'mfa', 'admin CLI');
  const cliChallenge = await auth.login('u1@one.test', PW, cli);
  assert.equal(cliChallenge.kind === 'mfa' && cliChallenge.rememberDays, undefined, 'not offered without a browser surface');

  // verify without rememberDevice → no device
  const o = await auth.login('u2@one.test', PW, webmail);
  if (o.kind !== 'mfa') throw new Error('no challenge');
  const done = await auth.completeMfaLogin({ challengeToken: o.challengeToken, code: auth.totpCode(SECRET) }, webmail);
  assert.equal(done.kind === 'tokens' && done.trustedDevice, undefined);
  assert.equal(db.mfaTrustedDevice.rows.filter((r) => r['userId'] === 'u2').length, 0);
});

test('device: expiry, a lowered setting and "off" end the skip; admins use their own (default off) value', async () => {
  await settings({ mfaRememberDays: 30 });
  await addUser('u1');
  await enableTotp('u1');
  const token = await rememberedLogin('u1');
  const row = db.mfaTrustedDevice.rows[0]!;
  // lowered to 7 days: a device older than 7 days no longer skips
  row['createdAt'] = new Date(Date.now() - 8 * DAY);
  await settings({ mfaRememberDays: 7 });
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa');
  await settings({ mfaRememberDays: 30 });
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'tokens');
  await settings({ mfaRememberDays: 0 });
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa', 'switched off');
  await settings({ mfaRememberDays: 30 });
  row['expiresAt'] = new Date(Date.now() - 1000);
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa', 'expired');

  // admins: default 0 → neither offered nor issued
  await addUser('adm', { role: 'SERVER_MANAGEMENT' });
  await enableTotp('adm');
  await settings({ mfaRememberDays: 30 });
  const o = await auth.login('adm@one.test', PW, bcp);
  assert.equal(o.kind === 'mfa' && o.rememberDays, undefined);
  if (o.kind !== 'mfa') throw new Error('no challenge');
  resetTotpStep('adm');
  const done = await auth.completeMfaLogin({ challengeToken: o.challengeToken, code: auth.totpCode(SECRET), rememberDevice: true }, bcp);
  assert.equal(done.kind === 'tokens' && done.trustedDevice, undefined, 'rememberDevice ignored when not allowed');
});

test('device: revoked by revoke-all (password change, role change, deactivation, sign out everywhere) and by mfa-change', async () => {
  await settings({ mfaRememberDays: 30 });
  await addUser('u1');
  await enableTotp('u1');
  for (const reason of ['password-change', 'role-change', 'deactivated', 'sign-out-everywhere']) {
    const token = await rememberedLogin('u1');
    const res = await auth.revokeAllSessions('u1', { reason });
    assert.ok(res.trustedDevices >= 1, reason);
    assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa', reason);
  }
  const token = await rememberedLogin('u1');
  await auth.publishUserAuthChange('u1', 'mfa-change');
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa', 'factor changed');
  const t2 = await rememberedLogin('u1');
  await auth.publishUserAuthChange('u1', 'mfa-policy-change');
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: t2 })).kind, 'tokens', 'a policy change keeps devices');
});

test('device: list and single revocation (own devices only)', async () => {
  await settings({ mfaRememberDays: 30 });
  await addUser('u1');
  await addUser('u2');
  await enableTotp('u1');
  const token = await rememberedLogin('u1');
  const list = await auth.listTrustedDevices('u1');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.surface, 'webmail');
  assert.equal('tokenHash' in list[0]!, false, 'the hash is never listed');
  assert.equal(await auth.revokeTrustedDevice('u2', list[0]!.id, 'user'), false, 'not the device of another user');
  assert.equal(await auth.revokeTrustedDevice('u1', list[0]!.id, 'user'), true);
  assert.equal((await auth.listTrustedDevices('u1')).length, 0);
  assert.equal((await auth.login('u1@one.test', PW, webmail, { trustedDeviceToken: token })).kind, 'mfa');
});

test('device cookie helpers: per surface, HttpOnly, SameSite=Strict, Secure on HTTPS, Path=/auth', () => {
  const web = { headers: { 'x-coremail-client': 'web', cookie: 'cm_mfa_dev=' + 'a'.repeat(43) + '; cm_mfa_dev_bcp=' + 'b'.repeat(43) } };
  const bcpReq = { headers: { ...web.headers, 'x-coremail-app': 'bcp' }, secure: true };
  assert.equal(auth.readTrustedDeviceCookie(web), 'a'.repeat(43));
  assert.equal(auth.readTrustedDeviceCookie(bcpReq), 'b'.repeat(43));
  assert.equal(auth.readTrustedDeviceCookie({ headers: { cookie: web.headers.cookie } }), null, 'no browser client');
  assert.equal(auth.readTrustedDeviceCookie({ headers: { 'x-coremail-client': 'web', cookie: 'cm_mfa_dev=bad token' } }), null);
  const set = auth.trustedDeviceCookieHeader(bcpReq, 'bcp', 'tok', 86_400);
  assert.match(set, /^cm_mfa_dev_bcp=tok; Path=\/auth; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotMatch(auth.trustedDeviceCookieHeader(web, 'webmail', 'tok', 1), /Secure/);
  assert.equal(auth.ipPrefixOf('2001:db8:1:2::5'), '2001:db8:1::/48');
  assert.equal(auth.ipPrefixOf('::ffff:198.51.100.9'), '198.51.100.0/24');
});
