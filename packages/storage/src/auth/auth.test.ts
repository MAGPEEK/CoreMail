/**
 * Login service, sessions, MFA, re-auth and password reset (v7.0.0).
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/auth/auth.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, createFakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const auth = await import('./index.js');

const client = { ip: '203.0.113.7', userAgent: 'test' };
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PW = 'correct horse battery';
let pwHash = '';

async function addUser(email: string, extra: Record<string, unknown> = {}) {
  pwHash ||= await core.hashPassword(PW);
  return db.user.create({ data: { email, passwordHash: pwHash, ...extra } });
}

async function enableTotp(userId: string, stored = auth.encryptMfaSecret(SECRET)) {
  await db.userMfa.upsert({ where: { userId }, create: { userId, totpSecret: stored, totpEnabled: true }, update: { totpSecret: stored, totpEnabled: true } });
}

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
  for (const n of auth.listAuthenticators()) auth.unregisterAuthenticator(n);
});

// ── Login matrix ──────────────────────────────────────────────────────────────

test('login: unknown user, wrong password and inactive user are all "invalid"', async () => {
  await addUser('alice@example.com');
  await addUser('bob@example.com', { active: false });
  assert.equal((await auth.login('nobody@example.com', PW, client)).kind, 'invalid');
  assert.equal((await auth.login('alice@example.com', 'wrong', client)).kind, 'invalid');
  assert.equal((await auth.login('bob@example.com', PW, client)).kind, 'invalid');
  assert.equal(auth.loginOutcomeToHttp({ kind: 'invalid' }).status, 401);
});

test('login: unknown user still spends bcrypt time (no enumeration by timing)', async () => {
  await addUser('alice@example.com');
  await auth.login('warmup@example.com', PW, client); // computes the dummy hash once
  let t = Date.now();
  await auth.login('alice@example.com', 'wrong', client);
  const known = Date.now() - t;
  t = Date.now();
  await auth.login('nobody@example.com', 'wrong', client);
  const unknown = Date.now() - t;
  assert.ok(unknown >= known * 0.4, `unknown=${unknown}ms known=${known}ms`);
});

test('login: success issues a session whose tokenHash is sha256(refreshToken)', async () => {
  const u = await addUser('alice@example.com');
  const o = await auth.login('ALICE@example.com', PW, client);
  assert.equal(o.kind, 'tokens');
  if (o.kind !== 'tokens') return;
  const row = db.session.rows[0]!;
  assert.equal(row['userId'], u['id']);
  assert.equal(row['tokenHash'], auth.hashRefreshToken(o.tokens.refreshToken));
  assert.notEqual(row['tokenHash'], o.tokens.refreshToken);
  const payload = core.verifyAccessToken(o.tokens.accessToken)!;
  assert.equal(payload.sessionId, row['id']);
  assert.equal(payload.mfaVerified, false);
});

test('login: MFA user gets a challenge, not tokens', async () => {
  const u = await addUser('alice@example.com');
  await enableTotp(u['id'] as string);
  const o = await auth.login('alice@example.com', PW, client);
  assert.equal(o.kind, 'mfa');
  if (o.kind !== 'mfa') return;
  assert.match(o.challengeToken, /^[0-9a-f]{64}$/);
  assert.equal(o.method, 'totp');
  assert.equal(db.session.rows.length, 0);
  const http = auth.loginOutcomeToHttp(o);
  assert.equal(http.body['mfaRequired'], true);
});

test('login: maintenance mode blocks users (503) but not admins', async () => {
  await db.serverSettings.create({ data: { id: 'singleton', maintenanceMode: true, maintenanceMessage: 'Back soon' } });
  await addUser('user@example.com');
  await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  const blocked = await auth.login('user@example.com', PW, client);
  assert.deepEqual(blocked, { kind: 'maintenance', message: 'Back soon' });
  assert.equal(auth.loginOutcomeToHttp(blocked).status, 503);
  assert.equal((await auth.login('admin@example.com', PW, client)).kind, 'tokens');
});

test('login: external authenticator step (extension point) runs after the local check', async () => {
  const u = await addUser('ldap@example.com', { passwordHash: null, authSource: 'LDAP' });
  const seen: string[] = [];
  auth.registerAuthenticator({ name: 'broken', authenticate: async () => { throw new Error('down'); } });
  auth.registerAuthenticator({
    name: 'ldap',
    authenticate: async (email, password, user) => {
      seen.push(email);
      return password === 'ldap-pw' && user ? { userId: user.id } : null;
    },
  });
  const o = await auth.login('ldap@example.com', 'ldap-pw', client);
  assert.equal(o.kind, 'tokens');
  if (o.kind === 'tokens') { assert.equal(o.source, 'ldap'); assert.equal(o.userId, u['id']); }
  assert.equal((await auth.login('ldap@example.com', 'nope', client)).kind, 'invalid');
  assert.deepEqual(seen, ['ldap@example.com', 'ldap@example.com']);
});

test('login: an external step cannot log in a deactivated user', async () => {
  const u = await addUser('x@example.com', { active: false, passwordHash: null });
  auth.registerAuthenticator({ name: 'ldap', authenticate: async () => ({ userId: u['id'] as string }) });
  assert.equal((await auth.login('x@example.com', 'any', client)).kind, 'invalid');
});

// ── Refresh rotation / reuse / revocation ─────────────────────────────────────

async function loginTokens(email = 'alice@example.com') {
  const o = await auth.login(email, PW, client);
  assert.equal(o.kind, 'tokens');
  return (o as { tokens: { refreshToken: string; accessToken: string } }).tokens;
}

test('refresh: rotates the refresh token; the old one is no longer accepted', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  const r1 = await auth.rotateSession(t1.refreshToken, client);
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.notEqual(r1.tokens.refreshToken, t1.refreshToken);
  assert.equal(db.session.rows[0]!['tokenHash'], auth.hashRefreshToken(r1.tokens.refreshToken));
  const r2 = await auth.rotateSession(r1.tokens.refreshToken, client);
  assert.ok(r2.ok);
});

test('refresh: reusing a rotated token revokes the whole session family', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  const r1 = await auth.rotateSession(t1.refreshToken, client);
  assert.ok(r1.ok);
  const replay = await auth.rotateSession(t1.refreshToken, client);
  assert.deepEqual(replay, { ok: false, status: 401, reason: 'reused' });
  assert.equal(db.session.rows.length, 0);
  if (r1.ok) assert.equal((await auth.rotateSession(r1.tokens.refreshToken, client)).ok, false);
});

test('refresh: concurrent refreshes with one token — at most one succeeds', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  const results = await Promise.all([auth.rotateSession(t1.refreshToken, client), auth.rotateSession(t1.refreshToken, client)]);
  assert.ok(results.filter((r) => r.ok).length <= 1);
});

test('refresh: inactive user → 401 and all sessions removed', async () => {
  const u = await addUser('alice@example.com');
  const t1 = await loginTokens();
  await db.user.update({ where: { id: u['id'] }, data: { active: false } });
  assert.deepEqual(await auth.rotateSession(t1.refreshToken, client), { ok: false, status: 401, reason: 'inactive' });
  assert.equal(db.session.rows.length, 0);
});

test('refresh: missing session row → 401; garbage → 401', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  db.session.rows = [];
  assert.equal((await auth.rotateSession(t1.refreshToken, client)).ok, false);
  assert.equal((await auth.rotateSession('garbage', client)).ok, false);
});

test('refresh: maintenance mode → 503 for users, session kept', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  await db.serverSettings.create({ data: { id: 'singleton', maintenanceMode: true } });
  const r = await auth.rotateSession(t1.refreshToken, client);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 503);
  assert.equal(db.session.rows.length, 1);
});

test('refresh: legacy row (raw token) is accepted once and migrated to the hash', async () => {
  const u = await addUser('alice@example.com');
  const legacy = core.signRefreshToken(u['id'] as string, 'random-uuid-not-row-id');
  await db.session.create({ data: { userId: u['id'], tokenHash: legacy, ipAddress: 'x', expiresAt: new Date(Date.now() + 86400_000) } });
  const r = await auth.rotateSession(legacy, client);
  assert.ok(r.ok);
  const row = db.session.rows[0]!;
  assert.notEqual(row['tokenHash'], legacy);
  if (r.ok) assert.equal(row['tokenHash'], auth.hashRefreshToken(r.tokens.refreshToken));
  assert.equal((await auth.rotateSession(legacy, client)).ok, false);
});

test('refresh: mfaVerified is carried through rotation', async () => {
  const u = await addUser('alice@example.com');
  const t = await auth.issueSession({ id: u['id'] as string, email: 'alice@example.com', role: 'USER', domainId: 'dom1' }, { ...client, mfaVerified: true });
  const r = await auth.rotateSession(t.refreshToken, client);
  assert.ok(r.ok);
  if (r.ok) assert.equal(core.verifyAccessToken(r.tokens.accessToken)!.mfaVerified, true);
});

test('logout: revokes the session (current, rotated or legacy token)', async () => {
  await addUser('alice@example.com');
  const t1 = await loginTokens();
  assert.equal(await auth.revokeSessionByRefreshToken(t1.refreshToken), 1);
  assert.equal(db.session.rows.length, 0);
  const t2 = await loginTokens();
  await auth.rotateSession(t2.refreshToken, client);
  assert.equal(await auth.revokeSessionByRefreshToken(t2.refreshToken), 1, 'rotated token still identifies the session');
  assert.equal(await auth.revokeSessionByRefreshToken('garbage'), 0);
});

test('revokeAllSessions: keeps the excepted session, marks older access tokens revoked, optional app passwords', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  const a = await loginTokens();
  const b = await loginTokens();
  await db.appPassword.create({ data: { userId: uid, name: 'phone', hash: 'h' } });
  const keep = core.verifyAccessToken(a.accessToken)!.sessionId;
  // 10.3: an active and an already revoked MCP token of the user, one of another user
  const t1 = auth.generateMcpToken();
  await db.mcpToken.create({ data: { userId: uid, name: 'cli', tokenHash: t1.tokenHash, prefix: t1.prefix, expiresAt: new Date(Date.now() + 1e9) } });
  await db.mcpToken.create({ data: { userId: uid, name: 'old', tokenHash: 'x', prefix: 'p', expiresAt: new Date(Date.now() + 1e9), revokedAt: new Date(0), revokedReason: 'owner' } });
  await db.mcpToken.create({ data: { userId: 'someone-else', name: 'other', tokenHash: 'y', prefix: 'p', expiresAt: new Date(Date.now() + 1e9) } });
  const res = await auth.revokeAllSessions(uid, { exceptSessionId: keep, reason: 'test' });
  assert.deepEqual(res, { sessions: 1, appPasswords: 0, mcpTokens: 1 });
  const tokens = db.mcpToken.rows;
  assert.equal(tokens.find((t) => t['name'] === 'cli')!['revokedReason'], 'test');
  assert.equal(tokens.find((t) => t['name'] === 'old')!['revokedReason'], 'owner', 'an older revocation is kept');
  assert.equal(tokens.find((t) => t['name'] === 'other')!['revokedAt'], null, 'other users keep their tokens');
  assert.equal(db.session.rows[0]!['id'], keep);
  const pb = core.verifyAccessToken(b.accessToken)!;
  assert.equal(auth.isAccessTokenRevoked(uid, (pb.iat ?? 0) - 1, pb.sessionId), true);
  assert.equal(auth.isAccessTokenRevoked(uid, (pb.iat ?? 0) - 1, keep), false);
  assert.ok(redis.store.has(`${auth.REVOCATION_KEY_PREFIX}${uid}`));
  await auth.revokeAllSessions(uid, { appPasswords: true, reason: 'test' });
  assert.equal(db.session.rows.length, 0);
  assert.equal(db.appPassword.rows.length, 0);
});

// ── MFA ───────────────────────────────────────────────────────────────────────

async function challengeFor(email = 'alice@example.com') {
  const o = await auth.login(email, PW, client);
  assert.equal(o.kind, 'mfa');
  return (o as { challengeToken: string }).challengeToken;
}

test('mfa: TOTP code completes the login once; session is mfaVerified; challenge consumed', async () => {
  const u = await addUser('alice@example.com');
  await enableTotp(u['id'] as string);
  const ct = await challengeFor();
  const o = await auth.completeMfaLogin({ challengeToken: ct, code: auth.totpCode(SECRET) }, client);
  assert.equal(o.kind, 'tokens');
  assert.equal(db.session.rows[0]!['mfaVerified'], true);
  const again = await auth.completeMfaLogin({ challengeToken: ct, code: auth.totpCode(SECRET) }, client);
  assert.equal(again.kind, 'mfa_failed');
});

test('mfa: TOTP replay — the same code cannot be used twice', async () => {
  const u = await addUser('alice@example.com');
  await enableTotp(u['id'] as string);
  const code = auth.totpCode(SECRET);
  assert.equal((await auth.completeMfaLogin({ challengeToken: await challengeFor(), code }, client)).kind, 'tokens');
  assert.equal((await auth.completeMfaLogin({ challengeToken: await challengeFor(), code }, client)).kind, 'mfa_failed');
});

test('mfa: 5 failed attempts exhaust and delete the challenge', async () => {
  const u = await addUser('alice@example.com');
  await enableTotp(u['id'] as string);
  const ct = await challengeFor();
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(await auth.completeMfaLogin({ challengeToken: ct, code: '000000' }, client), { kind: 'mfa_failed', exhausted: false });
  }
  const fifth = await auth.completeMfaLogin({ challengeToken: ct, code: '000000' }, client);
  assert.deepEqual(fifth, { kind: 'mfa_failed', exhausted: true });
  assert.equal(auth.loginOutcomeToHttp(fifth).body['code'], 'MFA_CHALLENGE_EXHAUSTED');
  // Even the right code no longer works for this challenge
  assert.equal((await auth.completeMfaLogin({ challengeToken: ct, code: auth.totpCode(SECRET) }, client)).kind, 'mfa_failed');
});

test('mfa: per-IP failure limit blocks further verifications', async () => {
  const u = await addUser('alice@example.com');
  await enableTotp(u['id'] as string);
  for (let i = 0; i < auth.MFA_MAX_IP_FAILURES; i++) {
    await auth.completeMfaLogin({ challengeToken: 'f'.repeat(64), code: '000000' }, client);
  }
  const ct = await challengeFor();
  assert.equal((await auth.completeMfaLogin({ challengeToken: ct, code: auth.totpCode(SECRET) }, client)).kind, 'mfa_ip_blocked');
  assert.equal((await auth.completeMfaLogin({ challengeToken: ct, code: auth.totpCode(SECRET) }, { ...client, ip: '198.51.100.1' })).kind, 'tokens');
});

test('mfa: backup codes work in {challengeToken, code}, normalised, single use', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  await enableTotp(uid);
  const codes = await auth.regenerateBackupCodes(uid);
  assert.equal(codes.length, 10);
  assert.match(codes[0]!, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  const lower = codes[0]!.toLowerCase();
  assert.equal((await auth.completeMfaLogin({ challengeToken: await challengeFor(), code: lower }, client)).kind, 'tokens');
  assert.equal((await auth.completeMfaLogin({ challengeToken: await challengeFor(), code: codes[0]!.replace('-', '') }, client)).kind, 'mfa_failed');
  assert.equal((db.userMfa.rows[0]!['backupCodes'] as string[]).length, 9);
  assert.equal(db.userMfa.rows[0]!['backupCodesUsed'], 1);
});

test('mfa: concurrent use of one backup code succeeds exactly once; two different codes both succeed', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  const codes = await auth.regenerateBackupCodes(uid);
  const same = await Promise.all([auth.consumeBackupCode(uid, codes[1]!), auth.consumeBackupCode(uid, codes[1]!)]);
  assert.deepEqual(same.filter(Boolean).length, 1);
  const diff = await Promise.all([auth.consumeBackupCode(uid, codes[2]!), auth.consumeBackupCode(uid, codes[3]!)]);
  assert.deepEqual(diff, [true, true]);
  assert.equal((db.userMfa.rows[0]!['backupCodes'] as string[]).length, 7);
  assert.equal(await auth.consumeBackupCode(uid, codes[2]!), false);
});

test('mfa: legacy backup code (bcrypt cost 12, no dash) is still accepted', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  const legacyHash = await core.hashOneTimeSecret('A1B2C3D4', 12);
  await db.userMfa.create({ data: { userId: uid, backupCodes: [legacyHash] } });
  assert.equal(await auth.consumeBackupCode(uid, 'a1b2-c3d4'), true);
});

// ── Encryption at rest ────────────────────────────────────────────────────────

test('crypto: AES-256-GCM round trip; ciphertext is not the secret', () => {
  const enc = auth.encryptMfaSecret(SECRET);
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes(SECRET));
  assert.deepEqual(auth.decryptMfaSecret(enc), { secret: SECRET, needsReencrypt: false });
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
  assert.equal(auth.decryptMfaSecret(tampered), null);
});

test('crypto: legacy base64 secret is read and re-encrypted on next use', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  await enableTotp(uid, Buffer.from(SECRET).toString('base64'));
  assert.deepEqual(auth.decryptMfaSecret(Buffer.from(SECRET).toString('base64')), { secret: SECRET, needsReencrypt: true });
  assert.equal(await auth.verifyUserTotp(uid, auth.totpCode(SECRET)), true);
  const stored = db.userMfa.rows[0]!['totpSecret'] as string;
  assert.match(stored, /^v1:/);
  assert.equal(auth.decryptMfaSecret(stored)?.secret, SECRET);
});

test('crypto: secrets from the derived fallback key stay readable after MFA_ENCRYPTION_KEY is set', () => {
  const viaFallback = auth.encryptMfaSecret(SECRET);
  process.env['MFA_ENCRYPTION_KEY'] = 'a'.repeat(64);
  try {
    assert.deepEqual(auth.decryptMfaSecret(viaFallback), { secret: SECRET, needsReencrypt: true });
    const viaKey = auth.encryptMfaSecret(SECRET);
    assert.deepEqual(auth.decryptMfaSecret(viaKey), { secret: SECRET, needsReencrypt: false });
  } finally {
    delete process.env['MFA_ENCRYPTION_KEY'];
  }
});

// ── Re-authentication ─────────────────────────────────────────────────────────

test('reauth: requires password or MFA code; wrong ones fail; lockout after repeated failures', async () => {
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  await enableTotp(uid);
  assert.equal(await auth.verifyReauth(uid, {}), 'missing');
  assert.equal(await auth.verifyReauth(uid, { currentPassword: 'wrong' }), 'invalid');
  assert.equal(await auth.verifyReauth(uid, { currentPassword: PW }), 'ok');
  assert.equal(await auth.verifyReauth(uid, { mfaCode: auth.totpCode(SECRET) }), 'ok');
  assert.equal(await auth.verifyReauth(uid, { mfaCode: auth.totpCode(SECRET) }), 'invalid', 'replayed code');
  for (let i = 0; i < auth.REAUTH_MAX_FAILURES; i++) await auth.verifyReauth(uid, { currentPassword: 'x' });
  assert.equal(await auth.verifyReauth(uid, { currentPassword: PW }), 'locked');
});

test('reauth: failures map to 403 (never 401 — the session itself is valid)', () => {
  assert.deepEqual([auth.reauthErrorBody('missing').status, auth.reauthErrorBody('invalid').status], [403, 403]);
  assert.equal(auth.reauthErrorBody('invalid').body['code'], 'REAUTH_FAILED');
  assert.equal(auth.reauthErrorBody('locked').status, 429);
});

// ── Password reset ────────────────────────────────────────────────────────────

test('reset: token single use, concurrent redemption has one winner', async () => {
  const u = await addUser('alice@example.com');
  const raw = await auth.createPasswordResetToken(u['id'] as string, '1.2.3.4');
  const results = await Promise.all([
    auth.redeemPasswordReset(raw, 'new-password-1', '1.2.3.4'),
    auth.redeemPasswordReset(raw, 'new-password-2', '1.2.3.4'),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await auth.redeemPasswordReset(raw, 'new-password-3', '1.2.3.4')).ok, false);
  assert.equal(await auth.isResetTokenValid(raw), false);
});

test('reset: a newer request does not invalidate an earlier link (no victim lockout)', async () => {
  const u = await addUser('alice@example.com');
  const first = await auth.createPasswordResetToken(u['id'] as string, 'attacker');
  const second = await auth.createPasswordResetToken(u['id'] as string, 'attacker');
  assert.equal(await auth.isResetTokenValid(first), true);
  assert.equal(await auth.isResetTokenValid(second), true);
  assert.equal((await auth.redeemPasswordReset(first, 'brand-new-pass', 'victim')).ok, true);
  assert.equal(await auth.isResetTokenValid(second), false, 'other tokens are removed after a successful reset');
});

test('reset: enforces minPasswordLength and revokes sessions + app passwords', async () => {
  await db.serverSettings.create({ data: { id: 'singleton', minPasswordLength: 12 } });
  const u = await addUser('alice@example.com');
  const uid = u['id'] as string;
  await loginTokens();
  await db.appPassword.create({ data: { userId: uid, name: 'phone', hash: 'h' } });
  const raw = await auth.createPasswordResetToken(uid, 'ip');
  const short = await auth.redeemPasswordReset(raw, 'short-pw', 'ip');
  assert.equal(short.ok, false);
  assert.equal(await auth.isResetTokenValid(raw), true, 'policy failure does not burn the token');
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip')).ok, true);
  assert.equal(db.session.rows.length, 0);
  assert.equal(db.appPassword.rows.length, 0);
  assert.equal(await core.verifyPassword('long-enough-password', db.user.rows[0]!['passwordHash'] as string), true);
});
