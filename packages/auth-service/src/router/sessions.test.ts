/**
 * 9.4 /auth/sessions (webmail Settings → Sicherheit): the list marks the calling
 * session, another session can be ended (its access token is refused at once),
 * revoke-others keeps only the calling session, other users' sessions are 404.
 * Run: node --import tsx --test src/router/sessions.test.ts  (in packages/auth-service)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();

const core = await import('@coremail/core');
const { createApp } = await import('../app.js');

const PW = 'correct horse battery';
let server: Server;
let base = '';

before(async () => {
  await db.serverSettings.create({ data: { id: 'singleton', publicHostname: 'mail.example.org' } });
  await db.user.create({ data: { email: 'dora@example.com', passwordHash: await core.hashPassword(PW) } });
  await db.user.create({ data: { email: 'emil@example.com', passwordHash: await core.hashPassword(PW) } });
  await new Promise<void>((resolve) => { server = createApp().listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as unknown };
}

async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', { email, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return String((r.body as Record<string, unknown>)['accessToken']);
}

type SessionRow = { id: string; current: boolean; ipAddress: string };

test('sessions: list marks the current session; another one can be ended', async () => {
  const t1 = await login('dora@example.com');
  const t2 = await login('dora@example.com');
  const list = await call('GET', '/auth/sessions', undefined, t1);
  assert.equal(list.status, 200);
  const rows = list.body as SessionRow[];
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((s) => s.current).length, 1);
  const other = rows.find((s) => !s.current)!;
  assert.equal((await call('DELETE', `/auth/sessions/${other.id}`, undefined, t1)).status, 200);
  assert.equal((await call('GET', '/auth/sessions', undefined, t2)).status, 401, 'token of the ended session still accepted');
  assert.equal(((await call('GET', '/auth/sessions', undefined, t1)).body as SessionRow[]).length, 1);
});

test('sessions: revoke-others keeps only the calling session', async () => {
  const keep = await login('emil@example.com');
  const gone = await login('emil@example.com');
  await login('emil@example.com');
  const r = await call('POST', '/auth/sessions/revoke-others', {}, keep);
  assert.equal(r.status, 200);
  assert.equal((r.body as Record<string, unknown>)['revoked'], 2);
  const rows = (await call('GET', '/auth/sessions', undefined, keep)).body as SessionRow[];
  assert.deepEqual(rows.map((s) => s.current), [true]);
  assert.equal((await call('GET', '/auth/sessions', undefined, gone)).status, 401);
});

test('sessions: another user\'s session is not found; no token → 401', async () => {
  const dora = await login('dora@example.com');
  const emilRows = (await call('GET', '/auth/sessions', undefined, await login('emil@example.com'))).body as SessionRow[];
  assert.equal((await call('DELETE', `/auth/sessions/${emilRows[0]!.id}`, undefined, dora)).status, 404);
  assert.equal((await call('GET', '/auth/sessions')).status, 401);
  assert.equal((await call('POST', '/auth/sessions/revoke-others', {})).status, 401);
});
