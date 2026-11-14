/**
 * JMAP Basic auth on the shared mail credential check (v7): behaviour kept
 * (MFA → app passwords only, directory (LDAP) users via the registered
 * external verifier,
 * 60 s cache), plus shared lockout (429) and DB errors (503).
 * Run: node --import tsx --import ./src/test-env.ts --test src/auth-basic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const state = { dbDown: false };
const base = { domainId: 'd1', role: 'USER', mailbox: null, active: true };
const users = [
  { ...base, id: 'u1', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: null },
  { ...base, id: 'u2', email: 'mfa@example.com', displayName: 'Mfa', passwordHash: 'hash:pw', authSource: 'LOCAL',
    mfa: { totpEnabled: true, webAuthnCredentials: [] } },
  { ...base, id: 'u3', email: 'ldap@example.com', displayName: 'Ldap', passwordHash: null, authSource: 'LDAP', mfa: null },
];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => {
      if (state.dbDown) throw new Error('db down');
      return users.find((u) => u.email === where.email) ?? null;
    },
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => (where.userId === 'u2' ? [{ id: 'ap', hash: 'hash:APP-PW' }] : []),
    update: async () => ({}),
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
};
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 3 },
});
// v7: directory users are verified by the registered external verifier (in
// production registerLdapMailVerifier() from @coremail/auth-ldap; here a fake).
const directoryCalls: string[] = [];
storage.registerExternalPasswordVerifier('ldap', async (user, password) => {
  directoryCalls.push(user.email);
  return user.authSource === 'LDAP' && password === 'dir-pw';
});
const { authenticateBasic, AuthUnavailableError } = await import('./auth.js');

test('primary password works without MFA', async () => {
  assert.equal((await authenticateBasic('bob@example.com', 'pw', '203.0.113.1'))?.userId, 'u1');
});

test('MFA: primary password rejected, app password accepted', async () => {
  assert.equal(await authenticateBasic('mfa@example.com', 'pw', '203.0.113.1'), null);
  assert.equal((await authenticateBasic('mfa@example.com', 'APP-PW', '203.0.113.1'))?.userId, 'u2');
});

test('LDAP users are verified via the registered directory verifier', async () => {
  assert.equal((await authenticateBasic('ldap@example.com', 'dir-pw', '203.0.113.1'))?.userId, 'u3');
  assert.ok(directoryCalls.includes('ldap@example.com'));
  assert.equal(await authenticateBasic('ldap@example.com', 'nope', '203.0.113.1'), null);
});

test('database error → AuthUnavailableError(temporary)', async () => {
  state.dbDown = true;
  try {
    await assert.rejects(authenticateBasic('bob@example.com', 'other-pw', '203.0.113.2'),
      (e: unknown) => e instanceof AuthUnavailableError && e.reason === 'temporary');
  } finally {
    state.dbDown = false;
  }
});

test('shared lockout → AuthUnavailableError(locked)', async () => {
  for (let i = 0; i < 3; i++) await authenticateBasic('mfa@example.com', `bad${i}`, `198.51.100.${i}`);
  await assert.rejects(authenticateBasic('mfa@example.com', 'APP-PW2', '198.51.100.9'),
    (e: unknown) => e instanceof AuthUnavailableError && e.reason === 'locked');
});
