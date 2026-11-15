/**
 * v8.1: the web/API login shares the Redis per-account / per-IP lockout of the
 * mail protocols (finding: web login only had an in-memory per-IP limit).
 * Infra-free: Prisma via globalThis.__prisma, one FakeRedis for both
 * globalThis.__authRedis and globalThis.__mailAuthRedis.
 * Run: node --import tsx --test src/auth/lockout.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];
process.env['MAIL_AUTH_IP_MAX_FAILURES'] = '12'; // keeps the per-IP test fast (default 50)
process.env['MAIL_AUTH_EXEMPT_CIDRS'] = '10.0.0.0/8'; // PRIVATE stands for a trusted proxy network (only loopback is exempt by default since v8.1)

const { createFakePrisma, createFakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = redis;

const core = await import('@coremail/core');
const auth = await import('./index.js');
const mailAuth = await import('../mail-auth.js');

const PUBLIC = { ip: '203.0.113.7', userAgent: 'test' };
const PRIVATE = { ip: '10.0.0.5', userAgent: 'test' };
const PW = 'correct horse battery';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let pwHash = '';

async function addUser(email: string, extra: Record<string, unknown> = {}) {
  pwHash ||= await core.hashPassword(PW);
  return db.user.create({ data: { email, passwordHash: pwHash, ...extra } });
}

beforeEach(() => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'serverSettings', 'domain'] as const) db[t].rows = [];
  redis.store.clear();
});

async function failTimes(email: string, n: number, client = PRIVATE) {
  for (let i = 0; i < n; i++) assert.equal((await auth.login(email, `wrong-${i}`, client)).kind, 'invalid');
}

test('lockout: 10 failed web logins lock the account — even the right password gets 429 ACCOUNT_LOCKED', async () => {
  await addUser('alice@example.com');
  await failTimes('alice@example.com', 10);
  const o = await auth.login('alice@example.com', PW, PUBLIC);
  assert.equal(o.kind, 'locked');
  const http = auth.loginOutcomeToHttp(o);
  assert.equal(http.status, 429);
  assert.equal(http.body['code'], 'ACCOUNT_LOCKED');
  assert.ok(Number(http.headers?.['Retry-After']) > 0);
  assert.equal(db.session.rows.length, 0, 'no session while locked');
  // case/whitespace variants hit the same counter
  assert.equal((await auth.login('  ALICE@Example.com ', PW, PRIVATE)).kind, 'locked');
});

test('lockout: unknown accounts lock exactly like real ones (no enumeration)', async () => {
  await addUser('alice@example.com');
  await failTimes('ghost@example.com', 10);
  await failTimes('alice@example.com', 10);
  const ghost = auth.loginOutcomeToHttp(await auth.login('ghost@example.com', PW, PRIVATE));
  const alice = auth.loginOutcomeToHttp(await auth.login('alice@example.com', PW, PRIVATE));
  assert.equal(ghost.status, 429);
  assert.deepEqual({ ...ghost.body, retryAfter: 0 }, { ...alice.body, retryAfter: 0 });
});

test('lockout: web and mail-protocol failures share one account counter', async () => {
  await addUser('alice@example.com');
  await failTimes('alice@example.com', 5);
  for (let i = 0; i < 5; i++) {
    const r = await mailAuth.verifyMailCredentials('alice@example.com', `bad-${i}`, { ip: PUBLIC.ip, protocol: 'imap' });
    assert.equal(r.status, 'invalid');
  }
  // locked for both front doors now
  assert.equal((await auth.login('alice@example.com', PW, PUBLIC)).kind, 'locked');
  const mail = await mailAuth.verifyMailCredentials('alice@example.com', PW, { ip: PUBLIC.ip, protocol: 'smtp' });
  assert.equal(mail.status, 'locked');
});

test('lockout: a mail-protocol lockout also blocks the web login', async () => {
  await addUser('bob@example.com');
  for (let i = 0; i < 10; i++) await mailAuth.verifyMailCredentials('bob@example.com', `bad-${i}`, { ip: '10.1.1.1', protocol: 'pop3' });
  assert.equal((await auth.login('bob@example.com', PW, PUBLIC)).kind, 'locked');
});

test('lockout: a successful login resets the account counter', async () => {
  await addUser('alice@example.com');
  await failTimes('alice@example.com', 9);
  assert.equal((await auth.login('alice@example.com', PW, PUBLIC)).kind, 'tokens');
  await failTimes('alice@example.com', 9);
  assert.equal((await auth.login('alice@example.com', PW, PUBLIC)).kind, 'tokens', 'counter was reset');
});

test('lockout: per-IP counter across accounts; private IPs are exempt from it', async () => {
  for (let i = 0; i < 12; i++) await auth.login(`spray${i}@example.com`, 'x', PUBLIC);
  await addUser('carol@example.com');
  assert.equal((await auth.login('carol@example.com', PW, PUBLIC)).kind, 'locked', 'IP locked');
  assert.equal((await auth.login('carol@example.com', PW, { ...PUBLIC, ip: '198.51.100.9' })).kind, 'tokens', 'other IP fine');

  redis.store.clear();
  for (let i = 0; i < 15; i++) await auth.login(`spray${i}@example.com`, 'x', PRIVATE);
  assert.equal((await auth.login('carol@example.com', PW, PRIVATE)).kind, 'tokens', 'private IP not IP-locked');
});

test('lockout: MFA failures count; while locked a correct password gets 429, never mfaRequired', async () => {
  const u = await addUser('dave@example.com');
  await db.userMfa.create({ data: { userId: u['id'], totpSecret: auth.encryptMfaSecret(SECRET), totpEnabled: true } });

  // correct password → challenge, but the counter is NOT reset by the password step
  await failTimes('dave@example.com', 4);
  let o = await auth.login('dave@example.com', PW, PUBLIC);
  assert.equal(o.kind, 'mfa');
  for (let i = 0; i < 4; i++) {
    const r = await auth.completeMfaLogin({ challengeToken: (o as { challengeToken: string }).challengeToken, code: '000000' }, PUBLIC);
    assert.equal(r.kind, 'mfa_failed');
  }
  o = await auth.login('dave@example.com', PW, PUBLIC);
  assert.equal(o.kind, 'mfa');
  const tok = (o as { challengeToken: string }).challengeToken;
  assert.equal((await auth.completeMfaLogin({ challengeToken: tok, code: '000001' }, PUBLIC)).kind, 'mfa_failed');
  assert.equal((await auth.completeMfaLogin({ challengeToken: tok, code: '000002' }, PUBLIC)).kind, 'mfa_failed');
  // 4 password + 6 MFA failures = 10 → locked
  const locked = await auth.login('dave@example.com', PW, PUBLIC);
  assert.equal(locked.kind, 'locked');
  assert.equal(auth.loginOutcomeToHttp(locked).body['mfaRequired'], undefined);
  // a valid TOTP on a still-open challenge is refused as well
  const code = auth.totpCode(SECRET);
  assert.equal((await auth.completeMfaLogin({ challengeToken: tok, code }, PUBLIC)).kind, 'locked');
  assert.equal(db.session.rows.length, 0);
});

test('lockout: a completed MFA login resets the account counter', async () => {
  const u = await addUser('erin@example.com');
  await db.userMfa.create({ data: { userId: u['id'], totpSecret: auth.encryptMfaSecret(SECRET), totpEnabled: true } });
  await failTimes('erin@example.com', 8);
  const o = await auth.login('erin@example.com', PW, PUBLIC);
  const code = auth.totpCode(SECRET);
  const done = await auth.completeMfaLogin({ challengeToken: (o as { challengeToken: string }).challengeToken, code }, PUBLIC);
  assert.equal(done.kind, 'tokens');
  await failTimes('erin@example.com', 9);
  assert.equal((await auth.login('erin@example.com', PW, PUBLIC)).kind, 'mfa');
});
