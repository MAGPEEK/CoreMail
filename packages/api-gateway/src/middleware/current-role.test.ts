/**
 * v7.0.1 role changes:
 *  - PUT /admin/mailboxes/:id with a new role revokes all web/API sessions of
 *    the user (refresh tokens deleted, access tokens rejected, event published);
 *  - admin guards verify the CURRENT role from the database when a token
 *    claims admin rights and apply the stricter role — even when the
 *    invalidation event was missed; the short role cache is dropped by the bus.
 * Fake Prisma via globalThis.__prisma, loopback Express app, no Redis.
 * Run: node --import tsx --test --test-force-exit src/middleware/current-role.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const users: Record<string, Row> = {
  org:    { id: 'org', email: 'org@ex.com', displayName: 'Org', role: 'ORGANIZATION_MANAGEMENT', active: true },
  target: { id: 'target', email: 't@ex.com', displayName: 'T', role: 'SERVER_MANAGEMENT', active: true },
  srv:    { id: 'srv', email: 'srv@ex.com', displayName: 'S', role: 'SERVER_MANAGEMENT', active: true },
  gone:   { id: 'gone', email: 'g@ex.com', displayName: 'G', role: 'SERVER_MANAGEMENT', active: false },
};
const sessions: Array<{ id: string; userId: string }> = [
  { id: 'target-web', userId: 'target' }, { id: 'target-cli', userId: 'target' }, { id: 'org-web', userId: 'org' },
];
let roleLookups = 0;
const matchSession = (where: Row) => (s: { id: string; userId: string }) =>
  s.userId === where['userId'] && (!(where['NOT'] as Row | undefined)?.['id'] || s.id !== (where['NOT'] as Row)['id']);

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      if (q.select && Object.keys(q.select).join() === 'role,active') roleLookups++;
      const row = users[String(q.where['id'])];
      return applySelect(row ? { ...row } : null, q.select);
    },
    update: (a) => {
      const q = a as { where: Row; data: Row; select?: Row };
      const row = users[String(q.where['id'])]!;
      Object.assign(row, q.data);
      return applySelect({ ...row }, q.select);
    },
  },
  session: {
    findMany: (a) => sessions.filter(matchSession((a as { where: Row }).where)).map((s) => ({ id: s.id })),
    deleteMany: (a) => {
      const hit = sessions.filter(matchSession((a as { where: Row }).where));
      for (const h of hit) sessions.splice(sessions.indexOf(h), 1);
      return { count: hit.length };
    },
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins: false }) },
});
const kv = new Map<string, string>();
(globalThis as Record<string, unknown>)['__authRedis'] = {
  async get(k: string) { return kv.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('../routes/admin/index.js');
const { requireArea, requireAdmin, requireAuth, clearCurrentRoleCache } = await import('./auth.js');
const rbac = await import('../lib/rbac.js');

const events: Array<{ userId: string; reason: string; revokeBefore?: unknown; sessionIds?: string[] }> = [];
core.onAuthInvalidation((e) => { events.push(e); });

const tok = (sub: string, role: string, sessionId = `${sub}-web`) => core.signAccessToken({
  sub, email: `${sub}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId, mfaVerified: true,
});

const roleOf = (req: unknown): string | undefined => (req as { apiUser?: { role: string } }).apiUser?.role;

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.get('/t/servers', requireArea('servers'), (req, res) => { res.json({ role: roleOf(req) }); });
  app.put('/t/recipients', requireArea('recipients'), (req, res) => { res.json({ role: roleOf(req) }); });
  app.get('/t/admin', requireAdmin, (req, res) => { res.json({ role: roleOf(req) }); });
  app.get('/t/me', requireAuth, (req, res) => { res.json({ role: roleOf(req) }); });
  mountAdminRoutes(app);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('stricterRole picks the less privileged role (lateral → current)', () => {
  assert.equal(rbac.stricterRole('ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'), 'SERVER_MANAGEMENT');
  assert.equal(rbac.stricterRole('HELP_DESK', 'ORGANIZATION_MANAGEMENT'), 'HELP_DESK');
  assert.equal(rbac.stricterRole('SERVER_MANAGEMENT', 'HYGIENE_MANAGEMENT'), 'HYGIENE_MANAGEMENT');
  assert.equal(rbac.stricterRole('SERVER_MANAGEMENT', 'USER'), 'USER');
  assert.equal(rbac.stricterRole('BOGUS', 'SERVER_MANAGEMENT'), 'BOGUS');
});

test('a role change revokes all sessions of the user (refresh + access tokens, event)', async () => {
  const oldToken = tok('target', 'SERVER_MANAGEMENT', 'target-web');
  assert.equal((await call('GET', '/t/me', oldToken)).status, 200);
  events.length = 0;

  const r = await call('PUT', '/api/v1/admin/mailboxes/target', tok('org', 'ORGANIZATION_MANAGEMENT'), { role: 'HYGIENE_MANAGEMENT' });
  assert.equal(r.status, 200);
  assert.deepEqual(sessions.filter((s) => s.userId === 'target'), [], 'refresh-token sessions deleted');
  assert.equal(sessions.filter((s) => s.userId === 'org').length, 1, 'the admin keeps its session');
  const ev = events.find((e) => e.userId === 'target');
  assert.equal(ev?.reason, 'role-change');
  assert.ok(ev?.revokeBefore, 'revoke-all mark published');
  assert.deepEqual([...(ev?.sessionIds ?? [])].sort(), ['target-cli', 'target-web']);

  const after = await call('GET', '/t/me', oldToken);
  assert.equal(after.status, 401);
  assert.equal(after.json['code'], 'SESSION_REVOKED');
});

test('unchanged role / other fields do not revoke sessions', async () => {
  sessions.push({ id: 'srv-web', userId: 'srv' });
  events.length = 0;
  const r = await call('PUT', '/api/v1/admin/mailboxes/srv', tok('org', 'ORGANIZATION_MANAGEMENT'), { role: 'SERVER_MANAGEMENT', displayName: 'S2' });
  assert.equal(r.status, 200);
  assert.ok(sessions.some((s) => s.id === 'srv-web'));
  assert.equal(events.filter((e) => e.userId === 'srv').length, 0);
});

test('admin guard uses the current DB role even without an event (demotion)', async () => {
  clearCurrentRoleCache();
  users['srv']!['role'] = 'SERVER_MANAGEMENT';
  const t = tok('srv', 'SERVER_MANAGEMENT', 'srv-x');
  assert.equal((await call('GET', '/t/servers', t)).status, 200);
  // Demoted directly in the database — no event, cache dropped (as after its TTL).
  users['srv']!['role'] = 'USER';
  clearCurrentRoleCache();
  const r = await call('GET', '/t/servers', t);
  assert.equal(r.status, 403);
  assert.equal(r.json['code'], 'FORBIDDEN_ROLE');
  assert.equal((await call('GET', '/t/admin', t)).status, 403);
  users['srv']!['role'] = 'SERVER_MANAGEMENT';
});

test('the stricter role applies: an ORG token of a now SERVER_MANAGEMENT user', async () => {
  clearCurrentRoleCache();
  const t = tok('srv', 'ORGANIZATION_MANAGEMENT', 'srv-y');
  const ok = await call('GET', '/t/servers', t);
  assert.equal(ok.status, 200);
  assert.equal(ok.json['role'], 'SERVER_MANAGEMENT', 'routes see the stricter role');
  assert.equal((await call('PUT', '/t/recipients', t)).status, 403, 'rights of the old role are gone');
  // A promotion does not widen a token either: token role still has to pass.
  const low = tok('org', 'HELP_DESK', 'org-z');
  assert.equal((await call('GET', '/t/servers', low)).status, 403);
});

test('inactive or deleted accounts are refused (401)', async () => {
  clearCurrentRoleCache();
  const r = await call('GET', '/t/admin', tok('gone', 'SERVER_MANAGEMENT', 'gone-1'));
  assert.equal(r.status, 401);
  assert.equal((await call('GET', '/t/admin', tok('nobody', 'ORGANIZATION_MANAGEMENT', 'n-1'))).status, 401);
});

test('the role cache is short-lived per user and dropped by the auth bus', async () => {
  clearCurrentRoleCache();
  const t = tok('srv', 'SERVER_MANAGEMENT', 'srv-c');
  roleLookups = 0;
  assert.equal((await call('GET', '/t/servers', t)).status, 200);
  assert.equal((await call('GET', '/t/servers', t)).status, 200);
  assert.equal(roleLookups, 1, 'second request served from the cache');
  users['srv']!['role'] = 'USER';
  assert.equal((await call('GET', '/t/servers', t)).status, 200, 'cached within the TTL');
  await core.publishAuthInvalidation({ userId: 'srv', reason: 'role-change' }, { redis: null });
  assert.equal((await call('GET', '/t/servers', t)).status, 403, 'event drops the cached role');
  users['srv']!['role'] = 'SERVER_MANAGEMENT';
});
