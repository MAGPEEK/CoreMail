/**
 * Regression (e2e 7.0.0): /auth/app-passwords accepted the access token of a
 * logged-out session (only the JWT signature was checked) — a stolen access
 * token could mint a persistent app password after the victim logged out.
 * Run: node --import tsx --test src/router/app-passwords.test.ts  (in packages/auth-service)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

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
  await db.user.create({ data: { email: 'bob@example.com', passwordHash: await core.hashPassword(PW) } });
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
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

test('app passwords: live session may create; after logout the access token is refused', async () => {
  const login = await call('POST', '/auth/login', { email: 'bob@example.com', password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = String(login.body['accessToken']);
  assert.equal((await call('POST', '/auth/app-passwords', { name: 'phone' }, token)).status, 201);

  assert.equal((await call('POST', '/auth/logout', { refreshToken: login.body['refreshToken'] })).status, 200);
  assert.equal((await call('POST', '/auth/app-passwords', { name: 'attacker' }, token)).status, 401);
  assert.equal((await call('GET', '/auth/app-passwords', undefined, token)).status, 401);
  assert.equal(db.appPassword.rows.length, 1);
});
