/**
 * 9.1: every change of a mailbox permission publishes `permission-change` on the
 * auth invalidation bus for each affected grantee — Shared Mailbox permission
 * set / remove (all or one), the shared mailbox `active` flag and deletion (all
 * grantees), delegation grant / revoke. Loopback Express app, Prisma faked via
 * globalThis.__prisma, local bus handlers observed with onAuthInvalidation().
 * Run: node --import tsx --test --test-force-exit src/routes/admin/permission-events.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const grants = [
  { sharedMailboxId: 'sm1', userId: 'g1', permission: 'FULL_ACCESS' },
  { sharedMailboxId: 'sm1', userId: 'g2', permission: 'READ_ONLY' },
  { sharedMailboxId: 'sm1', userId: 'g2', permission: 'SEND_AS' },
];
installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      const row = id.startsWith('actor-') ? { id, email: `${id}@ex.com`, role: id.slice(6), active: true }
        : { id, email: `${id}@ex.com`, role: 'USER', active: true };
      return applySelect(row, q.select);
    },
  },
  sharedMailbox: {
    findUnique: () => ({ quotaBytes: 100n, quotaWarningBytes: null, quotaProhibitSendBytes: null }),
    update: (a) => ({ id: 'sm1', ...(a as { data: Row }).data }),
    delete: () => ({}),
  },
  sharedMailboxPerm: {
    findMany: (a) => {
      const w = (a as { where: Row }).where;
      return grants.filter((g) => g.sharedMailboxId === w['sharedMailboxId'] && (w['userId'] === undefined || g.userId === w['userId']));
    },
    deleteMany: () => ({ count: 1 }),
    createMany: () => ({ count: 1 }),
    delete: () => ({}),
  },
  mailbox: { findUnique: () => ({ id: 'mb-owner' }) },
  mailboxDelegate: {
    upsert: (a) => ({ id: 'del1', ...(a as { create: Row }).create }),
    deleteMany: () => ({ count: 1 }),
  },
  auditLog: { create: () => ({}) },
});
// $transaction with an array of (already resolved) promises
const g = globalThis as Record<string, unknown>;
(g['__prisma'] as Row)['$transaction'] = async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(g['__prisma']));

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');

const events: Array<{ userId: string; reason: string }> = [];
core.onAuthInvalidation((e) => events.push({ userId: e.userId, reason: String(e.reason) }));
const permissionEvents = () => events.filter((e) => e.reason === 'permission-change').map((e) => e.userId).sort();

const tok = core.signAccessToken({ sub: 'actor-ORGANIZATION_MANAGEMENT', email: 'org@ex.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  mountAdminRoutes(app);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { events.length = 0; });

async function call(method: string, path: string, body?: unknown): Promise<number> {
  const r = await fetch(`${base}/api/v1/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await r.text();
  return r.status;
}

test('shared mailbox permission set / remove-all / remove-one → permission-change for that grantee', async () => {
  assert.equal(await call('POST', '/shared-mailboxes/sm1/permissions', { userId: 'g3', permissions: ['READ_ONLY'] }), 201);
  assert.deepEqual(permissionEvents(), ['g3']);
  events.length = 0;
  assert.equal(await call('DELETE', '/shared-mailboxes/sm1/permissions/g1'), 204);
  assert.deepEqual(permissionEvents(), ['g1']);
  events.length = 0;
  assert.equal(await call('DELETE', '/shared-mailboxes/sm1/permissions/g2/READ_ONLY'), 204);
  assert.deepEqual(permissionEvents(), ['g2']);
});

test('shared mailbox active flag and deletion → every grantee (once each); other updates publish nothing', async () => {
  assert.equal(await call('PUT', '/shared-mailboxes/sm1', { active: false }), 200);
  assert.deepEqual(permissionEvents(), ['g1', 'g2']);
  events.length = 0;
  assert.equal(await call('PUT', '/shared-mailboxes/sm1', { displayName: 'Team' }), 200);
  assert.deepEqual(permissionEvents(), []);
  assert.equal(await call('DELETE', '/shared-mailboxes/sm1'), 204);
  assert.deepEqual(permissionEvents(), ['g1', 'g2']);
});

test('delegation grant / revoke → permission-change for the grantee', async () => {
  assert.equal(await call('POST', '/mailboxes/owner1/delegates', { granteeId: 'g5', permission: 'READ_ONLY' }), 201);
  assert.deepEqual(permissionEvents(), ['g5']);
  events.length = 0;
  assert.equal(await call('DELETE', '/mailboxes/owner1/delegates/g5'), 200);
  assert.deepEqual(permissionEvents(), ['g5']);
});

test('9.4 review: a grant change (incl. autoMap) reaches the grantee webmail live (settings / mailboxes event)', async () => {
  const sent: Array<{ channel: string; message: string }> = [];
  const g2 = globalThis as { __realtimeRedis?: unknown };
  const previous = g2.__realtimeRedis;
  g2.__realtimeRedis = { publish: async (channel: string, message: string) => { sent.push({ channel, message }); return 1; } };
  try {
    const grantee = (userId: string) => sent.filter((s) => s.channel === core.userEventsChannel(userId)).map((s) => JSON.parse(s.message) as Row);
    assert.equal(await call('POST', '/mailboxes/owner1/delegates', { granteeId: 'g7', permission: 'FULL_ACCESS', autoMap: false }), 201);
    assert.equal(await call('POST', '/shared-mailboxes/sm1/permissions', { userId: 'g8', permissions: ['FULL_ACCESS'], autoMap: false }), 201);
    assert.equal(await call('DELETE', '/shared-mailboxes/sm1/permissions/g1'), 204);
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ['g7', 'g8', 'g1']) {
      assert.deepEqual(grantee(id), [{ type: 'settings', section: 'mailboxes', action: 'update' }], id);
    }
  } finally {
    g2.__realtimeRedis = previous;
  }
});

test('permission-change ends no live connection (neutral reason)', () => {
  const conn = { userId: 'g1', credential: 'app_password' as const, appPasswordId: 'a1', terminate: () => undefined };
  assert.equal(core.connectionAffected({ userId: 'g1', reason: 'permission-change' }, conn), false);
});
