/**
 * 10.5: "MFA für alle Benutzer erzwingen" — pure rules, grace period per user,
 * SSO trust (session MFA), the web/API refusal and the mail-protocol
 * sub-option (primary password blocked after the grace period, app passwords
 * keep working). Infra-free (globalThis.__prisma / __authRedis).
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/auth/mfa-enforcement.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const { createFakePrisma, createFakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = null;

const core = await import('@coremail/core');
const me = await import('./mfa-enforcement.js');
const pa = await import('../protocol-access.js');
const wp = await import('../webmail-policy.js');
const mailAuth = await import('../mail-auth.js');
mailAuth.configureMailAuth({ redis: null });

const DAY = 86_400_000;
const PW = 'correct horse battery';
const APP = 'abcd-efgh-ijkl-mnop';
const ctx = { ip: '203.0.113.9', protocol: 'imap' as const };
const policy = (over: Partial<import('./mfa-enforcement.js').MfaEnforcementPolicy> = {}) =>
  ({ enabled: true, graceDays: 7, since: new Date('2026-11-01T00:00:00Z'), blocksPrimaryPassword: false, ...over });

async function settings(over: Record<string, unknown>): Promise<void> {
  db.serverSettings.rows = [];
  await db.serverSettings.create({ data: { id: 'singleton', ...over } });
  me.invalidateMfaEnforcementCache();
}

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'domain', 'serverSettings', 'appPassword', 'protocolPolicy', 'webmailPolicy'] as const) db[t].rows = [];
  me.invalidateMfaEnforcementCache();
  pa.invalidateProtocolAccessCache();
  wp.invalidateWebmailPolicyCache();
  await db.domain.create({ data: { id: 'd1', name: 'one.test', primary: true } });
  const [pwHash, appHash] = await Promise.all([core.hashPassword(PW), core.hashPassword(APP)]);
  await db.user.create({ data: { id: 'u1', email: 'a@one.test', domainId: 'd1', passwordHash: pwHash, displayName: 'A' } });
  await db.user.create({ data: { id: 'u2', email: 'b@one.test', domainId: 'd1', passwordHash: pwHash, displayName: 'B' } });
  await db.user.create({ data: { id: 'sso', email: 's@one.test', domainId: 'd1', passwordHash: null, authSource: 'OIDC', displayName: 'S' } });
  await db.appPassword.create({ data: { id: 'ap-u1', userId: 'u1', name: 'phone', hash: appHash } });
});

// ── Pure rules ────────────────────────────────────────────────────────────────

test('decision: off, satisfied by enrolment or an MFA session, grace until the deadline, then required', () => {
  const start = new Date('2026-11-10T08:00:00Z');
  const now = new Date(start.getTime() + 3 * DAY);
  assert.deepEqual(me.mfaEnforcementDecision(policy({ enabled: false }), { enrolled: false, mfaVerified: false, graceStart: start }, now), { state: 'off' });
  assert.deepEqual(me.mfaEnforcementDecision(policy(), { enrolled: true, mfaVerified: false, graceStart: start }, now), { state: 'satisfied' });
  assert.deepEqual(me.mfaEnforcementDecision(policy(), { enrolled: false, mfaVerified: true, graceStart: start }, now), { state: 'satisfied' });
  const grace = me.mfaEnforcementDecision(policy(), { enrolled: false, mfaVerified: false, graceStart: start }, now);
  assert.equal(grace.state, 'grace');
  assert.equal('deadline' in grace && grace.deadline.toISOString(), '2026-11-17T08:00:00.000Z');
  const atDeadline = me.mfaEnforcementDecision(policy(), { enrolled: false, mfaVerified: false, graceStart: start }, new Date(start.getTime() + 7 * DAY));
  assert.equal(atDeadline.state, 'required', 'the deadline itself is already enforced');
  assert.equal(me.mfaEnforcementDecision(policy({ graceDays: 0 }), { enrolled: false, mfaVerified: false, graceStart: start }, start).state, 'required', '0 days = at once');
});

test('grace start: the stored start counts only for the current activation', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const p = policy({ since: new Date('2026-11-15T00:00:00Z') });
  assert.deepEqual(me.effectiveGraceStart(p, null, now), { start: now, persist: true });
  const fresh = new Date('2026-11-16T00:00:00Z');
  assert.deepEqual(me.effectiveGraceStart(p, fresh, now), { start: fresh, persist: false });
  assert.deepEqual(me.effectiveGraceStart(p, new Date('2026-11-01T00:00:00Z'), now), { start: now, persist: true },
    'a start from an earlier activation is stale');
  assert.equal(me.graceDeadline({ graceDays: 500 }, now).getTime(), now.getTime() + 90 * DAY, 'capped at the upper bound');
});

test('refusal body carries the distinct code and the deadline', () => {
  const body = me.mfaEnrolmentRequiredBody(new Date('2026-11-17T08:00:00Z'));
  assert.equal(body['code'], 'MFA_ENROLMENT_REQUIRED');
  assert.equal(body['deadline'], '2026-11-17T08:00:00.000Z');
});

// ── Database ──────────────────────────────────────────────────────────────────

test('switch off (default, existing installations): nothing is enforced, nothing is written', async () => {
  await settings({});
  const r = await me.mfaEnforcementFor('u1');
  assert.deepEqual(r.status, { state: 'off' });
  assert.equal(db.user.rows.find((u) => u['id'] === 'u1')!['mfaGraceStartedAt'], undefined);
  assert.equal(await me.mfaEnrolmentRefusal('u1', false), null);
});

test('first check starts the per-user grace period; it is stored and reused', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 7, mfaEnforcementSince: new Date('2026-11-01T00:00:00Z') });
  const t0 = new Date('2026-11-10T08:00:00Z');
  const first = await me.mfaEnforcementFor('u1', { now: t0 });
  assert.equal(first.status.state, 'grace');
  assert.equal((db.user.rows.find((u) => u['id'] === 'u1')!['mfaGraceStartedAt'] as Date).toISOString(), t0.toISOString());
  me.invalidateMfaEnforcementCache();
  const later = await me.mfaEnforcementFor('u1', { now: new Date(t0.getTime() + 6 * DAY) });
  assert.equal(later.status.state, 'grace');
  assert.equal('deadline' in later.status && later.status.deadline.toISOString(), '2026-11-17T08:00:00.000Z');
  me.invalidateMfaEnforcementCache();
  assert.equal((await me.mfaEnforcementFor('u1', { now: new Date(t0.getTime() + 7 * DAY) })).status.state, 'required');
  assert.equal(db.user.rows.find((u) => u['id'] === 'u2')!['mfaGraceStartedAt'], undefined, 'other users get their own start');
});

test('re-activation (newer mfaEnforcementSince) starts a new grace period', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 7, mfaEnforcementSince: new Date('2026-11-15T00:00:00Z') });
  await db.user.update({ where: { id: 'u1' }, data: { mfaGraceStartedAt: new Date('2026-10-01T00:00:00Z') } });
  const now = new Date('2026-11-20T00:00:00Z');
  const r = await me.mfaEnforcementFor('u1', { now });
  assert.equal(r.status.state, 'grace');
  assert.equal((db.user.rows.find((u) => u['id'] === 'u1')!['mfaGraceStartedAt'] as Date).toISOString(), now.toISOString());
});

test('an enrolled factor (TOTP or security key) or an MFA-verified session satisfies the rule', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  assert.equal((await me.mfaEnforcementFor('u1')).status.state, 'required');
  assert.ok(await me.mfaEnrolmentRefusal('u1', false));
  // SSO: a session the IdP's MFA (`amr`) made MFA-verified is enough (auth-sso decides the trust)
  assert.equal((await me.mfaEnforcementFor('u1', { mfaVerified: true })).status.state, 'satisfied');
  assert.equal(await me.mfaEnrolmentRefusal('u1', true), null);

  await db.userMfa.create({ data: { userId: 'u1', totpEnabled: true } });
  me.invalidateMfaEnforcementCache();
  assert.equal((await me.mfaEnforcementFor('u1')).status.state, 'satisfied');
  // 10.6: a passkey / security key row (the factor helper reads the table, not the JSON)
  await db.webAuthnCredential.create({ data: { userId: 'u2', credentialId: 'k', kind: 'security_key' } });
  assert.equal((await me.mfaEnforcementFor('u2')).status.state, 'satisfied');
});

test('enrolling publishes mfa-change: the cached state is dropped at once', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  assert.equal((await me.mfaEnforcementFor('u1')).status.state, 'required');
  await db.userMfa.create({ data: { userId: 'u1', totpEnabled: true } });
  assert.equal((await me.mfaEnforcementFor('u1')).status.state, 'required', 'cached (15 s)');
  await core.publishAuthInvalidation({ userId: 'u1', reason: 'mfa-change' }, { redis: null });
  assert.equal((await me.mfaEnforcementFor('u1')).status.state, 'satisfied');
});

test('SSO-only accounts cannot confirm an enrolment (canEnrol false); password accounts can', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  assert.equal((await me.mfaEnforcementFor('sso')).canEnrol, false);
  assert.equal((await me.mfaEnforcementFor('u1')).canEnrol, true);
});

test('an unreadable state is 503 (fails closed), never allowed', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  const original = db.userMfa.findUnique;
  db.userMfa.findUnique = async () => { throw new Error('db down'); };
  try {
    assert.equal((await me.mfaEnrolmentRefusal('u1', false))?.status, 503);
  } finally {
    db.userMfa.findUnique = original;
  }
});

// ── Mail protocols ────────────────────────────────────────────────────────────

test('mail: without the sub-option the primary password keeps working after the grace period', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0 });
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx)).status, 'ok');
  assert.ok(db.user.rows.find((u) => u['id'] === 'u1')!['mfaGraceStartedAt'] instanceof Date, 'a mail login starts the grace period too');
});

test('mail: with the sub-option the primary password is refused after the grace period; app passwords keep working', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 0, mfaEnforcementBlocksPrimaryPassword: true });
  assert.deepEqual(await mailAuth.verifyMailCredentials('a@one.test', PW, ctx), { status: 'mfa_app_password_required' });
  const app = await mailAuth.verifyMailCredentials('a@one.test', APP, ctx);
  assert.equal(app.status, 'ok');
  assert.equal(app.status === 'ok' && app.method, 'app_password');
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', 'wrong', ctx)).status, 'invalid', 'a wrong password stays invalid');
});

test('mail: with the sub-option but still inside the grace period the primary password works', async () => {
  await settings({ requireMfaForAllUsers: true, mfaEnforcementGraceDays: 7, mfaEnforcementBlocksPrimaryPassword: true });
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx)).status, 'ok');
});

test('mail: the switch off ignores the sub-option', async () => {
  await settings({ requireMfaForAllUsers: false, mfaEnforcementGraceDays: 0, mfaEnforcementBlocksPrimaryPassword: true });
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx)).status, 'ok');
});
