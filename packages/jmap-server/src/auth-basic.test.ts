/**
 * JMAP Basic auth on the shared mail credential check (v7): behaviour kept
 * (MFA → app passwords only, directory (LDAP) users via the registered
 * external verifier,
 * 60 s cache), plus shared lockout (429) and DB errors (503).
 * Run: node --import tsx --import ./src/test-env.ts --test src/auth-basic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeProtocolPolicies } from '@coremail/storage/auth/testing';

const state = { dbDown: false };
const base = { domainId: 'd1', role: 'USER', mailbox: null, active: true };
const users = [
  { ...base, id: 'u1', email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: null },
  { ...base, id: 'u2', email: 'mfa@example.com', displayName: 'Mfa', passwordHash: 'hash:pw', authSource: 'LOCAL',
    mfa: { totpEnabled: true, webAuthnCredentials: [] } },
  { ...base, id: 'u3', email: 'ldap@example.com', displayName: 'Ldap', passwordHash: null, authSource: 'LDAP', mfa: null },
];
/** 9.4: ProtocolPolicy rows (protocol switches). */
const policies: Array<Record<string, unknown>> = [];
const prisma: Record<string, unknown> = {
  $on: () => undefined,
  ...fakeProtocolPolicies(policies),
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => {
      if (state.dbDown) throw new Error('db down');
      return users.find((u) => u.email === where.email) ?? null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null,
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => (where.userId === 'u2' ? [{ id: 'ap', hash: 'hash:APP-PW' }] : []),
    update: async () => ({}),
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
};
(globalThis as Record<string, unknown>)['__prisma'] = prisma;
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
const { authenticateBasic, authenticateCredentials, AuthUnavailableError, JmapDisabledError } = await import('./auth.js');

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

test('9.4: JMAP switched off → JmapDisabledError after correct credentials only (also from the cache)', async () => {
  const basic = (pw: string) => `Basic ${Buffer.from(`bob@example.com:${pw}`).toString('base64')}`;
  assert.equal((await authenticateCredentials(basic('pw'), undefined, '203.0.113.3'))?.userId, 'u1', 'cached now');
  policies.push({ id: 'p-u1', userId: 'u1', domainId: null, jmap: 'OFF' });
  storage.invalidateProtocolAccessCache();
  try {
    await assert.rejects(authenticateCredentials(basic('pw'), undefined, '203.0.113.3'),
      (e: unknown) => e instanceof JmapDisabledError && e.userId === 'u1');
    assert.equal(await authenticateCredentials(basic('wrong'), undefined, '203.0.113.3'), null);
  } finally {
    policies.length = 0;
    storage.invalidateProtocolAccessCache();
  }
  assert.equal((await authenticateCredentials(basic('pw'), undefined, '203.0.113.3'))?.userId, 'u1');
});

test('9.4: an unreadable JMAP switch is a temporary failure (503), never a password prompt', async () => {
  const basic = `Basic ${Buffer.from('bob@example.com:pw').toString('base64')}`;
  assert.equal((await authenticateCredentials(basic, undefined, '203.0.113.4'))?.userId, 'u1', 'cached credentials');
  const policy = prisma['protocolPolicy'] as { findMany: () => Promise<unknown> };
  const findMany = policy.findMany;
  policy.findMany = async () => { throw new Error('db down'); };
  storage.invalidateProtocolAccessCache();
  try {
    await assert.rejects(authenticateCredentials(basic, undefined, '203.0.113.4'),
      (e: unknown) => e instanceof AuthUnavailableError && e.reason === 'temporary');
  } finally {
    policy.findMany = findMany;
    storage.invalidateProtocolAccessCache();
  }
});

test('9.4: JMAP push subscriptions are only notified for users with JMAP on', async () => {
  const { jmapPushRecipients } = await import('./push/bus.js');
  policies.push({ id: 'p-u2', userId: 'u2', domainId: null, jmap: 'OFF' });
  storage.invalidateProtocolAccessCache();
  try {
    assert.deepEqual(await jmapPushRecipients(['u1', 'u2', 'u3']), ['u1', 'u3']);
  } finally {
    policies.length = 0;
    storage.invalidateProtocolAccessCache();
  }
});

test('shared lockout → AuthUnavailableError(locked)', async () => {
  for (let i = 0; i < 3; i++) await authenticateBasic('mfa@example.com', `bad${i}`, `198.51.100.${i}`);
  await assert.rejects(authenticateBasic('mfa@example.com', 'APP-PW2', '198.51.100.9'),
    (e: unknown) => e instanceof AuthUnavailableError && e.reason === 'locked');
});
