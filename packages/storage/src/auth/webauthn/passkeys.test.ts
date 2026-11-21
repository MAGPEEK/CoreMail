/**
 * 10.6: passkeys — WebAuthn ceremonies with a software authenticator (exact
 * authData flags), policy, lockout, recovery, migration, factor helper.
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/auth/webauthn/passkeys.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['WEBAUTHN_RP_ID'];
delete process.env['WEBAUTHN_ORIGIN'];
delete process.env['COREMAIL_PUBLIC_URL'];

const { createFakePrisma, createFakeRedis } = await import('../testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const core = await import('@coremail/core');
const auth = await import('../index.js');
const wa = await import('./index.js');
const { SoftAuthenticator } = await import('./soft-authenticator.js');
const storage = await import('../../index.js');

const HOST = 'mail.example.com';
const ORIGIN = `https://${HOST}`;
const PW = 'correct horse battery';
let pwHash = '';
const audits: Array<{ action: string; changes?: Record<string, unknown> }> = [];
const notices: string[] = [];

type Json = Record<string, unknown>;
const client = (ip = '203.0.113.7', surface: 'webmail' | 'admin' = 'webmail') => ({ ip, userAgent: 'test', surface });

async function addUser(email: string, extra: Json = {}) {
  pwHash ||= await core.hashPassword(PW);
  return db.user.create({ data: { email, passwordHash: pwHash, displayName: email.split('@')[0], ...extra } });
}

function soft(opts: Partial<ConstructorParameters<typeof SoftAuthenticator>[0]> = {}) {
  return new SoftAuthenticator({ rpId: HOST, origin: ORIGIN, ...opts });
}

/** Registers a passkey for the user through the real ceremony; returns the authenticator. */
async function registerPasskey(user: Json, a = soft(), name = 'Laptop') {
  const opts = await wa.passkeyRegistrationOptions({ id: String(user['id']), email: String(user['email']) }, { purpose: 'register' });
  const r = await wa.verifyPasskeyRegistration({ userId: String(user['id']), flowId: opts.flowId, response: a.register(opts.publicKey as unknown as Json), name });
  assert.equal(r.ok, true, JSON.stringify(r));
  return a;
}

async function login(a: InstanceType<typeof SoftAuthenticator>, o: Parameters<InstanceType<typeof SoftAuthenticator>['assert']>[1] = {}, c = client()) {
  const opts = await wa.passkeyLoginOptions('webmail');
  assert.ok(opts, 'login options');
  return wa.completePasskeyLogin(opts.flowId, a.assert(opts.publicKey as unknown as Json, o), c);
}

const codeOf = (o: Awaited<ReturnType<typeof wa.completePasskeyLogin>>) => (o.kind === 'error' ? String(o.body['code'] ?? o.body['error']) : 'tokens');

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'webAuthnCredential', 'passkeyRecoveryToken', 'passkeyPolicy', 'serverSettings', 'protocolPolicy', 'domain'] as const) db[t].rows = [];
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: HOST, useHttps: true, httpPort: 443, passkeysEnabled: true, passkeyPasswordlessEnabled: true, passkeyRpId: null, passkeyRelatedOrigins: [], jmapEnabled: true } });
  redis.store.clear();
  audits.length = 0;
  notices.length = 0;
  auth.setAuthAuditSink((e) => { audits.push(e as never); });
  auth.setSecurityNotifier(async (n) => { notices.push(n.subject); });
  auth.invalidatePasskeyPolicyCache();
  storage.invalidateProtocolAccessCache();
  storage.configureMailAuth({ onLockoutEvent: () => undefined, limits: { accountMaxFailures: 3, ipMaxFailures: 50 } });
});
// the shared lockout loads the BCP IP rules lazily
(db as Record<string, unknown>)['ipAccessRule'] = { findMany: async () => [] };

// ── Pure rules ────────────────────────────────────────────────────────────────

test('policy: most specific switch wins (server → domain → user)', () => {
  assert.equal(auth.resolvePasskeySwitch(false, 'inherit', 'inherit'), false);
  assert.equal(auth.resolvePasskeySwitch(true, 'inherit', 'inherit'), true);
  assert.equal(auth.resolvePasskeySwitch(false, 'on', 'inherit'), true);
  assert.equal(auth.resolvePasskeySwitch(true, 'off', 'inherit'), false);
  assert.equal(auth.resolvePasskeySwitch(true, 'off', 'on'), true);
  assert.equal(auth.resolvePasskeySwitch(true, 'on', 'off'), false);
});

test('counter rule: regression unless both are 0 (§7.2 step 22)', () => {
  assert.equal(wa.isCounterRegression(0, 0), false);
  assert.equal(wa.isCounterRegression(0, 1), false);
  assert.equal(wa.isCounterRegression(5, 6), false);
  assert.equal(wa.isCounterRegression(5, 5), true);
  assert.equal(wa.isCounterRegression(5, 4), true);
  assert.equal(wa.isCounterRegression(5, 0), true);
});

test('readiness: HTTPS + DNS name + RP ID covering the host', () => {
  assert.equal(wa.passkeyReadiness({ rpID: HOST, primaryOrigin: ORIGIN }).ready, true);
  assert.deepEqual(wa.passkeyReadiness({ rpID: HOST, primaryOrigin: `http://${HOST}:8080` }).problems, ['not_https']);
  assert.ok(wa.passkeyReadiness({ rpID: '192.0.2.1', primaryOrigin: 'https://192.0.2.1' }).problems.includes('ip_address'));
  assert.ok(wa.passkeyReadiness({ rpID: 'old.example.org', primaryOrigin: ORIGIN }).problems.includes('rp_id_mismatch'));
  assert.equal(wa.passkeyReadiness({ rpID: 'example.com', primaryOrigin: ORIGIN }).ready, true); // registrable suffix
  assert.equal(wa.passkeyReadiness({ rpID: 'localhost', primaryOrigin: 'http://localhost:3000' }).ready, true);
});

test('rp: origin includes the external HTTPS port (G6) and related origins; never the Host header', async () => {
  db.serverSettings.rows[0]!['httpPort'] = 8443;
  db.serverSettings.rows[0]!['passkeyRelatedOrigins'] = ['https://webmail.example.org/', 'javascript:alert(1)'];
  wa.invalidateRpConfigCache();
  const rp = await wa.getRpConfig();
  assert.equal(rp.rpID, HOST);
  assert.deepEqual(rp.origins, [`https://${HOST}:8443`, 'https://webmail.example.org']);
  assert.equal(rp.frozen, false);
});

// ── Registration ──────────────────────────────────────────────────────────────

test('registration: options = discoverable + UV required + credProps + EdDSA/ES256/RS256, attestation none', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('reg@example.com');
  const { flowId, publicKey } = await wa.passkeyRegistrationOptions({ id: String(u['id']), email: 'reg@example.com' }, { purpose: 'register' });
  assert.ok(flowId.length >= 40);
  assert.equal(publicKey.rp.id, HOST);
  assert.equal(publicKey.authenticatorSelection?.residentKey, 'required');
  assert.equal(publicKey.authenticatorSelection?.userVerification, 'required');
  assert.equal(publicKey.attestation, 'none');
  assert.deepEqual(publicKey.pubKeyCredParams.map((p) => p.alg), [-8, -7, -257]);
  assert.deepEqual(publicKey.extensions, { credProps: true });
  assert.equal(publicKey.user.name, 'reg@example.com');
  // stable random 64-byte user handle, never personal data
  const handle = db.user.rows[0]!['webauthnUserId'] as string;
  assert.equal(Buffer.from(handle, 'base64url').length, 64);
  assert.equal(publicKey.user.id, handle);
  assert.equal(JSON.stringify(redis.store.keys().next().value).includes('auth:passkey:chal:'), true);
});

for (const [alg, fmt] of [[-7, 'none'], [-8, 'none'], [-257, 'none'], [-7, 'packed'], [-8, 'packed']] as const) {
  test(`registration: ${alg} / ${fmt} stores a passkey (BE/BS, AAGUID, transports) and freezes the RP ID`, async () => {
    wa.invalidateRpConfigCache();
    const u = await addUser(`alg${alg}${fmt}@example.com`);
    const a = await registerPasskey(u, soft({ alg, fmt, backupEligible: true, backupState: true, aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4' }));
    const row = db.webAuthnCredential.rows[0]!;
    assert.equal(row['kind'], 'passkey');
    assert.equal(row['credentialId'], a.credentialId);
    assert.equal(row['algorithm'], alg);
    assert.equal(row['userHandle'], db.user.rows[0]!['webauthnUserId']);
    assert.equal(row['backupEligible'], true);
    assert.equal(row['backupState'], true);
    assert.equal(row['uvInitialized'], true);
    assert.equal(row['discoverable'], true);
    assert.equal(row['attestationFmt'], fmt);
    assert.deepEqual(row['transports'], ['internal', 'hybrid']);
    assert.equal(db.serverSettings.rows[0]!['passkeyRpId'], HOST);
    const list = await auth.listCredentials(String(u['id']));
    assert.equal(list[0]!.provider, 'Google Password Manager');
    assert.equal(typeof list[0]!.signCount, 'number'); // never a raw BigInt
    assert.ok(audits.some((x) => x.action === 'passkey.register'));
    assert.ok(notices.some((s) => s.includes('new passkey')));
  });
}

test('registration: UV=0, wrong origin / port / rpIdHash, cross-origin and a reused challenge are refused', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('bad@example.com');
  const id = String(u['id']);
  const attempt = async (o: Json, a = soft()) => {
    const opts = await wa.passkeyRegistrationOptions({ id, email: 'bad@example.com' }, { purpose: 'register' });
    return wa.verifyPasskeyRegistration({ userId: id, flowId: opts.flowId, response: a.register(opts.publicKey as unknown as Json, o), name: 'x' });
  };
  assert.deepEqual(await attempt({ uv: false }), { ok: false, code: 'PASSKEY_INVALID' });
  assert.deepEqual(await attempt({ origin: 'https://evil.example' }), { ok: false, code: 'PASSKEY_INVALID' });
  assert.deepEqual(await attempt({ origin: `${ORIGIN}:8443` }), { ok: false, code: 'PASSKEY_INVALID' });
  assert.deepEqual(await attempt({ rpId: 'evil.example' }), { ok: false, code: 'PASSKEY_INVALID' });
  assert.deepEqual(await attempt({ crossOrigin: true }), { ok: false, code: 'PASSKEY_INVALID' });
  assert.deepEqual(await attempt({ type: 'webauthn.get' }), { ok: false, code: 'PASSKEY_INVALID' });
  // single use: the same flow id cannot be verified twice
  const a = soft();
  const opts = await wa.passkeyRegistrationOptions({ id, email: 'bad@example.com' }, { purpose: 'register' });
  const resp = a.register(opts.publicKey as unknown as Json);
  assert.equal((await wa.verifyPasskeyRegistration({ userId: id, flowId: opts.flowId, response: resp, name: 'x' })).ok, true);
  assert.deepEqual(await wa.verifyPasskeyRegistration({ userId: id, flowId: opts.flowId, response: resp, name: 'x' }), { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' });
  // another user's flow id is not accepted
  const other = await addUser('other@example.com');
  const o2 = await wa.passkeyRegistrationOptions({ id, email: 'bad@example.com' }, { purpose: 'register' });
  assert.deepEqual(await wa.verifyPasskeyRegistration({ userId: String(other['id']), flowId: o2.flowId, response: soft().register(o2.publicKey as unknown as Json), name: 'x' }), { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' });
  assert.equal(db.webAuthnCredential.rows.length, 1);
});

test('registration: credential ids are unique across users (G3) and at most 1023 bytes', async () => {
  wa.invalidateRpConfigCache();
  const u1 = await addUser('one@example.com');
  const u2 = await addUser('two@example.com');
  const a = await registerPasskey(u1);
  const opts = await wa.passkeyRegistrationOptions({ id: String(u2['id']), email: 'two@example.com' }, { purpose: 'register' });
  const r = await wa.verifyPasskeyRegistration({ userId: String(u2['id']), flowId: opts.flowId, response: a.register(opts.publicKey as unknown as Json), name: 'dup' });
  assert.deepEqual(r, { ok: false, code: 'PASSKEY_DUPLICATE' });
  const big = soft({ credentialIdBytes: 1024 });
  const o3 = await wa.passkeyRegistrationOptions({ id: String(u2['id']), email: 'two@example.com' }, { purpose: 'register' });
  assert.deepEqual(await wa.verifyPasskeyRegistration({ userId: String(u2['id']), flowId: o3.flowId, response: big.register(o3.publicKey as unknown as Json), name: 'big' }), { ok: false, code: 'PASSKEY_ID_TOO_LONG' });
});

// ── Usernameless sign-in ──────────────────────────────────────────────────────

test('login: UV passkey → MFA-verified session with authMethod passkey; counter and BS updated', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('pk@example.com');
  const a = await registerPasskey(u, soft({ backupEligible: true, backupState: false }));
  const opts = await wa.passkeyLoginOptions('webmail');
  assert.ok(opts);
  assert.equal(opts.publicKey.userVerification, 'required');
  assert.equal((opts.publicKey.allowCredentials ?? []).length, 0);
  const out = await wa.completePasskeyLogin(opts.flowId, a.assert(opts.publicKey as unknown as Json, { bs: true }), client());
  assert.equal(out.kind, 'tokens', JSON.stringify(out));
  if (out.kind !== 'tokens') return;
  const p = core.verifyAccessToken(out.tokens.accessToken);
  assert.equal(p?.mfaVerified, true);
  assert.equal(db.session.rows[0]!['authMethod'], 'passkey');
  assert.equal(db.session.rows[0]!['mfaVerified'], true);
  const row = db.webAuthnCredential.rows[0]!;
  assert.equal(row['signCount'], 1n);
  assert.equal(row['backupState'], true);
  assert.equal(row['lastUsedIp'], '203.0.113.7');
});

test('login: UV=0, cross-origin, wrong origin, wrong port, wrong rpIdHash, bad signature are refused', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('neg@example.com');
  const a = await registerPasskey(u);
  assert.equal(codeOf(await login(a, { uv: false })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { crossOrigin: true })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { crossOrigin: true, topOrigin: 'https://evil.example' })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { origin: 'https://evil.example' })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { origin: `${ORIGIN}:8443` })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { rpId: 'evil.example' })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { badSignature: true })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { up: false })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a)), 'tokens');
});

test('login: a reused or expired challenge fails (single use, GETDEL)', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('chal@example.com');
  const a = await registerPasskey(u);
  const opts = (await wa.passkeyLoginOptions('webmail'))!;
  const resp = a.assert(opts.publicKey as unknown as Json);
  assert.equal(codeOf(await wa.completePasskeyLogin(opts.flowId, resp, client())), 'tokens');
  assert.equal(codeOf(await wa.completePasskeyLogin(opts.flowId, resp, client())), 'PASSKEY_CHALLENGE_EXPIRED');
  const o2 = (await wa.passkeyLoginOptions('webmail'))!;
  for (const e of redis.store.values()) e.exp = Date.now() - 1; // TTL over
  assert.equal(codeOf(await wa.completePasskeyLogin(o2.flowId, a.assert(o2.publicKey as unknown as Json), client())), 'PASSKEY_CHALLENGE_EXPIRED');
  // a registration challenge is no login challenge
  const reg = await wa.passkeyRegistrationOptions({ id: String(u['id']), email: 'chal@example.com' }, { purpose: 'register' });
  assert.equal(codeOf(await wa.completePasskeyLogin(reg.flowId, a.assert(reg.publicKey as unknown as Json), client())), 'PASSKEY_CHALLENGE_EXPIRED');
});

test('login: BE changed → refused; counter regression → refused + audit + notice; synced 0/0 → fine', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('ctr@example.com');
  const a = await registerPasskey(u, soft({ backupEligible: false }));
  assert.equal(codeOf(await login(a, { be: true, bs: true })), 'PASSKEY_INVALID');
  assert.ok(audits.some((x) => x.action === 'passkey.backup_eligibility_changed'));
  assert.equal(codeOf(await login(a, { counter: 10 })), 'tokens');
  assert.equal(codeOf(await login(a, { counter: 10 })), 'PASSKEY_COUNTER');
  assert.equal(codeOf(await login(a, { counter: 3 })), 'PASSKEY_COUNTER');
  assert.ok(audits.some((x) => x.action === 'passkey.counter_regression'));
  assert.ok(notices.some((s) => s.includes('possibly copied')));
  assert.equal(db.webAuthnCredential.rows[0]!['signCount'], 10n);
  // synced passkey: counter always 0
  const u2 = await addUser('sync@example.com');
  const s = await registerPasskey(u2, soft({ backupEligible: true, backupState: true, counterStep: 0 }));
  assert.equal(codeOf(await login(s)), 'tokens');
  assert.equal(codeOf(await login(s)), 'tokens');
});

test('login: unknown, legacy (security key) and mismatching user handles are refused', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('uh@example.com');
  const a = await registerPasskey(u);
  assert.equal(codeOf(await login(soft())), 'PASSKEY_UNKNOWN');
  assert.equal(codeOf(await login(a, { userHandle: null })), 'PASSKEY_INVALID');
  assert.equal(codeOf(await login(a, { userHandle: Buffer.alloc(64, 1).toString('base64url') })), 'PASSKEY_INVALID');
  // second-factor-only security key
  const sk = soft();
  const skOpts = await wa.securityKeyRegistrationOptions({ id: String(u['id']), email: 'uh@example.com' });
  assert.equal((await wa.verifySecurityKeyRegistration({ userId: String(u['id']), response: sk.register(skOpts as unknown as Json, { uv: false }), name: 'Key' })).ok, true);
  assert.equal(codeOf(await login(sk)), 'PASSKEY_NOT_ELIGIBLE');
});

test('login: inactive user, maintenance, Webmail switched off and passkey policy off (server/domain/user)', async () => {
  wa.invalidateRpConfigCache();
  const dom = await db.domain.create({ data: { name: 'example.com', dkimPrivateKey: '' } });
  const u = await addUser('pol@example.com', { domainId: dom['id'] });
  const a = await registerPasskey(u);
  db.user.rows[0]!['active'] = false;
  assert.equal(codeOf(await login(a)), 'PASSKEY_INVALID');
  db.user.rows[0]!['active'] = true;
  db.serverSettings.rows[0]!['maintenanceMode'] = true;
  db.serverSettings.rows[0]!['maintenanceMessage'] = 'Later';
  const m = await login(a);
  assert.equal(m.kind === 'error' && m.status, 503);
  db.serverSettings.rows[0]!['maintenanceMode'] = false;
  await db.protocolPolicy.create({ data: { userId: u['id'], webmail: 'OFF' } });
  storage.invalidateProtocolAccessCache();
  assert.equal(codeOf(await login(a)), 'PROTOCOL_DISABLED');
  db.protocolPolicy.rows = [];
  storage.invalidateProtocolAccessCache();
  // server off
  db.serverSettings.rows[0]!['passkeysEnabled'] = false;
  auth.invalidatePasskeyPolicyCache();
  assert.equal(codeOf(await login(a)), 'PASSKEYS_DISABLED');
  // domain on overrides server off
  await auth.writePasskeyLevel({ level: 'domain', domainId: String(dom['id']) }, 'on');
  assert.equal(codeOf(await login(a)), 'tokens');
  // user off overrides domain on
  await auth.writePasskeyLevel({ level: 'user', userId: String(u['id']) }, 'off');
  assert.equal(codeOf(await login(a)), 'PASSKEYS_DISABLED');
  assert.equal((await auth.readPasskeyLevel({ level: 'user', userId: String(u['id']) }))?.effective, false);
  await auth.writePasskeyLevel({ level: 'user', userId: String(u['id']) }, 'inherit');
  assert.equal(db.passkeyPolicy.rows.length, 1);
  // passwordless off: no login options at all
  db.serverSettings.rows[0]!['passkeyPasswordlessEnabled'] = false;
  auth.invalidatePasskeyPolicyCache();
  assert.equal(await wa.passkeyLoginOptions('webmail'), null);
});

test('login: an ACCOUNT lock does not block a passkey sign-in, an IP lock does', async () => {
  storage.configureMailAuth({ onLockoutEvent: () => undefined, limits: { accountMaxFailures: 3, ipMaxFailures: 5 } });
  wa.invalidateRpConfigCache();
  const u = await addUser('lock@example.com');
  const a = await registerPasskey(u);
  const lockout = storage.sharedLoginLockout();
  // password guessing from several addresses locks the account
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await lockout.fail('lock@example.com', ip);
  assert.equal((await lockout.check('lock@example.com', '203.0.113.50')).locked, true);
  assert.equal((await auth.login('lock@example.com', PW, client('203.0.113.50'))).kind, 'locked');
  assert.equal(codeOf(await login(a, {}, client('203.0.113.50'))), 'tokens');
  // the client address itself is locked → refused before any work
  for (let i = 0; i < 5; i++) await lockout.failIp('203.0.113.66');
  const out = await login(a, {}, client('203.0.113.66'));
  assert.equal(codeOf(out), 'IP_LOCKED');
  assert.equal(out.kind === 'error' && out.status, 429);
  // failed passkey attempts count against the client IP
  for (let i = 0; i < 5; i++) await login(soft(), {}, client('203.0.113.77'));
  assert.equal(codeOf(await login(a, {}, client('203.0.113.77'))), 'IP_LOCKED');
  // the BCP block list (attack protection) applies as well
  storage.setIpAccessRulesForTests([{ kind: 'BLOCK', cidr: '198.51.100.0/24' }]);
  try {
    const out = await login(a, {}, client('198.51.100.20'));
    assert.equal(codeOf(out), 'IP_BLOCKED');
    assert.equal(out.kind === 'error' && out.status, 403);
  } finally {
    storage.setIpAccessRulesForTests(null);
  }
});

// ── Second factor, re-auth ────────────────────────────────────────────────────

test('second factor: security key without UV works after the password (G1); challenge single use (G7)', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('2fa@example.com');
  const uid = String(u['id']);
  const sk = soft();
  const regOpts = await wa.securityKeyRegistrationOptions({ id: uid, email: '2fa@example.com' });
  assert.equal(regOpts.authenticatorSelection?.userVerification, 'discouraged');
  assert.equal((await wa.verifySecurityKeyRegistration({ userId: uid, response: sk.register(regOpts as unknown as Json, { uv: false }), name: 'YubiKey' })).ok, true);
  assert.equal(db.webAuthnCredential.rows[0]!['kind'], 'security_key');
  const step1 = await auth.login('2fa@example.com', PW, client());
  assert.equal(step1.kind, 'mfa');
  if (step1.kind !== 'mfa') return;
  assert.deepEqual(step1.methods, ['webauthn']);
  const opts = await wa.secondFactorOptions(uid, step1.challengeToken);
  assert.equal(opts?.userVerification, 'discouraged');
  const verify = (resp: unknown) => auth.completeMfaLogin({ challengeToken: step1.challengeToken, webauthnResponse: resp }, client(), {
    verifyWebAuthn: (userId, r, token) => wa.verifySecondFactor(userId, r, token),
  });
  // a failed attempt consumes the WebAuthn challenge (G7) — the same options cannot be retried
  assert.equal((await verify(sk.assert(opts as unknown as Json, { uv: false, badSignature: true }))).kind, 'mfa_failed');
  assert.equal((await verify(sk.assert(opts as unknown as Json, { uv: false }))).kind, 'mfa_failed');
  const fresh = await wa.secondFactorOptions(uid, step1.challengeToken);
  const done = await verify(sk.assert(fresh as unknown as Json, { uv: false }));
  assert.equal(done.kind, 'tokens');
  assert.equal(db.session.rows[0]!['authMethod'] ?? 'password', 'password');
});

test('second factor: a passkey also works as second factor; re-auth with a passkey needs UV', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('ra@example.com');
  const uid = String(u['id']);
  const a = await registerPasskey(u);
  const step1 = await auth.login('ra@example.com', PW, client());
  assert.equal(step1.kind, 'mfa');
  const ro = (await wa.passkeyReauthOptions(uid))!;
  assert.equal(ro.publicKey.userVerification, 'required');
  assert.equal(await auth.verifyReauth(uid, { webauthnFlowId: ro.flowId, webauthnResponse: a.assert(ro.publicKey as unknown as Json, { uv: false }) }), 'invalid');
  const ro2 = (await wa.passkeyReauthOptions(uid))!;
  assert.equal(await auth.verifyReauth(uid, { webauthnFlowId: ro2.flowId, webauthnResponse: a.assert(ro2.publicKey as unknown as Json) }), 'ok');
  // the flow is single use
  assert.equal(await auth.verifyReauth(uid, { webauthnFlowId: ro2.flowId, webauthnResponse: a.assert(ro2.publicKey as unknown as Json) }), 'invalid');
});

// ── Factors, passkey-only accounts, deletion ──────────────────────────────────

test('factors: passkeys and security keys count as MFA everywhere (getAuthFactors / hasMfa / getMfaState)', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('f@example.com');
  const uid = String(u['id']);
  assert.equal((await auth.getAuthFactors(uid)).enrolled, false);
  await registerPasskey(u, soft({ backupEligible: true, backupState: true }));
  const f = await auth.getAuthFactors(uid);
  assert.deepEqual({ passkeys: f.passkeys, synced: f.syncedPasskeys, enrolled: f.enrolled }, { passkeys: 1, synced: 1, enrolled: true });
  assert.equal((await auth.getMfaState(uid)).webauthn, true);
  assert.equal(storage.hasMfa({ mfa: null, webauthnCredentials: [{ kind: 'passkey' }] }), true);
  assert.equal(storage.hasMfa({ mfa: { totpEnabled: false }, webauthnCredentials: [] }), false);
});

test('passkey-only: preconditions, password refused only after a correct password, no reset, last passkey kept', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('only@example.com');
  const uid = String(u['id']);
  await registerPasskey(u, soft({ backupEligible: false }));
  assert.equal(await auth.passkeyOnlyRefusal(uid), 'NEEDS_PASSKEYS');
  await db.userMfa.create({ data: { userId: uid, backupCodes: ['h1'] } });
  assert.equal(await auth.passkeyOnlyRefusal(uid), 'NEEDS_PASSKEYS'); // device-bound + codes is not enough
  await registerPasskey(u, soft({ backupEligible: true, backupState: true }), 'Phone');
  assert.equal(await auth.passkeyOnlyRefusal(uid), null);
  // last organisation admin needs two passkeys — it has two
  db.user.rows[0]!['role'] = 'ORGANIZATION_MANAGEMENT';
  assert.equal(await auth.passkeyOnlyRefusal(uid), null);
  db.user.rows[0]!['passwordLoginDisabled'] = true;
  assert.equal((await auth.login('only@example.com', 'wrong', client())).kind, 'invalid');
  const r = await auth.login('only@example.com', PW, client());
  assert.equal(r.kind, 'password_login_disabled');
  assert.equal(auth.loginOutcomeToHttp(r).status, 403);
  // no password reset by mail
  const t = await auth.createPasswordResetToken(uid, '203.0.113.7');
  assert.deepEqual(await auth.redeemPasswordReset(t, 'another long password', '203.0.113.7'), { ok: false, reason: 'invalid' });
  // re-auth with the (disabled) password fails
  assert.equal(await auth.verifyReauth(uid, { currentPassword: PW }), 'invalid');
  // the last passkey stays
  const [p1, p2] = db.webAuthnCredential.rows.map((x) => String(x['id']));
  assert.equal(await auth.deleteCredential(uid, p1!, { id: uid }), 'ok');
  assert.equal(await auth.deleteCredential(uid, p2!, { id: uid }), 'last_passkey');
  assert.equal(await auth.passkeyOnlyRefusal(uid), 'LAST_ORG_ADMIN');
  assert.equal(await auth.deleteCredential(uid, 'nope', { id: uid }), 'not_found');
});

// ── Recovery ──────────────────────────────────────────────────────────────────

test('recovery link: single use, registers a passkey, revokes every session', async () => {
  wa.invalidateRpConfigCache();
  const u = await addUser('rec@example.com');
  const uid = String(u['id']);
  await auth.issueSession({ id: uid, email: 'rec@example.com', role: 'USER', domainId: 'dom1' }, { ...client(), mfaVerified: false });
  assert.equal(db.session.rows.length, 1);
  const { token } = await auth.issuePasskeyRecoveryToken(uid, 'admin1');
  assert.equal(db.passkeyRecoveryToken.rows[0]!['tokenHash'], auth.hashRecoveryToken(token));
  const opts = await wa.recoveryRegistrationOptions(token);
  assert.ok('flowId' in opts);
  if (!('flowId' in opts)) return;
  const a = soft();
  const r = await wa.completeRecovery({ token, flowId: opts.flowId, response: a.register(opts.publicKey as unknown as Json), name: 'New phone' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(db.session.rows.length, 0);
  assert.ok(audits.some((x) => x.action === 'passkey.recovery_register'));
  assert.deepEqual(await wa.recoveryRegistrationOptions(token), { error: 'PASSKEY_RECOVERY_INVALID' });
  assert.equal(codeOf(await login(a)), 'tokens');
  assert.deepEqual(await wa.recoveryRegistrationOptions('x'.repeat(43)), { error: 'PASSKEY_RECOVERY_INVALID' });
});

// ── Legacy migration ──────────────────────────────────────────────────────────

const noLock = { acquire: async () => true, release: async () => undefined };

test('migration: legacy JSON → security_key rows (idempotent); duplicates skipped for both users; second factor only', async () => {
  wa.invalidateRpConfigCache();
  const u1 = await addUser('leg1@example.com');
  const u2 = await addUser('leg2@example.com');
  const u3 = await addUser('leg3@example.com');
  const k1 = soft();
  const shared = soft();
  await db.userMfa.create({ data: { userId: u1['id'], webAuthnCredentials: [k1.legacyJson('Old key'), { id: '!!', publicKey: 'x' }] } });
  await db.userMfa.create({ data: { userId: u2['id'], webAuthnCredentials: [shared.legacyJson('A')] } });
  await db.userMfa.create({ data: { userId: u3['id'], webAuthnCredentials: [shared.legacyJson('B')] } });
  const r1 = await wa.migrateLegacyWebAuthnCredentials({ lock: noLock });
  assert.deepEqual(r1, { users: 3, migrated: 1, skipped: 0, duplicates: 2, invalid: 1 });
  const row = db.webAuthnCredential.rows[0]!;
  assert.equal(row['kind'], 'security_key');
  assert.equal(row['userHandle'], null);
  assert.equal(row['algorithm'], -7);
  assert.ok(audits.some((x) => x.action === 'passkey.migration_duplicate'));
  const r2 = await wa.migrateLegacyWebAuthnCredentials({ lock: noLock });
  assert.equal(r2?.migrated, 0);
  assert.equal(db.webAuthnCredential.rows.length, 1);
  assert.equal(await wa.migrateLegacyWebAuthnCredentials({ lock: { acquire: async () => false, release: async () => undefined } }), null);
  // the migrated key works as second factor (UV not required), never passwordless
  const uid = String(u1['id']);
  assert.equal(codeOf(await login(k1, { userHandle: null })), 'PASSKEY_NOT_ELIGIBLE');
  const step1 = await auth.login('leg1@example.com', PW, client());
  assert.equal(step1.kind, 'mfa');
  if (step1.kind !== 'mfa') return;
  const opts = await wa.secondFactorOptions(uid, step1.challengeToken);
  const ok = await auth.completeMfaLogin({ challengeToken: step1.challengeToken, webauthnResponse: k1.assert(opts as unknown as Json, { uv: false }) }, client(), {
    verifyWebAuthn: (userId, resp, token) => wa.verifySecondFactor(userId, resp, token),
  });
  assert.equal(ok.kind, 'tokens');
  // its unknown BE was adopted at first use
  assert.equal(db.webAuthnCredential.rows[0]!['backupEligible'], false);
});
