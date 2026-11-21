/**
 * ActiveSync Basic auth on the shared mail credential check (v7).
 * Run: node --import tsx --test src/auth.test.ts (in packages/activesync)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const state = { dbDown: false };
const users = [
  { id: 'u1', email: 'bob@example.com', active: true, displayName: 'Bob', domainId: 'd1', role: 'USER',
    passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: null, mailbox: null },
  { id: 'u2', email: 'mfa@example.com', active: true, displayName: 'Mfa', domainId: 'd1', role: 'USER',
    passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: { totpEnabled: false }, webauthnCredentials: [{ kind: 'security_key' }], mailbox: null }, // 10.6: a security key row
];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  ...noProtocolPolicies(),
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
const { requireAuth } = await import('./auth.js');

async function run(login: string, pw: string, ip = '203.0.113.20') {
  const req = {
    headers: { authorization: `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}` },
    socket: { remoteAddress: ip },
  } as unknown as Parameters<typeof requireAuth>[0];
  const out = { status: 0, next: false, headers: {} as Record<string, string>, user: undefined as unknown };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; return res; },
    status: (s: number) => { out.status = s; return res; },
    send: () => res,
  } as unknown as Parameters<typeof requireAuth>[1];
  await requireAuth(req, res, () => { out.next = true; });
  out.user = (req as unknown as { easUser?: unknown }).easUser;
  return out;
}

test('password login of a non-MFA user passes', async () => {
  const out = await run('bob@example.com', 'pw');
  assert.equal(out.next, true);
  // v7.1.0: the credential used (+ check start) travels with the request (Ping termination).
  const { authStartedAt, ...user } = out.user as Record<string, unknown>;
  assert.deepEqual(user, { userId: 'u1', email: 'bob@example.com', credential: 'password' });
  assert.equal(typeof authStartedAt, 'number');
});

test('DOMAIN\\user and bare user names are normalised', async () => {
  assert.equal((await run('CORP\\bob', 'pw')).next, true);
});

test('WebAuthn (MFA) account: primary password 401, app password passes', async () => {
  assert.equal((await run('mfa@example.com', 'pw')).status, 401);
  assert.equal((await run('mfa@example.com', 'APP-PW')).next, true);
});

test('database error → 503 with Retry-After, not 401', async () => {
  state.dbDown = true;
  try {
    const out = await run('bob@example.com', 'pw');
    assert.equal(out.status, 503);
    assert.ok(out.headers['Retry-After']);
  } finally {
    state.dbDown = false;
  }
});

test('account lockout → 429 with Retry-After', async () => {
  for (let i = 0; i < 3; i++) await run('bob@example.com', 'wrong', `198.51.100.${i}`);
  const out = await run('bob@example.com', 'pw', '198.51.100.99');
  assert.equal(out.status, 429);
  assert.ok(Number(out.headers['Retry-After']) > 0);
});

// ── 10.5: known devices (no lockout of the account owner by strangers) ───────

const { easDeviceIdOf } = await import('./auth.js');

test('10.5: easDeviceIdOf reads the DeviceId of the plain and the base64 request line', () => {
  const get = () => undefined;
  assert.equal(easDeviceIdOf({ originalUrl: '/Microsoft-Server-ActiveSync?Cmd=Sync&User=bob&DeviceId=PHONE1&DeviceType=iPhone', url: '', get } as never), 'PHONE1');
  const blob = Buffer.from([141, 0, 0x09, 0x04, 6, ...Buffer.from('PHONE2'), 0, 4, ...Buffer.from('Test')]);
  assert.equal(easDeviceIdOf({ originalUrl: `/Microsoft-Server-ActiveSync?${encodeURIComponent(blob.toString('base64'))}`, url: '', get } as never), 'PHONE2');
  assert.equal(easDeviceIdOf({ originalUrl: '/Microsoft-Server-ActiveSync', url: '', get } as never), undefined);
  assert.equal(easDeviceIdOf({ originalUrl: '/Microsoft-Server-ActiveSync?Cmd=Sync', url: '', get } as never), undefined);
});

test('10.5 review: a known device keeps syncing from its known network while strangers have locked the account — the DeviceId alone is not enough', async () => {
  const runWith = async (pw: string, ip: string, deviceId: string, headers: Record<string, string> = {}) => {
    const req = {
      headers: { authorization: `Basic ${Buffer.from(`mfa@example.com:${pw}`).toString('base64')}`, ...headers },
      socket: { remoteAddress: ip },
      originalUrl: `/Microsoft-Server-ActiveSync?Cmd=Ping&User=mfa&DeviceId=${deviceId}&DeviceType=iPhone`,
      url: '',
      get: () => undefined,
    } as unknown as Parameters<typeof requireAuth>[0];
    const out = { status: 0, next: false };
    const res = {
      setHeader: () => res,
      status: (s: number) => { out.status = s; return res; },
      send: () => res,
    } as unknown as Parameters<typeof requireAuth>[1];
    await requireAuth(req, res, () => { out.next = true; });
    return out;
  };
  // the phone synced before (from the home network)
  assert.equal((await runWith('APP-PW', '192.0.2.10', 'PHONE-MFA')).next, true);
  // strangers lock the account
  for (let i = 0; i < 3; i++) await runWith('guess', `198.51.100.${40 + i}`, 'X');
  assert.equal((await runWith('APP-PW', '198.18.7.7', 'OTHER-DEVICE')).status, 429);
  // the DeviceId is client-chosen: the known id from an unknown network is refused
  assert.equal((await runWith('APP-PW', '198.18.7.8', 'PHONE-MFA')).status, 429);
  // the known phone on its known network still works
  assert.equal((await runWith('APP-PW', '192.0.2.77', 'PHONE-MFA')).next, true);
  // a forwarded address the gateway did not verify never counts as the known network …
  assert.equal((await runWith('APP-PW', '127.0.0.1', 'PHONE-MFA', { 'x-forwarded-for': '192.0.2.78' })).status, 429);
  // … a verified one does
  assert.equal((await runWith('APP-PW', '127.0.0.1', 'PHONE-MFA', { 'x-forwarded-for': '192.0.2.78', 'x-coremail-ip-verified': '1' })).next, true);
});
