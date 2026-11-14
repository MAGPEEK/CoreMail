import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['AUTH_SERVICE_URL'];

const users: Record<string, { id: string; email: string; active: boolean }> = {
  alice: { id: 'alice', email: 'alice@example.com', active: true },
  gone: { id: 'gone', email: 'gone@example.com', active: false },
};

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: { findUnique: async (args: { where: { id: string } }) => users[args.where.id] ?? null },
};

const { signAccessToken, signRefreshToken } = await import('@coremail/core');
const { davAuthMiddleware } = await import('./auth.js');

type Outcome = { nextCalled: boolean; status: number | null; davUser: unknown };

async function run(authorization: string | undefined): Promise<Outcome> {
  const req = {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  } as unknown as Parameters<typeof davAuthMiddleware>[0];
  const outcome: Outcome = { nextCalled: false, status: null, davUser: undefined };
  const res = {
    set: () => res,
    status: (code: number) => { outcome.status = code; return res; },
    send: () => res,
  } as unknown as Parameters<typeof davAuthMiddleware>[1];
  await davAuthMiddleware(req, res, () => { outcome.nextCalled = true; });
  outcome.davUser = (req as unknown as { davUser?: unknown }).davUser;
  return outcome;
}

const accessFor = (id: string) => signAccessToken({
  sub: id, email: `${id}@example.com`, role: 'USER',
  domainId: 'domain-1', sessionId: 'session-1', mfaVerified: false,
});

let fetchCalls: string[] = [];
let fetchToken: string | undefined;
beforeEach(() => {
  fetchCalls = [];
  fetchToken = undefined;
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return { ok: fetchToken !== undefined, json: async () => ({ accessToken: fetchToken }) } as Response;
  }) as typeof fetch;
});

test('a garbage bearer token is answered with 401 instead of crashing', async () => {
  const out = await run('Bearer x');
  assert.equal(out.status, 401);
  assert.equal(out.nextCalled, false);
});

test('a valid bearer token of an active user passes', async () => {
  const out = await run(`Bearer ${accessFor('alice')}`);
  assert.equal(out.nextCalled, true);
  assert.deepEqual(out.davUser, { userId: 'alice', email: 'alice@example.com' });
});

test('a refresh token is not accepted as bearer token', async () => {
  const out = await run(`Bearer ${signRefreshToken('alice', 'session-1')}`);
  assert.equal(out.status, 401);
});

test('a bearer token of a deactivated user is rejected', async () => {
  assert.equal((await run(`Bearer ${accessFor('gone')}`)).status, 401);
});

test('Basic auth calls the auth-service on localhost by default', async () => {
  fetchToken = accessFor('alice');
  const out = await run(`Basic ${Buffer.from('alice@example.com:pw').toString('base64')}`);
  assert.deepEqual(fetchCalls, ['http://localhost:3003/auth/login']);
  assert.equal(out.nextCalled, true);
});

test('Basic auth rejects a deactivated user even with a valid login token', async () => {
  fetchToken = accessFor('gone');
  const out = await run(`Basic ${Buffer.from('gone@example.com:pw').toString('base64')}`);
  assert.equal(out.status, 401);
});

test('Basic auth with wrong credentials is answered with 401', async () => {
  const out = await run(`Basic ${Buffer.from('alice@example.com:wrong').toString('base64')}`);
  assert.equal(out.status, 401);
});
