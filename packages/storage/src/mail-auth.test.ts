/**
 * Shared mail-protocol credential check (mail-auth-core.ts / mail-auth.ts).
 * Infra-free: Prisma and Redis are in-memory fakes, a password P matches "hash:P".
 * Run: node --import tsx --test src/mail-auth.test.ts  (in packages/storage)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

import {
  createMailCredentialVerifier, createMemoryAuthRedis, isPrivateOrLoopbackIp, clientIpFromRequest,
  registerExternalPasswordVerifier, unregisterExternalPasswordVerifier,
  type MailAuthDeps, type MailAuthPrisma, type MailAuthRedis,
} from './mail-auth-core.js';

interface FakeUser {
  id: string; email: string; displayName: string; domainId: string; role: string; active: boolean;
  passwordHash: string | null; authSource: string;
  mfa: { totpEnabled: boolean; webAuthnCredentials: unknown } | null;
  mailbox: { id: string } | null;
}

function fixture() {
  const users: FakeUser[] = [
    { id: 'u-plain', email: 'plain@example.test', displayName: 'Plain', domainId: 'd1', role: 'USER', active: true,
      passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb-plain' } },
    { id: 'u-totp', email: 'totp@example.test', displayName: 'Totp', domainId: 'd1', role: 'USER', active: true,
      passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: { totpEnabled: true, webAuthnCredentials: [] }, mailbox: null },
    { id: 'u-webauthn', email: 'key@example.test', displayName: 'Key', domainId: 'd1', role: 'USER', active: true,
      passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: { totpEnabled: false, webAuthnCredentials: [{ id: 'c1' }] }, mailbox: null },
    { id: 'u-gone', email: 'gone@example.test', displayName: 'Gone', domainId: 'd1', role: 'USER', active: false,
      passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: null },
    { id: 'u-ldap', email: 'ldap@example.test', displayName: 'Ldap', domainId: 'd1', role: 'USER', active: true,
      passwordHash: null, authSource: 'LDAP', mfa: null, mailbox: null },
  ];
  const appPasswords = [
    { id: 'ap-plain', userId: 'u-plain', hash: 'hash:APP1-APP1' },
    { id: 'ap-totp', userId: 'u-totp', hash: 'hash:APP2-APP2' },
    { id: 'ap-key', userId: 'u-webauthn', hash: 'hash:APP3-APP3' },
    { id: 'ap-gone', userId: 'u-gone', hash: 'hash:APP4-APP4' },
  ];
  const calls = { verify: [] as string[], lastUsed: [] as string[], userQueries: [] as unknown[] };
  const state = { dbDown: false, primaryDomain: 'example.test' as string | null };
  const prisma: MailAuthPrisma = {
    user: {
      async findFirst(args) {
        if (state.dbDown) throw new Error('db down');
        calls.userQueries.push(args);
        const where = (args as { where: { email: string; active: boolean } }).where;
        return users.find((u) => u.email === where.email && u.active === where.active) ?? null;
      },
    },
    appPassword: {
      async findMany(args) {
        if (state.dbDown) throw new Error('db down');
        const where = (args as { where: { userId: string } }).where;
        return appPasswords.filter((a) => a.userId === where.userId);
      },
      async update(args) {
        calls.lastUsed.push((args as { where: { id: string } }).where.id);
        return {};
      },
    },
    domain: {
      async findFirst() {
        if (state.dbDown) throw new Error('db down');
        return state.primaryDomain ? { name: state.primaryDomain } : null;
      },
    },
  };
  const redis = createMemoryAuthRedis();
  const deps: MailAuthDeps = {
    prisma,
    redis,
    verifyPassword: async (p, h) => { calls.verify.push(h); return h === `hash:${p}`; },
    dummyHash: async () => 'hash:\0dummy',
    limits: { ipMaxFailures: 5, accountMaxFailures: 3, ipLockBaseSec: 60, accountLockBaseSec: 30 },
  };
  return { users, calls, state, redis, deps, verifier: createMailCredentialVerifier(deps) };
}

const PUBLIC_IP = '203.0.113.7';
const ctx = (ip = PUBLIC_IP) => ({ ip, protocol: 'imap' as const });

describe('credential matrix', () => {
  test('no MFA: primary password → ok(password)', async () => {
    const { verifier } = fixture();
    const r = await verifier.verify('plain@example.test', 'secret', ctx());
    assert.equal(r.status, 'ok');
    assert.ok(r.status === 'ok' && r.method === 'password' && r.user.id === 'u-plain' && r.user.mailboxId === 'mb-plain');
  });

  test('no MFA: app password → ok(app_password) and lastUsedAt is updated', async () => {
    const { verifier, calls } = fixture();
    const r = await verifier.verify('plain@example.test', 'APP1-APP1', ctx());
    assert.ok(r.status === 'ok' && r.method === 'app_password');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.lastUsed, ['ap-plain']);
  });

  test('no MFA: wrong password → invalid', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('plain@example.test', 'nope', ctx())).status, 'invalid');
  });

  test('TOTP: primary password is rejected with mfa_app_password_required', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('totp@example.test', 'secret', ctx())).status, 'mfa_app_password_required');
  });

  test('WebAuthn credentials count as MFA as well', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('key@example.test', 'secret', ctx())).status, 'mfa_app_password_required');
    const ok = await verifier.verify('key@example.test', 'APP3-APP3', ctx());
    assert.ok(ok.status === 'ok' && ok.method === 'app_password');
  });

  test('TOTP: app password → ok, wrong password → invalid', async () => {
    const { verifier } = fixture();
    const ok = await verifier.verify('totp@example.test', 'APP2-APP2', ctx());
    assert.ok(ok.status === 'ok' && ok.method === 'app_password');
    assert.equal((await verifier.verify('totp@example.test', 'nope', ctx())).status, 'invalid');
  });

  test('inactive user: neither password nor app password works', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('gone@example.test', 'secret', ctx())).status, 'invalid');
    assert.equal((await verifier.verify('gone@example.test', 'APP4-APP4', ctx())).status, 'invalid');
  });

  test('unknown user → invalid, verified against the dummy hash (timing)', async () => {
    const { verifier, calls } = fixture();
    const r = await verifier.verify('nobody@example.test', 'secret', ctx());
    assert.equal(r.status, 'invalid');
    assert.deepEqual(calls.verify, ['hash:\0dummy']);
  });

  test('a user without a local hash also burns one dummy verification', async () => {
    const { verifier, calls } = fixture();
    assert.equal((await verifier.verify('ldap@example.test', 'pw', ctx())).status, 'invalid');
    assert.ok(calls.verify.includes('hash:\0dummy'));
  });

  test('database error → error (never invalid), also for the domain lookup', async () => {
    const { verifier, state } = fixture();
    state.dbDown = true;
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx())).status, 'error');
    assert.equal((await verifier.verify('plain', 'secret', ctx())).status, 'error');
  });

  test('a database error does not count as a failed attempt', async () => {
    const { verifier, state, redis } = fixture();
    state.dbDown = true;
    for (let i = 0; i < 5; i++) await verifier.verify('plain@example.test', 'secret', ctx());
    assert.deepEqual((redis as unknown as { keys(): string[] }).keys(), []);
  });

  test('empty password → invalid without touching the database', async () => {
    const { verifier, calls } = fixture();
    assert.equal((await verifier.verify('plain@example.test', '', ctx())).status, 'invalid');
    assert.equal(calls.userQueries.length, 0);
  });
});

describe('login normalisation', () => {
  test('case and whitespace are normalised', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('  Plain@Example.TEST ', 'secret', ctx())).status, 'ok');
  });

  test('a bare user name is completed with the primary domain', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('plain', 'secret', ctx())).status, 'ok');
  });

  test('DOMAIN\\user is reduced to user', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('CORP\\plain', 'secret', ctx())).status, 'ok');
    assert.equal((await verifier.verify('CORP\\plain@example.test', 'secret', ctx())).status, 'ok');
  });

  test('a bare user name without a primary domain does not match', async () => {
    const { verifier, state } = fixture();
    state.primaryDomain = null;
    assert.equal((await verifier.verify('plain', 'secret', ctx())).status, 'invalid');
  });

  test('only active users are queried', async () => {
    const { verifier, calls } = fixture();
    await verifier.verify('plain@example.test', 'secret', ctx());
    assert.deepEqual((calls.userQueries[0] as { where: unknown }).where, { email: 'plain@example.test', active: true });
  });
});

describe('brute-force protection', () => {
  test('the account is locked after N failures, also for the correct password', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 3; i++) assert.equal((await verifier.verify('plain@example.test', 'x', ctx(`198.51.100.${i}`))).status, 'invalid');
    const r = await verifier.verify('plain@example.test', 'secret', ctx('198.51.100.99'));
    assert.equal(r.status, 'locked');
    assert.ok(r.status === 'locked' && r.scope === 'account' && r.retryAfterSec > 0 && r.retryAfterSec <= 30);
  });

  test('a locked attempt does not verify any password', async () => {
    const { verifier, calls } = fixture();
    for (let i = 0; i < 3; i++) await verifier.verify('plain@example.test', 'x', ctx());
    calls.verify.length = 0;
    await verifier.verify('plain@example.test', 'secret', ctx());
    assert.deepEqual(calls.verify, []);
  });

  test('unknown accounts are counted too (no enumeration through the lockout)', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 3; i++) await verifier.verify('ghost@example.test', 'x', ctx(`198.51.100.${i}`));
    assert.equal((await verifier.verify('ghost@example.test', 'x', ctx('198.51.100.50'))).status, 'locked');
  });

  test('the client IP is locked after N failures across different accounts', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 5; i++) await verifier.verify(`user${i}@example.test`, 'x', ctx());
    const r = await verifier.verify('plain@example.test', 'secret', ctx());
    assert.ok(r.status === 'locked' && r.scope === 'ip', JSON.stringify(r));
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx('203.0.113.8'))).status, 'ok');
  });

  test('a successful login does NOT reset the per-IP counter', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 4; i++) await verifier.verify(`user${i}@example.test`, 'x', ctx());
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx())).status, 'ok');
    await verifier.verify('user9@example.test', 'x', ctx());
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx())).status, 'locked');
  });

  test('a successful login resets the account counter', async () => {
    const { verifier } = fixture();
    await verifier.verify('plain@example.test', 'x', ctx('198.51.100.1'));
    await verifier.verify('plain@example.test', 'x', ctx('198.51.100.2'));
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx('198.51.100.3'))).status, 'ok');
    await verifier.verify('plain@example.test', 'x', ctx('198.51.100.4'));
    await verifier.verify('plain@example.test', 'x', ctx('198.51.100.5'));
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx('198.51.100.6'))).status, 'ok');
  });

  test('mfa_app_password_required counts as a failure', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 3; i++) await verifier.verify('totp@example.test', 'secret', ctx());
    assert.equal((await verifier.verify('totp@example.test', 'APP2-APP2', ctx())).status, 'locked');
  });

  test('private/loopback IPs are exempt from the per-IP counter by default (not from the account counter)', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 8; i++) await verifier.verify(`user${i}@example.test`, 'x', ctx('127.0.0.1'));
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx('127.0.0.1'))).status, 'ok');
    assert.equal(await verifier.ipLockedFor('127.0.0.1'), 0);
  });

  test('lockouts back off exponentially', async () => {
    let now = 1_000_000;
    const { deps } = fixture();
    const redis = createMemoryAuthRedis(() => now);
    const verifier = createMailCredentialVerifier({ ...deps, redis });
    const lockFor = async (): Promise<number> => {
      // private IP: only the account counter is involved
      for (let i = 0; i < 3; i++) await verifier.verify('plain@example.test', 'x', ctx('10.0.0.1'));
      const r = await verifier.verify('plain@example.test', 'x', ctx('10.0.0.1'));
      assert.equal(r.status, 'locked');
      return r.status === 'locked' ? r.retryAfterSec : 0;
    };
    const first = await lockFor();
    now += (first + 1) * 1000;
    const second = await lockFor();
    assert.equal(first, 30);
    assert.equal(second, 60);
  });

  test('ipLockedFor reports a locked IP (SMTP connect-time check)', async () => {
    const { verifier } = fixture();
    for (let i = 0; i < 5; i++) await verifier.verify(`user${i}@example.test`, 'x', ctx());
    assert.ok((await verifier.ipLockedFor(`::ffff:${PUBLIC_IP}`)) > 0);
  });

  test('Redis errors fail open', async () => {
    const { deps } = fixture();
    const broken: MailAuthRedis = {
      incr: async () => { throw new Error('redis down'); },
      expire: async () => { throw new Error('redis down'); },
      ttl: async () => { throw new Error('redis down'); },
      set: async () => { throw new Error('redis down'); },
      del: async () => { throw new Error('redis down'); },
    };
    const verifier = createMailCredentialVerifier({ ...deps, redis: broken });
    assert.equal((await verifier.verify('plain@example.test', 'secret', ctx())).status, 'ok');
    assert.equal((await verifier.verify('plain@example.test', 'x', ctx())).status, 'invalid');
  });
});

describe('external verifier extension point (LDAP hook)', () => {
  test('is consulted for non-local users without MFA only', async () => {
    const { verifier } = fixture();
    const seen: string[] = [];
    registerExternalPasswordVerifier('test', async (user, password) => { seen.push(user.email); return password === 'dir-pw'; });
    try {
      const ok = await verifier.verify('ldap@example.test', 'dir-pw', ctx());
      assert.ok(ok.status === 'ok' && ok.method === 'external');
      assert.equal((await verifier.verify('plain@example.test', 'dir-pw', ctx())).status, 'invalid');
      assert.deepEqual(seen, ['ldap@example.test']);
    } finally {
      unregisterExternalPasswordVerifier('test');
    }
  });

  test('a throwing verifier yields error', async () => {
    const { verifier } = fixture();
    registerExternalPasswordVerifier('boom', async () => { throw new Error('ldap down'); });
    try {
      assert.equal((await verifier.verify('ldap@example.test', 'pw', ctx())).status, 'error');
    } finally {
      unregisterExternalPasswordVerifier('boom');
    }
  });
});

describe('IP helpers', () => {
  test('isPrivateOrLoopbackIp is CIDR exact', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1'])
      assert.equal(isPrivateOrLoopbackIp(ip), true, ip);
    for (const ip of ['172.15.0.1', '172.32.0.1', '172.200.1.1', '172.2.3.4', '8.8.8.8', '2001:db8::1', 'not-an-ip'])
      assert.equal(isPrivateOrLoopbackIp(ip), false, ip);
  });

  test('clientIpFromRequest honours X-Forwarded-For only behind a local proxy', () => {
    assert.equal(clientIpFromRequest('::ffff:127.0.0.1', '1.1.1.1, 203.0.113.9'), '203.0.113.9');
    assert.equal(clientIpFromRequest('203.0.113.1', '1.1.1.1'), '203.0.113.1');
    assert.equal(clientIpFromRequest('127.0.0.1', undefined), '127.0.0.1');
  });
});

describe('production wiring (verifyMailCredentials)', () => {
  test('uses the __prisma / __mailAuthRedis seams and never throws', async () => {
    const { deps } = fixture();
    (globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined, ...(deps.prisma as object) };
    (globalThis as Record<string, unknown>)['__mailAuthRedis'] = createMemoryAuthRedis();
    const mod = await import('./mail-auth.js');
    mod.configureMailAuth({ verifyPassword: deps.verifyPassword, dummyHash: deps.dummyHash });
    const ok = await mod.verifyMailCredentials('plain@example.test', 'secret', { ip: PUBLIC_IP, protocol: 'smtp' });
    assert.equal(ok.status, 'ok');
    const bad = await mod.verifyMailCredentials('totp@example.test', 'secret', { ip: PUBLIC_IP, protocol: 'smtp' });
    assert.equal(bad.status, 'mfa_app_password_required');
  });
});
