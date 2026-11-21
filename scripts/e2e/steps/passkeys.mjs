// Step passkeys (10.6, API level with the software authenticator — docs/passkeys.md):
// default off → PASSKEYS_DISABLED; admin enables; register with re-auth;
// usernameless sign-in (MFA-verified session); UV=0 / unknown / reused challenge
// refused; mail protocols then need an app password; an ACCOUNT lock does not
// block the passkey sign-in, an IP lock does; legacy JSON key migrated at the
// gateway start (second factor only); recovery link; passkey-only; admin removal.
import { execFileSync } from 'node:child_process';
import {
  check, assert, http, session, creds, setCred, DOMAIN, clearMailAuthLocks, resetGatewayRateLimits, waitFor,
} from '../lib.mjs';
import { SoftAuthenticator } from '../soft-authenticator.mjs';
import { imapLogin } from './imap.mjs';

const PG = process.env.E2E_PG_CONTAINER ?? 'coremail-e2e-postgres';
const PG_USER = process.env.E2E_PG_USER ?? 'coremail';
const PG_DB = process.env.E2E_PG_DB ?? 'coremail';

function psql(sql) {
  return execFileSync('docker', ['exec', PG, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const claims = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** POST /auth/passkey/login/options → { flowId, publicKey, cookie } */
async function loginOptions() {
  const res = await http('POST', '/auth/passkey/login/options', { body: {}, raw: true });
  const json = await res.json().catch(() => ({}));
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('cm_pk='))?.split(';')[0];
  return { status: res.status, json, cookie };
}

async function passkeySignIn(auth, overrides = {}) {
  const o = await loginOptions();
  assert(o.status === 200 && o.json?.flowId, `options ${o.status} ${JSON.stringify(o.json).slice(0, 200)}`);
  assert(o.cookie, 'flow cookie cm_pk missing');
  const send = () => http('POST', '/auth/passkey/login/verify', {
    body: { flowId: o.json.flowId, response: auth.assert(o.json.publicKey, overrides) }, headers: { Cookie: o.cookie }, retry429: false,
  });
  let r = await send();
  // the gateway's per-IP passkey limiter (20/min) — not the lockout: reset and send again
  if (r.status === 429 && r.json?.code === 'RATE_LIMITED') { await resetGatewayRateLimits(); r = await send(); }
  return r;
}

async function ensureUser(admin, email, password, domainId) {
  const list = (await http('GET', '/api/v1/admin/mailboxes', { token: admin })).json ?? [];
  const found = list.find((u) => u.email === email);
  if (found) {
    await http('PUT', `/api/v1/admin/mailboxes/${found.id}`, { token: admin, body: { password } });
    return found.id;
  }
  const r = await http('POST', '/api/v1/admin/mailboxes', { token: admin, body: { email, displayName: email.split('@')[0], password, domainId } });
  assert(r.status === 201, `create ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.id;
}

async function passwordLogin(email, password) {
  const r = await http('POST', '/auth/login', { body: { email, password } });
  assert(r.status === 200 && r.json?.accessToken, `login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.accessToken;
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  if (!c.passkeyUser) setCred('passkeyUser', `Pk-${Math.random().toString(36).slice(2)}-e2e!`);
  const PW = creds().passkeyUser;
  const EMAIL = `passkey@${DOMAIN}`;
  const LEGACY = `legacykey@${DOMAIN}`;
  const pk = (state.passkeys ??= {});
  let rp;
  let userId;
  let token;
  let auth;

  await check('passkeys: off by default — login options and registration refused', async () => {
    const g = await http('GET', '/api/v1/admin/authentication/passkeys', { token: admin });
    assert(g.status === 200, `policy ${g.status} ${g.text.slice(0, 200)}`);
    pk.initialEnabled ??= g.json.enabled;
    if (g.json.enabled) await http('PUT', '/api/v1/admin/authentication/passkeys', { token: admin, body: { enabled: false } });
    userId = await ensureUser(admin, EMAIL, PW, state.domainId);
    pk.userId = userId;
    token = await passwordLogin(EMAIL, PW);
    await waitFor(async () => (await http('GET', '/auth/passkey/status')).json?.enabled === false, { what: 'passkeys off' });
    const o = await loginOptions();
    assert(o.status === 403 && o.json?.code === 'PASSKEYS_DISABLED', `options ${o.status} ${JSON.stringify(o.json)}`);
    const r = await http('POST', '/auth/passkeys/registration/options', { token, body: { currentPassword: PW } });
    assert(r.json?.code === 'PASSKEYS_DISABLED', `registration ${r.status} ${r.text.slice(0, 200)}`);
    return `default enabled=${g.json.enabled}; options 403 PASSKEYS_DISABLED; registration refused`;
  });

  await check('passkeys: admin enables them (audited); RP ID / origins / readiness reported', async () => {
    const p = await http('PUT', '/api/v1/admin/authentication/passkeys', { token: admin, body: { enabled: true, passwordless: true } });
    assert(p.status === 200 && p.json?.enabled === true, `enable ${p.status} ${p.text.slice(0, 200)}`);
    rp = { rpId: p.json.rp.rpId, origin: p.json.rp.primaryOrigin };
    pk.rp = rp;
    await waitFor(async () => (await http('GET', '/auth/passkey/status')).json?.enabled === true, { what: 'passkeys on in the auth-service' });
    const user = await http('GET', '/api/v1/admin/authentication/passkeys', { token: await passwordLogin(EMAIL, PW) });
    assert(user.status === 403, `plain user on the policy → ${user.status}`);
    return `rpId ${rp.rpId}, origin ${rp.origin}, ready=${p.json.readiness.ready} (${p.json.readiness.problems.join(',') || 'no problems'})`;
  });

  await check('passkeys: registration needs re-authentication; registered passkey counts as MFA', async () => {
    auth = new SoftAuthenticator({ rpId: rp.rpId, origin: rp.origin, backupEligible: true, backupState: true });
    const noAuth = await http('POST', '/auth/passkeys/registration/options', { token, body: {} });
    assert(noAuth.json?.code === 'REAUTH_REQUIRED', `without re-auth → ${noAuth.status} ${noAuth.text.slice(0, 120)}`);
    const o = await http('POST', '/auth/passkeys/registration/options', { token, body: { currentPassword: PW } });
    assert(o.status === 200 && o.json?.publicKey?.authenticatorSelection?.residentKey === 'required', `options ${o.status} ${o.text.slice(0, 200)}`);
    assert(o.json.publicKey.authenticatorSelection.userVerification === 'required', 'UV required');
    const uv0 = await http('POST', '/auth/passkeys/registration/verify', { token, body: { flowId: o.json.flowId, response: auth.register(o.json.publicKey, { uv: false }), name: 'uv0' } });
    assert(uv0.status === 400, `UV=0 registration → ${uv0.status}`);
    const o2 = await http('POST', '/auth/passkeys/registration/options', { token, body: { currentPassword: PW } });
    const v = await http('POST', '/auth/passkeys/registration/verify', { token, body: { flowId: o2.json.flowId, response: auth.register(o2.json.publicKey), name: 'e2e passkey' } });
    assert(v.status === 201 && v.json?.credential?.kind === 'passkey', `verify ${v.status} ${v.text.slice(0, 200)}`);
    const st = await http('GET', '/auth/mfa/status', { token });
    assert(st.json?.passkeyCount === 1, `mfa status ${st.text}`);
    return `UV=0 → 400; registered (synced=${v.json.credential.synced}); passkeyCount 1`;
  });

  await check('passkeys: mail protocols refuse the primary password once a passkey exists', async () => {
    const s = await imapLogin(EMAIL, PW);
    const text = s.loginResult.text;
    s.close();
    assert(s.loginResult.status !== 'OK', `IMAP accepted the primary password: ${text}`);
    return text.replace(/^T\d+ /, '');
  });

  await check('passkeys: usernameless sign-in → MFA-verified session (authMethod passkey)', async () => {
    const r = await passkeySignIn(auth);
    assert(r.status === 200 && r.json?.accessToken, `verify ${r.status} ${r.text.slice(0, 200)}`);
    const cl = claims(r.json.accessToken);
    assert(cl.mfaVerified === true && cl.sub === userId, `claims ${JSON.stringify(cl)}`);
    const prof = await http('GET', '/api/v1/user/profile', { token: r.json.accessToken });
    assert(prof.status === 200 && prof.json?.email === EMAIL, `profile ${prof.status}`);
    const method = psql(`SELECT "authMethod" FROM sessions WHERE id = ${sqlString(cl.sessionId)}`);
    assert(method === 'passkey', `session authMethod ${method}`);
    return `200, mfaVerified, session authMethod=${method}`;
  });

  await check('passkeys: UV=0, unknown credential, foreign origin and a reused challenge are refused', async () => {
    const uv0 = await passkeySignIn(auth, { uv: false });
    assert(uv0.status === 401 && uv0.json?.code === 'PASSKEY_INVALID', `UV=0 → ${uv0.status} ${uv0.text}`);
    const unknown = await passkeySignIn(new SoftAuthenticator({ rpId: rp.rpId, origin: rp.origin }));
    assert(unknown.json?.code === 'PASSKEY_UNKNOWN', `unknown → ${unknown.status} ${unknown.text}`);
    const evil = await passkeySignIn(auth, { origin: 'https://evil.example' });
    assert(evil.json?.code === 'PASSKEY_INVALID', `foreign origin → ${evil.status} ${evil.text}`);
    const o = await loginOptions();
    const resp = auth.assert(o.json.publicKey);
    const first = await http('POST', '/auth/passkey/login/verify', { body: { flowId: o.json.flowId, response: resp }, headers: { Cookie: o.cookie } });
    const again = await http('POST', '/auth/passkey/login/verify', { body: { flowId: o.json.flowId, response: resp }, headers: { Cookie: o.cookie } });
    assert(first.status === 200 && again.json?.code === 'PASSKEY_CHALLENGE_EXPIRED', `reuse → ${first.status}/${again.status} ${again.text}`);
    clearMailAuthLocks(); // the refused attempts counted against the runner's IP
    return 'UV=0 401, unknown PASSKEY_UNKNOWN, origin PASSKEY_INVALID, reuse PASSKEY_CHALLENGE_EXPIRED';
  });

  await check('passkeys: an ACCOUNT lock does not block the passkey sign-in, an IP lock does', async () => {
    clearMailAuthLocks();
    let locked;
    for (let i = 0; i < 30 && !locked; i++) {
      const r = await http('POST', '/auth/login', { body: { email: EMAIL, password: `wrong-${i}` }, retry429: false });
      if (r.status === 429 && r.json?.code === 'ACCOUNT_LOCKED') locked = i + 1;
      if (r.status === 429 && !r.json?.code) await resetGatewayRateLimits(); // gateway auth limiter, not the lockout
    }
    assert(locked, 'account not locked after 30 wrong passwords');
    const pw = await http('POST', '/auth/login', { body: { email: EMAIL, password: PW }, retry429: false });
    assert(pw.status === 429, `correct password while locked → ${pw.status}`);
    const ok = await passkeySignIn(auth);
    assert(ok.status === 200, `passkey while the account is locked → ${ok.status} ${ok.text.slice(0, 200)}`);
    // lock the runner's IP with failed passkey attempts (each counts against the IP)
    let ipLocked;
    for (let i = 0; i < 80 && !ipLocked; i++) {
      const r = await passkeySignIn(new SoftAuthenticator({ rpId: rp.rpId, origin: rp.origin }));
      if (r.json?.code === 'IP_LOCKED') ipLocked = i + 1;
    }
    assert(ipLocked, 'IP not locked after 80 failed passkey attempts');
    const blocked = await passkeySignIn(auth);
    assert(blocked.status === 429 && blocked.json?.code === 'IP_LOCKED', `passkey with the IP locked → ${blocked.status} ${blocked.text}`);
    const cleared = clearMailAuthLocks();
    const after = await passkeySignIn(auth);
    assert(after.status === 200, `after clearing the locks → ${after.status}`);
    return `account locked after ${locked}, passkey 200; IP locked after ${ipLocked} → 429 IP_LOCKED; ${cleared} lock keys cleared`;
  });

  await check('passkeys: legacy JSON security key migrated at the gateway start — second factor only', async () => {
    if (!c.legacyKeyUser) setCred('legacyKeyUser', `Lk-${Math.random().toString(36).slice(2)}-e2e!`);
    const LPW = creds().legacyKeyUser;
    const legacyId = await ensureUser(admin, LEGACY, LPW, state.domainId);
    const key = new SoftAuthenticator({ rpId: rp.rpId, origin: rp.origin });
    const json = JSON.stringify([key.legacyJson('YubiKey (old)')]);
    psql(`INSERT INTO user_mfa (id, "userId", "webAuthnCredentials", "backupCodes") VALUES ('e2e-legacy-mfa', ${sqlString(legacyId)}, ${sqlString(json)}::jsonb, '{}')
          ON CONFLICT ("userId") DO UPDATE SET "webAuthnCredentials" = EXCLUDED."webAuthnCredentials"`);
    psql(`DELETE FROM webauthn_credentials WHERE "userId" = ${sqlString(legacyId)}`);
    await resetGatewayRateLimits(); // restarts the api-gateway → startup backfill
    let rows;
    await waitFor(async () => {
      rows = (await http('GET', `/api/v1/admin/mailboxes/${legacyId}/passkeys`, { token: admin })).json?.passkeys ?? [];
      return rows.length === 1;
    }, { what: 'legacy key migrated', timeout: 30000 });
    assert(rows[0].kind === 'security_key' && rows[0].legacy === true, `row ${JSON.stringify(rows[0])}`);
    const pkLogin = await passkeySignIn(key, { userHandle: null });
    assert(pkLogin.json?.code === 'PASSKEY_NOT_ELIGIBLE', `passwordless with a legacy key → ${pkLogin.status} ${pkLogin.text}`);
    const l = await http('POST', '/auth/login', { body: { email: LEGACY, password: LPW } });
    assert(l.json?.mfaRequired && l.json.methods.includes('webauthn'), `password login → ${l.text.slice(0, 200)}`);
    const st = await http('POST', '/auth/mfa/webauthn/auth/start', { body: { challengeToken: l.json.challengeToken } });
    assert(st.status === 200 && st.json?.userVerification === 'discouraged', `start ${st.status} ${st.text.slice(0, 200)}`);
    const v = await http('POST', '/auth/mfa/verify', { body: { challengeToken: l.json.challengeToken, webauthnResponse: key.assert(st.json, { uv: false }) } });
    assert(v.status === 200 && v.json?.accessToken, `second factor (UV=0) → ${v.status} ${v.text.slice(0, 200)}`);
    pk.legacyId = legacyId;
    return 'migrated as security_key (legacy); passwordless 403 PASSKEY_NOT_ELIGIBLE; second factor without UV 200';
  });

  await check('passkeys: admin recovery link registers a new passkey and signs every session out', async () => {
    const before = Number(psql(`SELECT count(*) FROM sessions WHERE "userId" = ${sqlString(userId)}`));
    const rec = await http('POST', `/api/v1/admin/mailboxes/${userId}/passkey-recovery`, { token: admin });
    assert(rec.status === 200 && /\/passkey-recovery#[A-Za-z0-9_-]{40,}$/.test(rec.json?.url ?? ''), `recovery ${rec.status} ${rec.text.slice(0, 200)}`);
    const tok = rec.json.url.split('#')[1];
    const o = await http('POST', '/auth/passkey/recovery/options', { body: { token: tok } });
    assert(o.status === 200, `options ${o.status} ${o.text.slice(0, 200)}`);
    const fresh = new SoftAuthenticator({ rpId: rp.rpId, origin: rp.origin, backupEligible: false });
    const v = await http('POST', '/auth/passkey/recovery/verify', { body: { token: tok, flowId: o.json.flowId, response: fresh.register(o.json.publicKey), name: 'recovered' } });
    assert(v.status === 200, `verify ${v.status} ${v.text.slice(0, 200)}`);
    const after = Number(psql(`SELECT count(*) FROM sessions WHERE "userId" = ${sqlString(userId)}`));
    assert(after === 0, `sessions after recovery: ${after}`);
    const reuse = await http('POST', '/auth/passkey/recovery/options', { body: { token: tok } });
    assert(reuse.json?.code === 'PASSKEY_RECOVERY_INVALID', `reuse → ${reuse.status}`);
    assert((await passkeySignIn(fresh)).status === 200, 'sign-in with the recovered passkey');
    pk.recovered = true;
    return `sessions ${before} → ${after}; link single use; new passkey signs in`;
  });

  await check('passkeys: passkey-only — preconditions, password refused after verification, back off', async () => {
    const tooFew = await http('PUT', `/api/v1/admin/mailboxes/${pk.legacyId}/passkey-policy`, { token: admin, body: { passwordLoginDisabled: true } });
    assert(tooFew.status === 409 && tooFew.json?.code === 'NEEDS_PASSKEYS', `legacy-only account → ${tooFew.status} ${tooFew.text}`);
    const on = await http('PUT', `/api/v1/admin/mailboxes/${userId}/passkey-policy`, { token: admin, body: { passwordLoginDisabled: true } });
    assert(on.status === 200 && on.json?.passwordLoginDisabled === true, `on ${on.status} ${on.text.slice(0, 200)}`);
    const wrong = await http('POST', '/auth/login', { body: { email: EMAIL, password: 'definitely-wrong' } });
    const right = await http('POST', '/auth/login', { body: { email: EMAIL, password: PW } });
    assert(wrong.status === 401 && right.status === 403 && right.json?.code === 'PASSWORD_LOGIN_DISABLED', `wrong ${wrong.status}, right ${right.status} ${right.text}`);
    clearMailAuthLocks();
    const off = await http('PUT', `/api/v1/admin/mailboxes/${userId}/passkey-policy`, { token: admin, body: { passwordLoginDisabled: false } });
    assert(off.status === 200 && off.json?.passwordLoginDisabled === false, `off ${off.status}`);
    return 'legacy-only 409 NEEDS_PASSKEYS; wrong 401, correct 403 PASSWORD_LOGIN_DISABLED; switched back';
  });

  await check('passkeys: admin removes every passkey → PASSKEY_UNKNOWN; policy restored', async () => {
    const d = await http('DELETE', `/api/v1/admin/mailboxes/${userId}/passkeys`, { token: admin });
    assert(d.status === 200 && d.json?.removed >= 2, `remove all ${d.status} ${d.text.slice(0, 200)}`);
    const r = await passkeySignIn(auth);
    assert(r.json?.code === 'PASSKEY_UNKNOWN', `after removal → ${r.status} ${r.text}`);
    clearMailAuthLocks();
    for (const id of [userId, pk.legacyId]) await http('DELETE', `/api/v1/admin/mailboxes/${id}`, { token: admin });
    const restore = await http('PUT', '/api/v1/admin/authentication/passkeys', { token: admin, body: { enabled: pk.initialEnabled === true } });
    assert(restore.status === 200, `restore ${restore.status}`);
    return `removed ${d.json.removed}; users deleted; passkeys enabled=${pk.initialEnabled === true}`;
  });
}
