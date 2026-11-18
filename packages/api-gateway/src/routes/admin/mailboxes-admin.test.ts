/**
 * BCP mailbox / shared-mailbox review fixes:
 *  - the last active ORGANIZATION_MANAGEMENT account cannot be demoted, deactivated
 *    or deleted (lock-out), an admin cannot delete their own account;
 *  - a new mailbox / shared mailbox address must belong to the chosen domain and
 *    must not collide with a user, shared mailbox or alias address (409);
 *  - shared-mailbox permissions for unknown users / mailboxes are 404, not a 400;
 *  - shared mailboxes accept quotaBytes 0 (= unlimited, like user mailboxes).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/mailboxes-admin.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let users: Record<string, Row> = {};
let sharedRows: Record<string, Row> = {};
let aliases: Record<string, Row> = {};
const writes: Array<{ op: string; data?: Row; where?: Row }> = [];
const auditRows: Row[] = [];

const domains: Record<string, Row> = { d1: { id: 'd1', name: 'ex.com' }, d2: { id: 'd2', name: 'other.org' } };

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      if (q.where['email'] !== undefined) {
        return applySelect(Object.values(users).find((u) => u['email'] === q.where['email']) ?? null, q.select);
      }
      const id = String(q.where['id']);
      if (id.startsWith('actor-')) return applySelect(users[id] ?? { id, role: id.slice(6), active: true }, q.select);
      return applySelect(users[id] ?? null, q.select);
    },
    count: (a) => {
      const w = (a as { where: { role?: string; active?: boolean; id?: { not: string } } }).where;
      return Object.values(users).filter((u) =>
        (w.role === undefined || u['role'] === w.role)
        && (w.active === undefined || u['active'] === w.active)
        && (w.id?.not === undefined || u['id'] !== w.id.not)).length;
    },
    update: (a) => { const q = a as { where: Row; data: Row }; writes.push({ op: 'user.update', ...q }); return { ...users[String(q.where['id'])], ...q.data }; },
    delete: (a) => { const q = a as { where: Row }; writes.push({ op: 'user.delete', where: q.where }); return {}; },
    create: (a) => { const q = a as { data: Row }; writes.push({ op: 'user.create', data: q.data }); return { id: 'new', ...q.data }; },
    findMany: (a) => { const q = a as { select?: Row }; return Object.values(users).map((u) => applySelect({ displayName: 'x', domainId: 'd1', ...u }, q.select)); },
  },
  domain: { findUnique: (a) => domains[String((a as { where: Row }).where['id'])] ?? null },
  sharedMailbox: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      if (q.where['email'] !== undefined) return Object.values(sharedRows).find((s) => s['email'] === q.where['email']) ?? null;
      return applySelect(sharedRows[String(q.where['id'])] ?? null, q.select);
    },
    create: (a) => { const q = a as { data: Row }; writes.push({ op: 'shared.create', data: q.data }); return { id: 'sm-new', ...q.data, permissions: [] }; },
  },
  emailAlias: { findUnique: (a) => aliases[String((a as { where: Row }).where['address'])] ?? null },
  mailbox: { findUnique: () => ({ id: 'mb1' }), create: () => ({ id: 'mb1' }) },
  folder: { findMany: () => [], createMany: () => ({ count: 0 }) },
  sharedMailboxPerm: { deleteMany: () => ({ count: 0 }), createMany: () => ({ count: 1 }), findMany: () => [] },
  session: { findMany: () => [], deleteMany: () => ({ count: 0 }), updateMany: () => ({ count: 0 }) },
  appPassword: { findMany: () => [], deleteMany: () => ({ count: 0 }) },
  serverSettings: { findUnique: () => ({ id: 'singleton', minPasswordLength: 8, requireMfaForAdmins: false, auditLogEnabled: true }) },
  auditLog: { create: (a) => { auditRows.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminMailboxesRouter } = await import('./mailboxes.js');
const { adminSharedMailboxesRouter } = await import('./shared-mailboxes.js');
const { adminOrganisationRouter } = await import('./organisation.js');

type TokenRole = Parameters<typeof core.signAccessToken>[0]['role'];
const tok = (role: string, sub = `actor-${role}`) => core.signAccessToken({
  sub, email: `${role}@ex.com`, role: role as TokenRole, domainId: 'd1', sessionId: 's', mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
  app.use('/api/v1/admin/shared-mailboxes', adminSharedMailboxesRouter);
  app.use('/api/v1/admin/organisation', adminOrganisationRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  users = {
    'actor-ORGANIZATION_MANAGEMENT': { id: 'actor-ORGANIZATION_MANAGEMENT', email: 'boss@ex.com', role: 'ORGANIZATION_MANAGEMENT', active: true, quotaBytes: 0n },
    u1: { id: 'u1', email: 'bob@ex.com', role: 'USER', active: true, quotaBytes: 0n },
  };
  sharedRows = { sm1: { id: 'sm1', email: 'team@ex.com' } };
  aliases = { 'sales@ex.com': { id: 'a1' } };
  writes.length = 0;
  auditRows.length = 0;
});

async function call(method: string, path: string, body?: unknown, role = 'ORGANIZATION_MANAGEMENT'): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json };
}
const M = '/api/v1/admin/mailboxes';
const S = '/api/v1/admin/shared-mailboxes';
const ORG = 'actor-ORGANIZATION_MANAGEMENT';

test('last ORGANIZATION_MANAGEMENT: demote / deactivate / delete are refused (409)', async () => {
  // the only org admin is the actor itself
  for (const body of [{ role: 'USER' }, { active: false }]) {
    const r = await call('PUT', `${M}/${ORG}`, body);
    assert.deepEqual([r.status, r.json['code']], [409, 'LAST_ORG_ADMIN'], JSON.stringify(body));
  }
  // a second, inactive org admin does not count; deleting it is fine, the guard is about the last ACTIVE one
  users['o2'] = { id: 'o2', email: 'o2@ex.com', role: 'ORGANIZATION_MANAGEMENT', active: false };
  assert.equal((await call('PUT', `${M}/${ORG}`, { role: 'USER' })).status, 409);
  assert.equal(writes.filter((w) => w.op === 'user.update').length, 0);
  // with a second ACTIVE org admin the demotion goes through
  users['o2']!['active'] = true;
  const ok = await call('PUT', `${M}/o2`, { role: 'HELP_DESK' });
  assert.equal(ok.status, 200);
});

test('deleting the last active org admin or the own account is refused', async () => {
  users['o2'] = { id: 'o2', email: 'o2@ex.com', role: 'ORGANIZATION_MANAGEMENT', active: true };
  const self = await call('DELETE', `${M}/${ORG}`);
  assert.deepEqual([self.status, self.json['code']], [409, 'SELF_DELETE']);
  // o2 deletable while the actor stays org admin
  assert.equal((await call('DELETE', `${M}/o2`)).status, 200);
  // last one (actor deactivated in between): deleting o2 would leave none
  users[ORG]!['active'] = false;
  const last = await call('DELETE', `${M}/o2`);
  assert.deepEqual([last.status, last.json['code']], [409, 'LAST_ORG_ADMIN']);
});

test('create mailbox: address must match the domain and be free across users, shared mailboxes and aliases', async () => {
  const base1 = { displayName: 'New', password: 'correct-horse-9', domainId: 'd1' };
  const wrong = await call('POST', M, { ...base1, email: 'new@other.org' });
  assert.equal(wrong.status, 400);
  assert.match(String(wrong.json['error']), /@ex\.com/);
  for (const email of ['Bob@ex.com', 'team@ex.com', 'sales@ex.com']) {
    const r = await call('POST', M, { ...base1, email });
    assert.equal(r.status, 409, email);
  }
  assert.equal(writes.filter((w) => w.op === 'user.create').length, 0);
  const ok = await call('POST', M, { ...base1, email: 'New@EX.com' });
  assert.equal(ok.status, 201);
  assert.equal(writes.find((w) => w.op === 'user.create')!.data!['email'], 'new@ex.com');
});

test('create shared mailbox: domain match, collisions, lower-case, quota 0 = unlimited', async () => {
  assert.equal((await call('POST', S, { email: 'x@other.org', displayName: 'X', domainId: 'd1' })).status, 400);
  assert.equal((await call('POST', S, { email: 'x@ex.com', displayName: 'X', domainId: 'nope' })).status, 404);
  for (const email of ['bob@ex.com', 'team@ex.com', 'sales@ex.com']) {
    assert.equal((await call('POST', S, { email, displayName: 'X', domainId: 'd1' })).status, 409, email);
  }
  const ok = await call('POST', S, { email: 'Help@Ex.com', displayName: ' Help ', domainId: 'd1', quotaBytes: 0 });
  assert.equal(ok.status, 201);
  const data = writes.find((w) => w.op === 'shared.create')!.data!;
  assert.equal(data['email'], 'help@ex.com');
  assert.equal(data['displayName'], 'Help');
  assert.equal(data['quotaBytes'], 0n);
});

test('shared permissions: unknown mailbox / user → 404', async () => {
  assert.equal((await call('POST', `${S}/nope/permissions`, { userId: 'u1', permissions: ['FULL_ACCESS'] })).status, 404);
  assert.equal((await call('POST', `${S}/sm1/permissions`, { userId: 'ghost', permissions: ['FULL_ACCESS'] })).status, 404);
  assert.equal((await call('POST', `${S}/sm1/permissions`, { userId: 'u1', permissions: ['FULL_ACCESS'] })).status, 201);
});

test('a role change writes an always-logged user.role audit entry with the old/new role', async () => {
  const r = await call('PUT', `${M}/u1`, { role: 'HELP_DESK' });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));
  const row = auditRows.find((a) => a['action'] === 'user.role.change');
  assert.ok(row, 'audited');
  assert.equal(row['targetId'], 'u1');
  assert.equal(row['targetName'], 'bob@ex.com');
  assert.match(JSON.stringify(row['changes']), /"before":\{"role":"USER"\}.*"after":\{"role":"HELP_DESK"\}/);
  // no entry when the role is unchanged
  auditRows.length = 0;
  assert.equal((await call('PUT', `${M}/u1`, { role: 'USER', displayName: 'Bob' })).status, 200);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(auditRows.filter((a) => a['action'] === 'user.role.change').length, 0);
  const { ALWAYS_AUDIT } = await import('../../lib/audit.js');
  assert.ok(ALWAYS_AUDIT.test('user.role.change'));
});

test('RBAC page data: role-assignments readable by every organisation-area role, minimal fields', async () => {
  for (const role of ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG']) {
    const r = await call('GET', '/api/v1/admin/organisation/role-assignments', undefined, role);
    assert.equal(r.status, 200, role);
    const rows = r.json as unknown as Row[];
    assert.ok(Array.isArray(rows) && rows.length > 0, role);
    // 9.5: + the management scope of the account
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['active', 'displayName', 'domainId', 'email', 'id', 'role', 'scope']);
  }
  for (const role of ['RECIPIENT_MANAGEMENT', 'HELP_DESK', 'USER']) {
    assert.equal((await call('GET', '/api/v1/admin/organisation/role-assignments', undefined, role)).status, 403, role);
  }
});
