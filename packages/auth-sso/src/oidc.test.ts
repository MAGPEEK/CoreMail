/**
 * OIDC SSO flow tests (infra-free): fake Prisma/Redis + a fake IdP on loopback
 * issuing RS256 ID tokens (generated key, JWKS).
 * Run: node --import tsx --test src/oidc.test.ts  (in packages/auth-sso)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const sso = await import('./index.js');
const { FakeIdp } = await import('./testing.js');
const core = await import('@coremail/core');

const BASE = 'https://mail.example.com';
const CLIENT = { ip: '198.51.100.7', userAgent: 'test' };
const idp = new FakeIdp('coremail-client', 'client-secret-123');
let providerId = '';
let domainId = '';

before(async () => { await idp.start(); });
after(async () => { await idp.stop(); });

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'domain', 'oidcProvider', 'mailbox', 'folder', 'calendar', 'serverSettings'] as const) db[t].rows = [];
  redis.store.clear();
  sso.invalidateOidcClient();
  domainId = (await db.domain.create({ data: { name: 'example.com' } }))['id'] as string;
  await db.domain.create({ data: { name: 'other.org' } });
  providerId = (await db.oidcProvider.create({
    data: { domainId, name: 'Keycloak', discoveryUrl: idp.discoveryUrl, clientId: idp.clientId, clientSecret: idp.clientSecret },
  }))['id'] as string;
});

const verifiedAlice = { sub: 'sub-alice', claims: { email: 'alice@example.com', email_verified: true, name: 'Alice' } };

async function begin() {
  const r = await sso.startSso(providerId, 'mwa', BASE);
  assert.ok(r.ok, JSON.stringify(r));
  return r as { ok: true; url: string; cookie: string };
}

/** start → IdP login → callback */
async function flow(login: Parameters<typeof idp.authorize>[1], mutate?: (p: Record<string, string>) => void) {
  const s = await begin();
  const back = idp.authorize(s.url, login);
  const params: Record<string, string> = { code: back.code, state: back.state };
  mutate?.(params);
  const cb = await sso.completeSsoCallback(providerId, params, s.cookie, CLIENT);
  return { s, back, cb };
}

test('start: state, nonce and PKCE S256 stored server-side, bound to the cookie', async () => {
  const s = await begin();
  const q = new URL(s.url).searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), `${BASE}/auth/sso/${providerId}/callback`);
  assert.equal(q.get('scope'), 'openid email profile');
  const state = q.get('state')!;
  assert.ok(state.length >= 43 && q.get('nonce')!.length >= 43);
  const key = `auth:sso:state:${createHash('sha256').update(state).digest('hex')}`;
  const rec = JSON.parse((await redis.get(key))!) as Record<string, string>;
  assert.equal(rec['nonce'], q.get('nonce'));
  assert.equal(createHash('sha256').update(rec['codeVerifier']!).digest('base64url'), q.get('code_challenge'));
  assert.equal(rec['binding'], createHash('sha256').update(s.cookie).digest('hex'));
  assert.ok(!JSON.stringify(rec).includes(s.cookie), 'raw cookie not stored');
  const ttl = redis.store.get(key)!.exp! - Date.now();
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000);
  // unknown/inactive provider
  assert.deepEqual(await sso.startSso('nope', 'mwa', BASE), { ok: false, error: 'provider_unavailable' });
});

test('callback + exchange: auto-provisioned user and mailbox, single-use code', async () => {
  const { s, cb } = await flow(verifiedAlice);
  assert.ok(cb.ok, JSON.stringify(cb));
  const u = db.user.rows.find((r) => r['email'] === 'alice@example.com')!;
  assert.equal(u['authSource'], 'OIDC');
  assert.equal(u['externalId'], `oidc:${providerId}:sub-alice`);
  assert.ok(db.mailbox.rows.some((m) => m['userId'] === u['id']));
  assert.equal(db.folder.rows.length, 6);

  const code = (cb as { code: string }).code;
  assert.equal((await sso.exchangeSsoCode(code, 'wrong-cookie', CLIENT)).kind, 'invalid', 'cookie-bound');
  // the failed attempt consumed the code (single use, also on failure)
  assert.equal((await sso.exchangeSsoCode(code, s.cookie, CLIENT)).kind, 'invalid');

  const { s: s2, cb: cb2 } = await flow(verifiedAlice);
  const ex = await sso.exchangeSsoCode((cb2 as { code: string }).code, s2.cookie, CLIENT);
  assert.equal(ex.kind, 'tokens');
  const payload = core.verifyAccessToken((ex as { tokens: { accessToken: string } }).tokens.accessToken)!;
  assert.equal(payload.sub, u['id']);
  assert.equal(payload.mfaVerified, false, 'no amr → not MFA-verified');
  assert.equal(db.session.rows.length, 1);
  assert.equal((await sso.exchangeSsoCode((cb2 as { code: string }).code, s2.cookie, CLIENT)).kind, 'invalid', 'replay');
});

test('callback rejects mismatched state, missing/wrong cookie and state replay', async () => {
  const tokenRequestsBefore = idp.tokenRequests;
  const s = await begin();
  const back = idp.authorize(s.url, verifiedAlice);
  assert.deepEqual(await sso.completeSsoCallback(providerId, { code: back.code, state: 'forged' }, s.cookie, CLIENT),
    { ok: false, error: 'invalid_state', target: 'mwa' });
  // wrong cookie → refused, and the state is burned
  assert.equal((await sso.completeSsoCallback(providerId, { code: back.code, state: back.state }, 'other-browser', CLIENT) as { error: string }).error, 'invalid_state');
  assert.equal((await sso.completeSsoCallback(providerId, { code: back.code, state: back.state }, s.cookie, CLIENT) as { error: string }).error, 'invalid_state');
  assert.equal(idp.tokenRequests, tokenRequestsBefore, 'no code exchange without a valid state');

  // a successfully used state cannot be replayed
  const { s: s2, back: b2, cb } = await flow(verifiedAlice);
  assert.ok(cb.ok);
  assert.equal((await sso.completeSsoCallback(providerId, { code: b2.code, state: b2.state }, s2.cookie, CLIENT) as { error: string }).error, 'invalid_state');
  // state of another provider
  const other = (await db.oidcProvider.create({ data: { domainId, name: 'X', discoveryUrl: idp.discoveryUrl, clientId: 'x', clientSecret: 'y' } }))['id'] as string;
  const s3 = await begin();
  const b3 = idp.authorize(s3.url, verifiedAlice);
  assert.equal((await sso.completeSsoCallback(other, { code: b3.code, state: b3.state }, s3.cookie, CLIENT) as { error: string }).error, 'invalid_state');
});

test('ID token validation: nonce, audience, issuer, expiry, signature', async () => {
  const cases: Parameters<typeof idp.authorize>[1][] = [
    { ...verifiedAlice, tokenOverride: { nonce: 'other-nonce' } },
    { ...verifiedAlice, tokenOverride: { aud: 'someone-else' } },
    { ...verifiedAlice, tokenOverride: { iss: 'https://evil.example' } },
    { ...verifiedAlice, tokenOverride: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } },
    { ...verifiedAlice, badSignature: true },
  ];
  for (const login of cases) {
    const { cb } = await flow(login);
    assert.deepEqual(cb, { ok: false, error: 'token_invalid', target: 'mwa' }, JSON.stringify(login.tokenOverride ?? 'badSig'));
  }
  assert.equal(db.user.rows.length, 0);
});

test('PKCE: a wrong code_verifier is rejected by the IdP', async () => {
  const s = await begin();
  const back = idp.authorize(s.url, verifiedAlice);
  const key = `auth:sso:state:${createHash('sha256').update(back.state).digest('hex')}`;
  const rec = JSON.parse((await redis.get(key))!) as Record<string, string>;
  rec['codeVerifier'] = 'x'.repeat(43);
  await redis.setex(key, 600, JSON.stringify(rec));
  const cb = await sso.completeSsoCallback(providerId, { code: back.code, state: back.state }, s.cookie, CLIENT);
  assert.deepEqual(cb, { ok: false, error: 'token_invalid', target: 'mwa' });
});

test('email_verified required by default; per-provider opt-out', async () => {
  for (const ev of [false, undefined, 'false']) {
    const { cb } = await flow({ sub: 's1', claims: { email: 'alice@example.com', ...(ev === undefined ? {} : { email_verified: ev }) } });
    assert.equal((cb as { error?: string }).error, 'email_unverified');
  }
  await db.oidcProvider.update({ where: { id: providerId }, data: { requireEmailVerified: false } });
  const { cb } = await flow({ sub: 's1', claims: { email: 'alice@example.com' } });
  assert.ok(cb.ok);
});

test('foreign / non-allowed e-mail domains are rejected', async () => {
  for (const email of ['bob@evil.net', 'bob@other.org']) {
    const { cb } = await flow({ sub: 's2', claims: { email, email_verified: true } });
    assert.equal((cb as { error?: string }).error, 'domain_not_allowed', email);
  }
  // explicit allow-list including other.org
  await db.oidcProvider.update({ where: { id: providerId }, data: { forcedDomains: ['example.com', 'other.org'] } });
  assert.ok((await flow({ sub: 's2', claims: { email: 'bob@other.org', email_verified: true } })).cb.ok);
  assert.equal(((await flow({ sub: 's3', claims: { email: 'x@evil.net', email_verified: true } })).cb as { error?: string }).error, 'domain_not_allowed');
});

test('account mapping: LOCAL needs allowLinking, OIDC bound to its subject, inactive, autoProvision off', async () => {
  await db.user.create({ data: { email: 'alice@example.com', authSource: 'LOCAL', passwordHash: 'h', domainId } });
  assert.equal(((await flow(verifiedAlice)).cb as { error?: string }).error, 'account_not_linked');
  await db.oidcProvider.update({ where: { id: providerId }, data: { allowLinking: true } });
  assert.ok((await flow(verifiedAlice)).cb.ok);
  assert.equal(db.user.rows[0]!['authSource'], 'LOCAL', 'linking does not convert the account');

  await db.user.create({ data: { email: 'bob@example.com', authSource: 'OIDC', externalId: `oidc:${providerId}:sub-bob`, domainId } });
  const asBob = (sub: string) => ({ sub, claims: { email: 'bob@example.com', email_verified: true } });
  assert.equal(((await flow(asBob('sub-attacker'))).cb as { error?: string }).error, 'account_mismatch');
  assert.ok((await flow(asBob('sub-bob'))).cb.ok);

  await db.user.create({ data: { email: 'carol@example.com', authSource: 'OIDC', active: false, domainId } });
  assert.equal(((await flow({ sub: 'c', claims: { email: 'carol@example.com', email_verified: true } })).cb as { error?: string }).error, 'account_inactive');

  await db.oidcProvider.update({ where: { id: providerId }, data: { autoProvision: false } });
  assert.equal(((await flow({ sub: 'd', claims: { email: 'dave@example.com', email_verified: true } })).cb as { error?: string }).error, 'no_account');
});

test('MFA policy: IdP trusted by default; requireMfa → CoreMail challenge; amr → mfaVerified', async () => {
  const u = await db.user.create({ data: { email: 'alice@example.com', authSource: 'OIDC', domainId } });
  await db.userMfa.create({ data: { userId: u['id'], totpEnabled: true, totpSecret: 'x', backupCodes: [] } });

  let { s, cb } = await flow({ ...verifiedAlice, claims: { ...verifiedAlice.claims, amr: ['pwd', 'mfa'] } });
  let ex = await sso.exchangeSsoCode((cb as { code: string }).code, s.cookie, CLIENT);
  assert.equal(ex.kind, 'tokens', 'default: no CoreMail MFA prompt');
  assert.equal(core.verifyAccessToken((ex as { tokens: { accessToken: string } }).tokens.accessToken)!.mfaVerified, true);

  await db.oidcProvider.update({ where: { id: providerId }, data: { requireMfa: true } });
  ({ s, cb } = await flow(verifiedAlice));
  ex = await sso.exchangeSsoCode((cb as { code: string }).code, s.cookie, CLIENT);
  assert.equal(ex.kind, 'mfa');
  assert.deepEqual((ex as { methods: string[] }).methods, ['totp']);
  assert.ok((ex as { challengeToken: string }).challengeToken);
});

test('public provider list hides secrets and inactive providers', async () => {
  await db.oidcProvider.create({ data: { domainId, name: 'Off', discoveryUrl: 'https://x', clientId: 'c', clientSecret: 's', active: false } });
  const list = await sso.listPublicProviders();
  assert.deepEqual(list, [{ id: providerId, name: 'Keycloak' }]);
  assert.ok(!JSON.stringify(list).includes('client-secret-123'));
});

test('describeDiscovery summarizes the discovery document', async () => {
  const d = await sso.describeDiscovery(idp.discoveryUrl);
  assert.equal(d.issuer, idp.issuer);
  assert.equal(d.pkceS256, true);
  assert.equal(d.jwksUri, `${idp.issuer}/jwks`);
});
