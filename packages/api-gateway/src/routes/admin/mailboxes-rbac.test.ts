/**
 * 8.1 review fixes, admin mailbox routers:
 *  - HELP_DESK against EVERY route of the mailbox router: GET (read) and the
 *    narrow extras PUT /:id + POST /:id/revoke-sessions only — never the fixed
 *    paths (PUT /quota-defaults used to match the `PUT /:id` pattern);
 *  - PUT /quota-defaults: recipients write only, audited;
 *  - shared-mailbox router: HELP_DESK read only;
 *  - partial quota-level PUTs are validated against the stored levels
 *    (mailboxes and shared mailboxes).
 * Fake Prisma via globalThis.__prisma, loopback Express app.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/mailboxes-rbac.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const MB = 1024 * 1024;
const settings: Row = { id: 'singleton', quotaWarningPercent: 80, quotaProhibitSendPercent: 90, requireMfaForAdmins: false };
let settingsWrites = 0;
const auditRows: Row[] = [];
const users: Record<string, Row> = {
  u1: {
    id: 'u1', email: 'bob@ex.com', displayName: 'Bob', role: 'USER', active: true,
    quotaBytes: BigInt(100 * MB), quotaWarningBytes: null, quotaProhibitSendBytes: BigInt(50 * MB),
  },
};
const shared: Row = { id: 'sm1', email: 'team@ex.com', quotaBytes: BigInt(100 * MB), quotaWarningBytes: null, quotaProhibitSendBytes: BigInt(50 * MB) };
const sharedUpdates: Row[] = [];

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      if (id.startsWith('actor-')) return applySelect({ id, role: id.slice(6), active: true }, q.select);
      return applySelect(users[id] ?? null, q.select);
    },
    update: (a) => { const q = a as { where: Row; data: Row }; return { ...users[String(q.where['id'])], ...q.data }; },
    findMany: () => [],
  },
  serverSettings: {
    findUnique: () => ({ ...settings }),
    upsert: (a) => { settingsWrites++; Object.assign(settings, (a as { update: Row }).update); return { ...settings }; },
  },
  sharedMailbox: {
    findUnique: (a) => { const q = a as { where: Row; select?: Row }; return q.where['id'] === 'sm1' ? applySelect(shared, q.select) : null; },
    update: (a) => { const q = a as { data: Row }; sharedUpdates.push(q.data); return { ...shared, ...q.data }; },
  },
  auditLog: { create: (a) => { auditRows.push((a as { data: Row }).data); return {}; } },
  // 10.6: the admin MFA rule reads the factors through getAuthFactors (userMfa + webAuthnCredential)
  userMfa: { findUnique: () => ({ totpEnabled: true, backupCodes: [] }) },
  webAuthnCredential: { findMany: () => [] },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminMailboxesRouter, isHelpDeskReset, RESERVED_MAILBOX_PATHS } = await import('./mailboxes.js');
const { adminSharedMailboxesRouter } = await import('./shared-mailboxes.js');
const { quotaLevelPatchError } = await import('../../lib/quota-levels.js');

type TokenRole = Parameters<typeof core.signAccessToken>[0]['role'];
const tok = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `${role}@ex.com`, role: role as TokenRole, domainId: 'd1', sessionId: 's', mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
  app.use('/api/v1/admin/shared-mailboxes', adminSharedMailboxesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { settings['quotaWarningPercent'] = 80; settings['quotaProhibitSendPercent'] = 90; settingsWrites = 0; auditRows.length = 0; });

async function call(method: string, path: string, role: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` },
    ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

interface Layer { route?: { path: string; methods: Record<string, boolean> } }
function routesOf(router: unknown): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as { stack: Layer[] }).stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path });
  }
  return out;
}
const concrete = (p: string): string => p.replace(':granteeId', 'g1').replace(':userId', 'u2').replace(':permission', 'SEND_AS').replace(':id', 'u1');

test('HELP_DESK on every mailbox route: read + PUT /:id + POST /:id/revoke-sessions only', async () => {
  const routes = routesOf(adminMailboxesRouter);
  assert.ok(routes.length >= 15, 'all routes enumerated');
  const allowed = (m: string, p: string): boolean => m === 'GET' || (m === 'PUT' && p === '/:id') || (m === 'POST' && p === '/:id/revoke-sessions');
  for (const { method, path } of routes) {
    const body = method === 'PUT' && path === '/:id' ? { active: true } : {};
    const r = await call(method, `/api/v1/admin/mailboxes${concrete(path)}`, 'HELP_DESK', body);
    if (allowed(method, path)) assert.notEqual(r.json['code'], 'FORBIDDEN_ROLE', `${method} ${path} must be allowed (got ${r.status})`);
    else assert.deepEqual([r.status, r.json['code']], [403, 'FORBIDDEN_ROLE'], `${method} ${path} must be refused for HELP_DESK`);
  }
  // reserved paths are never treated as ids, whatever the spelling
  for (const p of RESERVED_MAILBOX_PATHS) {
    for (const v of [p, `${p}/`, p.toUpperCase(), encodeURIComponent(p).replace('-', '%2D')]) {
      assert.equal(isHelpDeskReset('HELP_DESK', { method: 'PUT', path: `/${v}` } as never), false, v);
    }
  }
  assert.equal(isHelpDeskReset('HELP_DESK', { method: 'PUT', path: '/u1' } as never), true);
  assert.equal(isHelpDeskReset('HELP_DESK', { method: 'POST', path: '/u1/revoke-sessions' } as never), true);
});

test('PUT /quota-defaults: HELP_DESK and VIEW_ONLY_ORG refused, RECIPIENT_MANAGEMENT audited', async () => {
  for (const role of ['HELP_DESK', 'VIEW_ONLY_ORG', 'SERVER_MANAGEMENT']) {
    const r = await call('PUT', '/api/v1/admin/mailboxes/quota-defaults', role, { quotaWarningPercent: 1, quotaProhibitSendPercent: 1 });
    assert.equal(r.status, 403, role);
  }
  assert.equal(settingsWrites, 0, 'settings untouched');
  assert.equal(settings['quotaProhibitSendPercent'], 90);
  const ok = await call('PUT', '/api/v1/admin/mailboxes/quota-defaults', 'RECIPIENT_MANAGEMENT', { quotaProhibitSendPercent: 95 });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const row = auditRows.find((a) => a['action'] === 'mailbox.quota-defaults.update');
  assert.ok(row, 'audited');
  assert.match(JSON.stringify(row['changes']), /"before":\{"quotaWarningPercent":80,"quotaProhibitSendPercent":90\}/);
});

test('HELP_DESK on the shared-mailbox router: read only', async () => {
  for (const { method, path } of routesOf(adminSharedMailboxesRouter)) {
    const r = await call(method, `/api/v1/admin/shared-mailboxes${concrete(path)}`, 'HELP_DESK', {});
    if (method === 'GET') assert.notEqual(r.status, 403, `${method} ${path}`);
    else assert.equal(r.status, 403, `${method} ${path}`);
  }
});

test('partial quota-level PUTs are validated against the stored values', async () => {
  // pure helper
  assert.equal(quotaLevelPatchError({ quotaWarningBytes: 60 }, { quotaBytes: 100n, quotaWarningBytes: null, quotaProhibitSendBytes: 50n }),
    'quotaWarningBytes must not exceed quotaProhibitSendBytes');
  assert.equal(quotaLevelPatchError({ quotaBytes: 40 }, { quotaBytes: 100n, quotaWarningBytes: null, quotaProhibitSendBytes: 50n }),
    'quotaProhibitSendBytes must not exceed quotaBytes');
  assert.equal(quotaLevelPatchError({ quotaProhibitSendBytes: null, quotaWarningBytes: 60 }, { quotaBytes: 100n, quotaWarningBytes: null, quotaProhibitSendBytes: 50n }), null);
  assert.equal(quotaLevelPatchError({}, { quotaBytes: 10n, quotaWarningBytes: 50n, quotaProhibitSendBytes: 20n }), null, 'no quota field → no check');
  // user mailbox: stored prohibit-send 50 MB
  const t = 'RECIPIENT_MANAGEMENT';
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/u1', t, { quotaWarningBytes: 60 * MB })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/u1', t, { quotaBytes: 40 * MB })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/u1', t, { quotaWarningBytes: 40 * MB })).status, 200);
  // shared mailbox: same rules
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/sm1', t, { quotaWarningBytes: 60 * MB })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/sm1', t, { quotaBytes: 40 * MB })).status, 400);
  assert.equal(sharedUpdates.length, 0);
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/sm1', t, { quotaWarningBytes: 40 * MB })).status, 200);
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/missing', t, { quotaWarningBytes: 1 })).status, 404);
});
