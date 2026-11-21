/**
 * 10.6 self-service password reset: policy (methods, admins, directory
 * accounts), own-mailbox skip while others can read it, recovery address
 * lifecycle (unconfirmed never used, hosted domains refused, single-use
 * confirmation), and the second proof at redemption (wrong code never consumes
 * the link, the link burns after RESET_MFA_MAX_FAILURES, expiry, single use).
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/auth/sspr.test.ts  (in packages/storage)
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

const auth = await import('./index.js');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ON = { enabled: true, recoveryEmail: true, ownMailbox: true, allowAdmins: false };

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'passwordResetToken', 'serverSettings',
    'domain', 'mailbox', 'recoveryEmail', 'mailboxDelegate', 'folderPermission', 'webAuthnCredential'] as const) db[t].rows = [];
  redis.store.clear();
});

async function addUser(email: string, extra: Record<string, unknown> = {}, withMailbox = true) {
  const u = await db.user.create({ data: { email, passwordHash: 'x', displayName: email, ...extra } });
  if (withMailbox) await db.mailbox.create({ data: { userId: u['id'] } });
  return u['id'] as string;
}

async function confirmedRecovery(userId: string, address: string) {
  await db.recoveryEmail.create({ data: { userId, address, verifiedAt: new Date() } });
}

test('policy: row → policy with defaults; available needs the switch and one method', () => {
  assert.deepEqual(auth.ssprPolicyOf(null), auth.SSPR_DEFAULTS);
  assert.equal(auth.SSPR_DEFAULTS.allowAdmins, false, 'admins excluded by default');
  const p = auth.ssprPolicyOf({ selfServicePasswordReset: true, ssprRecoveryEmailEnabled: false, ssprOwnMailboxEnabled: false });
  assert.equal(auth.ssprAvailable(p), false);
  assert.equal(auth.ssprAvailable({ ...ON, enabled: false }), false);
  assert.equal(auth.ssprRoleAllowed('USER', ON), true);
  assert.equal(auth.ssprRoleAllowed('HELP_DESK', ON), false);
  assert.equal(auth.ssprRoleAllowed('HELP_DESK', { ...ON, allowAdmins: true }), true);
});

test('plan: off / unknown / LDAP / admin / inactive are refused', async () => {
  await addUser('alice@example.com');
  await addUser('ldap@example.com', { authSource: 'LDAP' });
  await addUser('admin@example.com', { role: 'ORGANIZATION_MANAGEMENT' });
  await addUser('gone@example.com', { active: false });
  assert.deepEqual(await auth.planPasswordReset('alice@example.com', { ...ON, enabled: false }), { ok: false, reason: 'disabled' });
  assert.equal((await auth.planPasswordReset('nobody@example.com', ON) as { reason: string }).reason, 'not_found');
  assert.equal((await auth.planPasswordReset('ldap@example.com', ON) as { reason: string }).reason, 'external_directory');
  assert.equal((await auth.planPasswordReset('admin@example.com', ON) as { reason: string }).reason, 'admin_excluded');
  assert.equal((await auth.planPasswordReset('gone@example.com', ON) as { reason: string }).reason, 'inactive');
  const adminOk = await auth.planPasswordReset('admin@example.com', { ...ON, allowAdmins: true });
  assert.equal(adminOk.ok, true);
});

test('plan: own mailbox is skipped while a delegate or a folder read grant exists', async () => {
  const uid = await addUser('alice@example.com');
  const mbx = db.mailbox.rows[0]!['id'];
  const plain = await auth.planPasswordReset('ALICE@example.com', ON);
  assert.ok(plain.ok);
  assert.deepEqual(plain.channels, [{ kind: 'mailbox' }]);

  await db.mailboxDelegate.create({ data: { mailboxId: mbx, granteeId: 'bob', permission: 'FULL_ACCESS' } });
  assert.equal(await auth.mailboxReadableByOthers(uid), true);
  assert.deepEqual(await auth.planPasswordReset('alice@example.com', ON), { ok: false, reason: 'no_channel', userId: uid });

  db.mailboxDelegate.rows = [];
  await db.folderPermission.create({ data: { mailboxId: mbx, folderId: 'f', granteeKey: 'default', rights: 0x400 } });
  assert.equal(await auth.mailboxReadableByOthers(uid), false, 'visible-only grant does not read mail');
  await db.folderPermission.create({ data: { mailboxId: mbx, folderId: 'g', granteeKey: 'user:bob', rights: 0x401 } });
  assert.equal(await auth.mailboxReadableByOthers(uid), true);

  // With a confirmed recovery address the link still has a safe channel.
  await confirmedRecovery(uid, 'alice@private.example.net');
  const rec = await auth.planPasswordReset('alice@example.com', ON);
  assert.ok(rec.ok);
  assert.deepEqual(rec.channels, [{ kind: 'recovery', address: 'alice@private.example.net' }]);
});

test('plan: an unconfirmed recovery address is never used; the method switches apply', async () => {
  const uid = await addUser('alice@example.com', {}, false); // no own mailbox
  await db.recoveryEmail.create({ data: { userId: uid, pendingAddress: 'evil@attacker.example', pendingTokenHash: 'h', pendingExpiresAt: new Date(Date.now() + 60_000) } });
  assert.equal((await auth.planPasswordReset('alice@example.com', ON) as { reason: string }).reason, 'no_channel');
  db.recoveryEmail.rows = [];
  await confirmedRecovery(uid, 'alice@private.example.net');
  assert.equal((await auth.planPasswordReset('alice@example.com', ON)).ok, true);
  assert.equal((await auth.planPasswordReset('alice@example.com', { ...ON, recoveryEmail: false }) as { reason: string }).reason, 'no_channel');
});

test('plan: security-key-only accounts get no link (second proof impossible); TOTP → mfaRequired', async () => {
  const uid = await addUser('alice@example.com');
  // 10.6: credentials are rows of WebAuthnCredential (getAuthFactors), not the deprecated JSON
  await db.webAuthnCredential.create({ data: { userId: uid, credentialId: 'k', kind: 'security_key' } });
  await db.userMfa.create({ data: { userId: uid } });
  assert.equal((await auth.planPasswordReset('alice@example.com', ON) as { reason: string }).reason, 'mfa_unprovable');
  await db.userMfa.update({ where: { userId: uid }, data: { totpEnabled: true, totpSecret: auth.encryptMfaSecret(SECRET) } });
  const p = await auth.planPasswordReset('alice@example.com', ON);
  assert.ok(p.ok);
  assert.equal(p.mfaRequired, true);
});

test('plan (10.6 passkeys): passkey-only factors → no link; passkey-only accounts never get one', async () => {
  const uid = await addUser('pk@example.com');
  await db.webAuthnCredential.create({ data: { userId: uid, credentialId: 'p1', kind: 'passkey', backupState: true } });
  assert.equal((await auth.planPasswordReset('pk@example.com', ON) as { reason: string }).reason, 'mfa_unprovable');
  // with backup codes the reset is possible (second proof: a backup code)
  await db.userMfa.create({ data: { userId: uid, backupCodes: ['h1'] } });
  const p = await auth.planPasswordReset('pk@example.com', ON);
  assert.ok(p.ok);
  assert.equal(p.mfaRequired, true);
  // a link issued before the account became passkey-only is refused at redemption
  const raw = await auth.createPasswordResetToken(uid, 'ip');
  assert.equal((await auth.inspectResetToken(raw)).valid, true);
  db.user.rows.find((u) => u['id'] === uid)!['passwordLoginDisabled'] = true;
  assert.equal((await auth.planPasswordReset('pk@example.com', ON) as { reason: string }).reason, 'password_login_disabled');
  assert.equal((await auth.inspectResetToken(raw)).valid, false);
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip', { mfaCode: 'h1' })).ok, false);
});

test('10.6 review: recovery addresses are normalised before the "not hosted here" check and storage', async () => {
  const uid = await addUser('carol@example.com');
  await db.domain.create({ data: { name: 'example.com' } });
  await db.domain.create({ data: { name: 'bücher.example' } }); // entered as U-label by the admin
  // trailing dot, case, whitespace, IDN → canonical A-label form
  assert.equal(auth.normalizeRecoveryAddress(' Carol@Private.Example.NET. '), 'carol@private.example.net');
  assert.equal(auth.normalizeRecoveryAddress('carol@private.example.net..'), 'carol@private.example.net');
  assert.equal(auth.normalizeRecoveryAddress('Carol@Bücher.Example'), 'carol@xn--bcher-kva.example');
  assert.equal(auth.normalizeRecoveryAddress('carol@.'), null);
  assert.equal(auth.normalizeRecoveryAddress('carol@example.'), null, 'a single label stays invalid');
  // every spelling of a hosted domain is refused
  for (const a of ['bob@example.com.', 'bob@EXAMPLE.COM.', 'bob@bücher.example', 'bob@XN--BCHER-KVA.example', 'bob@xn--bcher-kva.example.']) {
    assert.deepEqual(await auth.requestRecoveryEmail(uid, a), { ok: false, error: 'hosted_address' }, a);
  }
  assert.equal(await auth.isHostedAddress('bob@example.com.'), true);
  assert.equal(await auth.isHostedAddress('bob@xn--bcher-kva.example'), true);
  assert.equal(await auth.isHostedAddress('bob@elsewhere.example'), false);
  // stored in the canonical form
  const r = await auth.requestRecoveryEmail(uid, 'Carol@Private.Example.NET.');
  assert.equal(r.ok, true);
  assert.equal(db.recoveryEmail.rows[0]!['pendingAddress'], 'carol@private.example.net');
});

test('recovery address: validation, hosted domains refused, confirmation single use, change keeps old until confirmed', async () => {
  const uid = await addUser('alice@example.com');
  await db.domain.create({ data: { name: 'example.com' } });
  assert.equal(auth.normalizeRecoveryAddress(' Alice@Private.Example.NET '), 'alice@private.example.net');
  assert.equal(auth.normalizeRecoveryAddress('no-at-sign'), null);
  assert.equal(auth.normalizeRecoveryAddress('a@b'), null);
  assert.deepEqual(await auth.requestRecoveryEmail(uid, 'bob@EXAMPLE.com'), { ok: false, error: 'hosted_address' });
  assert.deepEqual(await auth.requestRecoveryEmail(uid, 'nope'), { ok: false, error: 'invalid_address' });

  const r1 = await auth.requestRecoveryEmail(uid, 'alice@private.example.net');
  assert.ok(r1.ok);
  assert.equal(r1.previous, null);
  let st = await auth.getRecoveryEmailState(uid);
  assert.equal(st.address, null, 'pending is not confirmed');
  assert.equal(st.pendingAddress, 'alice@private.example.net');
  assert.equal(await auth.countVerifiedRecoveryEmails(), 0);

  const c1 = await auth.confirmRecoveryEmail(r1.token);
  assert.deepEqual(c1, { ok: true, userId: uid, address: 'alice@private.example.net', previous: null });
  assert.deepEqual(await auth.confirmRecoveryEmail(r1.token), { ok: false, reason: 'invalid' }, 'single use');
  assert.equal(await auth.countVerifiedRecoveryEmails(), 1);
  assert.deepEqual(await auth.requestRecoveryEmail(uid, 'alice@private.example.net'), { ok: false, error: 'same_address' });

  const r2 = await auth.requestRecoveryEmail(uid, 'alice@other.example.org');
  assert.ok(r2.ok);
  assert.equal(r2.previous, 'alice@private.example.net');
  st = await auth.getRecoveryEmailState(uid);
  assert.equal(st.address, 'alice@private.example.net', 'old address stays until the new one is confirmed');
  const c2 = await auth.confirmRecoveryEmail(r2.token);
  assert.ok(c2.ok);
  assert.equal(c2.previous, 'alice@private.example.net');
  assert.equal((await auth.getRecoveryEmailState(uid)).address, 'alice@other.example.org');

  // Expired confirmation links are dead.
  const r3 = await auth.requestRecoveryEmail(uid, 'alice@third.example.org');
  assert.ok(r3.ok);
  db.recoveryEmail.rows[0]!['pendingExpiresAt'] = new Date(Date.now() - 1000);
  assert.deepEqual(await auth.confirmRecoveryEmail(r3.token), { ok: false, reason: 'invalid' });

  const rm = await auth.removeRecoveryEmail(uid);
  assert.deepEqual(rm, { previous: 'alice@other.example.org', removed: true });
  assert.equal(await auth.countVerifiedRecoveryEmails(), 0);
});

test('recovery address: a domain hosted after the request cannot be confirmed', async () => {
  const uid = await addUser('alice@example.com');
  const r = await auth.requestRecoveryEmail(uid, 'alice@soon-hosted.example');
  assert.ok(r.ok);
  await db.domain.create({ data: { name: 'soon-hosted.example' } });
  assert.deepEqual(await auth.confirmRecoveryEmail(r.token), { ok: false, reason: 'hosted_address' });
  assert.equal((await auth.getRecoveryEmailState(uid)).pendingAddress, null);
});

test('redeem: MFA account needs a second proof; wrong code does not consume the link; TOTP works; MFA kept', async () => {
  const uid = await addUser('alice@example.com');
  await db.userMfa.create({ data: { userId: uid, totpSecret: auth.encryptMfaSecret(SECRET), totpEnabled: true } });
  const raw = await auth.createPasswordResetToken(uid, 'ip');
  assert.deepEqual(await auth.inspectResetToken(raw), { valid: true, mfaRequired: true, methods: ['totp'] });

  const missing = await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip');
  assert.deepEqual(missing, { ok: false, reason: 'mfa_required', userId: uid });
  const wrong = await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip', { mfaCode: '000000' });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as { reason: string }).reason, 'mfa_invalid');
  assert.equal(await auth.isResetTokenValid(raw), true, 'wrong code never consumes the link');
  assert.equal(db.user.rows[0]!['passwordHash'], 'x', 'password unchanged');

  const ok = await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip', { mfaCode: auth.totpCode(SECRET) });
  assert.deepEqual(ok, { ok: true, userId: uid });
  assert.equal(db.userMfa.rows[0]!['totpEnabled'], true, 'reset never removes MFA');
  assert.equal(await auth.isResetTokenValid(raw), false);
});

test('redeem: backup code works once; link burns after too many wrong codes', async () => {
  const uid = await addUser('alice@example.com');
  await db.userMfa.create({ data: { userId: uid } });
  const codes = await auth.regenerateBackupCodes(uid);
  const raw = await auth.createPasswordResetToken(uid, 'ip');
  assert.deepEqual((await auth.inspectResetToken(raw)).methods, ['backup_code']);
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip', { mfaCode: codes[0] })).ok, true);

  const raw2 = await auth.createPasswordResetToken(uid, 'ip2');
  assert.equal((await auth.redeemPasswordReset(raw2, 'another-long-password', 'ip2', { mfaCode: codes[0] })).ok, false, 'used backup code');
  for (let i = 1; i < auth.RESET_MFA_MAX_FAILURES - 1; i++) {
    assert.equal(((await auth.redeemPasswordReset(raw2, 'another-long-password', 'ip2', { mfaCode: '123456' })) as { reason: string }).reason, 'mfa_invalid');
  }
  const last = await auth.redeemPasswordReset(raw2, 'another-long-password', 'ip2', { mfaCode: '123456' });
  assert.equal((last as { reason: string }).reason, 'mfa_locked');
  assert.equal(await auth.isResetTokenValid(raw2), false, 'link burnt');
  assert.equal((await auth.redeemPasswordReset(raw2, 'another-long-password', 'ip2', { mfaCode: codes[1] })).ok, false);
});

test('redeem: expired link, SSPR switched off, or account now excluded → invalid', async () => {
  const uid = await addUser('alice@example.com');
  const expired = await auth.createPasswordResetToken(uid, 'ip');
  db.passwordResetToken.rows[0]!['expiresAt'] = new Date(Date.now() - 1);
  assert.equal((await auth.redeemPasswordReset(expired, 'long-enough-password', 'ip')).ok, false);

  const raw = await auth.createPasswordResetToken(uid, 'ip');
  await db.serverSettings.create({ data: { id: 'singleton', selfServicePasswordReset: false } });
  assert.deepEqual(await auth.inspectResetToken(raw), { valid: false, mfaRequired: false, methods: [] });
  assert.deepEqual(await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip'), { ok: false, reason: 'invalid' });
  await db.serverSettings.update({ where: { id: 'singleton' }, data: { selfServicePasswordReset: true } });
  await db.user.update({ where: { id: uid }, data: { role: 'HELP_DESK' } });
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip')).ok, false, 'admin excluded at redemption too');
  await db.user.update({ where: { id: uid }, data: { role: 'USER' } });
  assert.equal((await auth.redeemPasswordReset(raw, 'long-enough-password', 'ip')).ok, true);
});
