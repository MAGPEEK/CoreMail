/**
 * User.lastLoginAt (8.x): set by web login (issueSession — password, MFA, SSO)
 * and mail-protocol logins (verifyMailCredentials), at most one write per user
 * per 5 minutes; a failed write never fails a login.
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/auth/last-login.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma, createFakeRedis } = await import('./testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = null;

const core = await import('@coremail/core');
const auth = await import('./index.js');
const { verifyMailCredentials } = await import('../mail-auth.js');

const PW = 'correct horse battery';
const client = { ip: '203.0.113.9', userAgent: 'test' };

async function addUser(email: string) {
  return db.user.create({ data: { email, passwordHash: await core.hashPassword(PW), role: 'USER', active: true, domainId: 'd1' } });
}
const lastLogin = async (id: string) => ((await db.user.findUnique({ where: { id } })) as { lastLoginAt?: Date | null } | null)?.lastLoginAt ?? null;
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => auth.resetLastLoginThrottle());

test('recordLastLogin writes, then throttles for 5 minutes per user', async () => {
  const u = await addUser('throttle@ex.com') as { id: string };
  const t0 = Date.UTC(2026, 10, 15, 10, 0, 0);
  assert.equal(await auth.recordLastLogin(u.id, t0), true);
  assert.equal((await lastLogin(u.id))?.getTime(), t0);
  assert.equal(await auth.recordLastLogin(u.id, t0 + 60_000), false, 'within 5 min → no write');
  assert.equal((await lastLogin(u.id))?.getTime(), t0);
  assert.equal(await auth.recordLastLogin(u.id, t0 + auth.LAST_LOGIN_WRITE_INTERVAL_MS), true);
  assert.equal((await lastLogin(u.id))?.getTime(), t0 + auth.LAST_LOGIN_WRITE_INTERVAL_MS);
  assert.equal(await auth.recordLastLogin('', t0), false);
});

test('a failing write never throws and does not block the next attempt', async () => {
  const orig = db.user.updateMany;
  db.user.updateMany = async () => { throw new Error('db down'); };
  try {
    assert.equal(await auth.recordLastLogin('u-x', 1_000), true);
  } finally {
    db.user.updateMany = orig;
  }
  const u = await addUser('retry@ex.com') as { id: string };
  db.user.updateMany = async () => { throw new Error('db down'); };
  await auth.recordLastLogin(u.id, 5_000);
  db.user.updateMany = orig;
  assert.equal(await auth.recordLastLogin(u.id, 6_000), true, 'retried right away after a failure');
  assert.equal((await lastLogin(u.id))?.getTime(), 6_000);
});

test('web login (issueSession) sets lastLoginAt', async () => {
  const u = await addUser('web@ex.com') as { id: string };
  assert.equal(await lastLogin(u.id), null);
  const r = await auth.login('web@ex.com', PW, client);
  assert.equal(r.kind, 'tokens');
  await settle();
  assert.ok(await lastLogin(u.id), 'set after the password login');
});

test('mail-protocol login (verifyMailCredentials) sets lastLoginAt; a failed one does not', async () => {
  const u = await addUser('imap@ex.com') as { id: string };
  const bad = await verifyMailCredentials('imap@ex.com', 'wrong password', { protocol: 'imap', ip: '198.51.100.1' });
  assert.equal(bad.status, 'invalid');
  await settle();
  assert.equal(await lastLogin(u.id), null);
  const ok = await verifyMailCredentials('imap@ex.com', PW, { protocol: 'imap', ip: '198.51.100.1' });
  assert.equal(ok.status, 'ok');
  await settle();
  assert.ok(await lastLogin(u.id));
});
