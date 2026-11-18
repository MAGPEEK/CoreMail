/**
 * 9.4: admin API of the webmail policies — levels with inherited / effective /
 * sources, validation per level, RBAC like the protocol switches, audit with
 * before/after. Loopback Express app, in-memory Prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/webmail-policies.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
const { createFakePrisma, createFakeRedis, FakeTable } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
db['auditLog'] = new FakeTable(() => ({ createdAt: new Date(), success: true }));
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { policyDiff } = await import('./webmail-policies.js');
const storage = await import('@coremail/storage');

const tokens: Record<string, string> = {};
let server: Server;
let base = '';
before(async () => {
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  for (const [id, role] of [['org', 'ORGANIZATION_MANAGEMENT'], ['srv', 'SERVER_MANAGEMENT'], ['rcp', 'RECIPIENT_MANAGEMENT'],
    ['help', 'HELP_DESK'], ['bob', 'USER']] as const) {
    await db.user.create({ data: { id, email: `${id}@one.test`, role, domainId: 'd1' } });
    tokens[id] = core.signAccessToken({ sub: id, email: `${id}@one.test`, role, domainId: 'd1', sessionId: `s-${id}`, mfaVerified: true });
  }
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  mountAdminRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/webmail-policies`;
});
after(() => server?.close());

async function call(method: string, path: string, as: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[as]}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

test('server level: concrete values with the built-in defaults as source', async () => {
  const r = await call('GET', '', 'srv');
  assert.equal(r.status, 200);
  assert.equal(r.body['level'], 'global');
  assert.deepEqual(r.body['features'], [...storage.WEBMAIL_FEATURES]);
  assert.equal(r.body['settings'].features.calendar, 'on');
  assert.deepEqual(r.body['settings'].content, { blockedExtensions: [], downloadOnlyExtensions: [], maxUploadMb: null, externalImages: 'ask' });
  assert.equal(r.body['sources'].features.calendar, 'default');
  const put = await call('PUT', '', 'srv', { features: { notes: 'off' }, content: { blockedExtensions: ['EXE', 'js'], maxUploadMb: 20 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body['effective'].features.notes, false);
  assert.deepEqual(put.body['effective'].content.blockedExtensions, ['exe', 'js']);
  assert.equal(put.body['sources'].features.notes, 'global');
  assert.equal(put.body['users'], 5);
  assert.equal((await call('PUT', '', 'srv', { features: { notes: 'inherit' } })).status, 400, 'no inherit on the server level');
  assert.equal((await call('PUT', '', 'srv', { content: { externalImages: null } })).status, 400);
});

test('domain and user level: inherit shows the broader value, the most specific wins, upload capped', async () => {
  const d = await call('PUT', '/domains/d1', 'srv', { features: { notes: 'on' }, content: { maxUploadMb: 50 } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body['inherited'].features.notes, false);
  assert.equal(d.body['effective'].features.notes, true);
  assert.equal(d.body['effective'].content.maxUploadMb, 20, 'capped by the server value');
  assert.equal(d.body['sources'].content.maxUploadMb, 'global');
  const u = await call('PUT', '/users/bob', 'rcp', { features: { calendar: 'off' }, content: { externalImages: 'contacts' } });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body['settings'].features.notes, 'inherit');
  assert.equal(u.body['inherited'].features.notes, true, 'from the domain');
  assert.equal(u.body['effective'].features.calendar, false);
  assert.equal(u.body['sources'].features.notes, 'domain');
  assert.equal(u.body['sources'].content.externalImages, 'user');
  assert.equal((await call('GET', '/users/bob', 'help')).status, 200, 'HELP_DESK reads recipients');
  assert.equal((await call('PUT', '/users/bob', 'rcp', { content: { blockedExtensions: null } })).status, 200, 'null = inherit below the server');
  assert.equal((await call('GET', '/users/nobody', 'rcp')).status, 404);
  assert.equal((await call('PUT', '/domains/nope', 'srv', { features: { notes: 'off' } })).status, 404);
});

test('audit: settings.webmail-policy.update with the changed values only', async () => {
  await call('PUT', '/domains/d1', 'srv', { features: { tasks: 'off' }, content: { downloadOnlyExtensions: ['pdf'] } });
  await new Promise((resolve) => setTimeout(resolve, 20)); // audit() is fire-and-forget
  const row = (db['auditLog'] as InstanceType<typeof FakeTable>).rows.at(-1)!;
  assert.equal(row['action'], 'settings.webmail-policy.update');
  assert.equal(row['targetId'], 'd1');
  assert.deepEqual((row['changes'] as Record<string, any>)['values'], {
    tasks: { before: 'inherit', after: 'off' },
    downloadOnlyExtensions: { before: null, after: ['pdf'] },
  });
  const level = storage.inheritAllPolicy();
  assert.deepEqual(policyDiff(level, level), {});
});

test('RBAC and validation', async () => {
  assert.equal((await call('PUT', '/domains/d1', 'rcp', { features: { notes: 'on' } })).status, 403);
  assert.equal((await call('GET', '/domains/d1', 'rcp')).status, 200, 'domain readers see the domain level');
  assert.equal((await call('PUT', '', 'rcp', { features: { notes: 'on' } })).status, 403);
  const admin = await call('PUT', '/users/help', 'rcp', { features: { rules: 'off' } });
  assert.equal(admin.status, 403);
  assert.equal(admin.body['code'], 'FORBIDDEN_ROLE');
  assert.equal((await call('PUT', '/users/help', 'org', { features: { rules: 'off' } })).status, 200);
  assert.equal((await call('GET', '', 'bob')).status, 403);
  assert.equal((await call('PUT', '', 'org', {})).status, 400);
  assert.equal((await call('PUT', '', 'org', { features: { ews: 'off' } })).status, 400);
  assert.equal((await call('PUT', '', 'org', { content: { maxUploadMb: 0 } })).status, 400);
  assert.equal((await call('PUT', '', 'org', { content: { externalImages: 'sometimes' } })).status, 400);
});
