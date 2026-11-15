/**
 * Autodiscover v1 Basic auth on the shared mail credential check (v7):
 * 401 for invalid / MFA primary password, 503 on database errors, and no
 * derivative of the submitted password in the SystemLog.
 * Run: node --import tsx --test src/v1-auth.test.ts (in packages/autodiscover)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const state = { dbDown: false };
const systemLogs: unknown[] = [];
const users = [
  { id: 'u2', email: 'mfa@example.com', active: true, displayName: 'Mfa', domainId: 'd1', role: 'USER',
    passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: { totpEnabled: true, webAuthnCredentials: [] }, mailbox: null },
];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => {
      if (state.dbDown) throw new Error('db down');
      return users.find((u) => u.email === where.email) ?? null;
    },
  },
  appPassword: { findMany: async () => [], update: async () => ({}) },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
  systemLog: { create: async (args: unknown) => { systemLogs.push(args); return {}; } },
};
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
});
const { handleAutodiscoverV1 } = await import('./v1.js');

async function run(login: string, pw: string) {
  const req = {
    method: 'GET',
    originalUrl: '/Autodiscover/Autodiscover.xml',
    query: {},
    headers: {},
    socket: { remoteAddress: '203.0.113.30' },
    ip: '203.0.113.30',
    get: (h: string) => (h.toLowerCase() === 'authorization' ? `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}` : undefined),
  } as unknown as Parameters<typeof handleAutodiscoverV1>[0];
  const out = { status: 0 };
  const res = {
    set: () => res,
    status: (s: number) => { out.status = s; return res; },
    send: () => res,
    type: () => res,
  } as unknown as Parameters<typeof handleAutodiscoverV1>[1];
  await handleAutodiscoverV1(req, res);
  return out;
}

test('MFA account with the primary password → 401, no password derivative is logged', async () => {
  const secret = 'pw';
  assert.equal((await run('mfa@example.com', secret)).status, 401);
  await new Promise((r) => setImmediate(r));
  const logged = JSON.stringify(systemLogs);
  assert.ok(systemLogs.length > 0);
  assert.doesNotMatch(logged, /pwLen|pwCodes|codes=/);
});

test('8.0.0: failed logins write a bounded number of SystemLog rows (pino logs every attempt)', async () => {
  systemLogs.length = 0;
  for (let i = 0; i < 40; i++) {
    assert.equal((await run(`nobody${i}@example.com`, 'x')).status, 401);
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(systemLogs.length <= 10, `at most 10 rows per IP and minute, got ${systemLogs.length}`);
});

test('LogBudget: per-key and total limits, window reset, suppressed count reported', async () => {
  const { LogBudget } = await import('./log-budget.js');
  let now = 0;
  const b = new LogBudget({ perKey: 2, total: 3, windowMs: 1000, now: () => now });
  assert.deepEqual(b.take('a'), { ok: true, suppressedBefore: 0 });
  assert.deepEqual(b.take('a'), { ok: true, suppressedBefore: 0 });
  assert.deepEqual(b.take('a'), { ok: false });
  assert.deepEqual(b.take('b'), { ok: true, suppressedBefore: 1 });
  assert.deepEqual(b.take('c'), { ok: false }, 'total budget used up');
  now = 1000;
  assert.deepEqual(b.take('a'), { ok: true, suppressedBefore: 1 });
});

test('unknown user → 401', async () => {
  assert.equal((await run('nobody@example.com', 'x')).status, 401);
});

test('database error → 503, not 401', async () => {
  state.dbDown = true;
  try {
    assert.equal((await run('mfa@example.com', 'pw')).status, 503);
  } finally {
    state.dbDown = false;
  }
});
