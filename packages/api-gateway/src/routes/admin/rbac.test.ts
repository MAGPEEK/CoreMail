/**
 * v6 admin RBAC: role → area matrix, 403 sweep over EVERY /api/v1/admin/*
 * route for a USER token (router stack enumeration), area separation,
 * privilege-escalation guards, secret stripping and crash-safety of known
 * crash paths. Prisma faked via globalThis.__prisma, loopback Express app.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/rbac.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const users: Record<string, Row> = {
  u_user:  { id: 'u_user',  email: 'user@ex.com',  displayName: 'U', role: 'USER', active: true, passwordHash: '$2b$SECRET', quotaBytes: 1n, usedBytes: 0n, domainId: 'd1' },
  u_admin: { id: 'u_admin', email: 'adm@ex.com',   displayName: 'A', role: 'SERVER_MANAGEMENT', active: true, passwordHash: '$2b$SECRET2', quotaBytes: 1n, usedBytes: 0n, domainId: 'd1' },
};
const updates: Row[] = [];
let ldapStored: Row | null = { domainId: 'd1', host: 'ldap', port: 636, ssl: true, baseDN: 'dc=x', bindDN: 'cn=a', bindPassword: 'LDAP-SECRET', userDN: 'ou=u', userFilter: 'f', groupFilter: null, attributeMap: {}, syncEnabled: true, lastSyncAt: null, createdAt: new Date() };
const settingsRow = { id: 'singleton', publicHostname: 'mail.ex.com', tlsCert: 'CERT', tlsKey: '-----BEGIN PRIVATE KEY-----', setupTokenHash: 'abc', orgName: 'X',
  useHttps: true, httpPort: 443, owaUrl: 'https://mail.ex.com/owa/', easUrl: 'https://mail.ex.com/Microsoft-Server-ActiveSync',
  autodiscoverBase: 'https://autodiscover.ex.com', imapHost: 'mail.ex.com', imapPort: 993, imapSsl: true, pop3Host: 'mail.ex.com', pop3Port: 995, pop3Ssl: true,
  smtpHost: 'mail.ex.com', smtpPort: 587, smtpTls: true, jmapEnabled: true, requireMfaForAdmins: false };
const settingsPuts: Row[] = [];

installFakePrisma({
  user: {
    // Token actors ("actor-<ROLE>") exist with that role — v7.0.1 admin guards check the current role.
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      const row = users[id] ?? (id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null);
      return applySelect(row, q.select);
    },
    update: (a) => { const q = a as { where: Row; data: Row; select?: Row }; updates.push(q.data); return applySelect({ ...users[String(q.where['id'])], ...q.data }, q.select); },
    delete: () => ({}),
    findMany: () => [],
  },
  serverSettings: {
    upsert: (a) => { const q = a as { update: Row }; if (Object.keys(q.update).length) settingsPuts.push(q.update); return { ...settingsRow, ...q.update }; },
    findUnique: () => ({ ...settingsRow }),
  },
  ldapConfig: {
    findUnique: (a) => { const q = a as { include?: Row }; return ldapStored ? { ...ldapStored, ...(q.include ? { domain: { id: 'd1', name: 'ex.com' } } : {}) } : null; },
    upsert: (a) => { const q = a as { update: Row }; ldapStored = { ...ldapStored, ...q.update }; return ldapStored; },
    // v6.1 LDAP route: findUnique + update/create instead of upsert
    update: (a) => { const q = a as { data: Row }; ldapStored = { ...ldapStored, ...q.data }; return ldapStored; },
    create: (a) => { const q = a as { data: Row }; ldapStored = { ...q.data }; return ldapStored; },
  },
  domain: {
    findUnique: (a) => { const q = a as { where: Row }; if (q.where['id'] === 'd1') return { id: 'd1', name: 'ex.com', primary: true }; if (q.where['id'] === 'd2') return { id: 'd2', name: 'other.com', primary: false }; if (q.where['name'] === 'taken.com') return { id: 'd9' }; return null; },
    update: () => { throw Object.assign(new Error('should not be reached'), { code: 'P2002', clientVersion: '5', name: 'PrismaClientKnownRequestError' }); },
    delete: () => { throw Object.assign(new Error('FK violation domains_shared_mailboxes'), { code: 'P2003', clientVersion: '5', name: 'PrismaClientKnownRequestError' }); },
  },
  sharedMailbox: { count: () => 1 },
  mailbox: { findUnique: () => ({ id: 'mb1' }) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { ADMIN_MOUNTS, ADMIN_PREFIX, PUBLIC_ADMIN_ROUTES, mountAdminRoutes } = await import('./index.js');
const rbac = await import('../../lib/rbac.js');
const { userRouter } = await import('../user.js');

const tok = (role: string, sub = `actor-${role}`) => core.signAccessToken({ sub, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'], domainId: 'd1', sessionId: 's', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/user', userRouter);
  mountAdminRoutes(app);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, role?: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role) headers['authorization'] = `Bearer ${tok(role)}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

// ── Matrix ────────────────────────────────────────────────────────────────────

test('role → area matrix', () => {
  const { canAccess, allowedAreas, ADMIN_AREAS } = rbac;
  for (const area of ADMIN_AREAS) {
    assert.equal(canAccess('ORGANIZATION_MANAGEMENT', area, 'DELETE'), true, area);
    assert.equal(canAccess('USER', area, 'GET'), false, area);
    assert.equal(canAccess('ADMIN', area, 'GET'), false, `non-existent role ADMIN on ${area}`);
    assert.equal(canAccess('VIEW_ONLY_ORG', area, 'POST'), false, area);
  }
  assert.equal(canAccess('SERVER_MANAGEMENT', 'servers', 'PUT'), true);
  assert.equal(canAccess('SERVER_MANAGEMENT', 'recipients', 'GET'), false);
  assert.equal(canAccess('RECIPIENT_MANAGEMENT', 'recipients', 'POST'), true);
  assert.equal(canAccess('RECIPIENT_MANAGEMENT', 'domains', 'GET'), true);
  assert.equal(canAccess('RECIPIENT_MANAGEMENT', 'domains', 'POST'), false);
  assert.equal(canAccess('HYGIENE_MANAGEMENT', 'hygiene', 'PUT'), true);
  assert.equal(canAccess('HYGIENE_MANAGEMENT', 'servers', 'GET'), false);
  assert.equal(canAccess('COMPLIANCE_MANAGEMENT', 'compliance', 'POST'), true);
  assert.equal(canAccess('VIEW_ONLY_ORG', 'compliance', 'GET'), false);
  assert.equal(canAccess('HELP_DESK', 'recipients', 'GET'), true);
  assert.equal(canAccess('HELP_DESK', 'recipients', 'PUT'), false);
  assert.equal(canAccess('VIEW_ONLY_ORG', 'servers', 'GET'), true);
  assert.deepEqual(allowedAreas('USER'), {});
  assert.deepEqual(allowedAreas('HELP_DESK'), { dashboard: 'read', recipients: 'read' });
});

test('escalation helpers', () => {
  assert.equal(rbac.canAssignRole('RECIPIENT_MANAGEMENT', 'USER'), true);
  assert.equal(rbac.canAssignRole('RECIPIENT_MANAGEMENT', 'HELP_DESK'), false);
  assert.equal(rbac.canAssignRole('RECIPIENT_MANAGEMENT', 'USER', 'USER'), true);
  assert.equal(rbac.canAssignRole('RECIPIENT_MANAGEMENT', 'ORGANIZATION_MANAGEMENT', 'USER'), false);
  assert.equal(rbac.canAssignRole('ORGANIZATION_MANAGEMENT', 'ORGANIZATION_MANAGEMENT', 'USER'), true);
  assert.equal(rbac.canManageAccount('HELP_DESK', 'USER'), true);
  assert.equal(rbac.canManageAccount('HELP_DESK', 'SERVER_MANAGEMENT'), false);
  assert.equal(rbac.canManageAccount('ORGANIZATION_MANAGEMENT', 'ORGANIZATION_MANAGEMENT'), true);
});

// ── 403 sweep ─────────────────────────────────────────────────────────────────

interface Layer { route?: { path: string | string[]; methods: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] } }

function enumerateRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const [mount, router] of ADMIN_MOUNTS) {
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m === '_all') continue;
          const concrete = p.replace(/:(\w+)\??/g, 'c0000000000000000000000x1').replace(/\*/g, 'x');
          out.push({ method: m.toUpperCase(), path: `${ADMIN_PREFIX}${mount}${concrete}`.replace(/\/$/, '') || ADMIN_PREFIX });
        }
      }
    }
  }
  return out;
}

test('a USER token gets 403 (and no token 401) on every /api/v1/admin/* route', async () => {
  const routes = enumerateRoutes();
  assert.ok(routes.length > 150, `expected the full admin surface, got ${routes.length}`);
  const failures: string[] = [];
  for (const r of routes) {
    if (PUBLIC_ADMIN_ROUTES.includes(`${r.method} ${r.path}`)) continue;
    const asUser = await call(r.method, r.path, 'USER');
    if (asUser.status !== 403) failures.push(`${r.method} ${r.path} as USER → ${asUser.status}`);
    const anon = await call(r.method, r.path);
    if (anon.status !== 401) failures.push(`${r.method} ${r.path} anonymous → ${anon.status}`);
  }
  assert.deepEqual(failures, []);
});

test('VIEW_ONLY_ORG is rejected on every mutating admin route', async () => {
  const failures: string[] = [];
  for (const r of enumerateRoutes()) {
    if (r.method === 'GET' || r.method === 'HEAD') continue;
    const res = await call(r.method, r.path, 'VIEW_ONLY_ORG');
    if (res.status !== 403) failures.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(failures, []);
});

test('areas are separated (alias router no longer guards foreign paths)', async () => {
  assert.equal((await call('GET', '/api/v1/admin/transport-rules', 'HYGIENE_MANAGEMENT')).status, 200);
  assert.equal((await call('GET', '/api/v1/admin/transport-rules', 'RECIPIENT_MANAGEMENT')).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/mailboxes', 'RECIPIENT_MANAGEMENT')).status, 200);
  assert.equal((await call('GET', '/api/v1/admin/mailboxes', 'HELP_DESK')).status, 200);
  assert.equal((await call('GET', '/api/v1/admin/mailboxes', 'SERVER_MANAGEMENT')).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/aliases', 'HYGIENE_MANAGEMENT')).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/audit-log/stats', 'VIEW_ONLY_ORG')).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/security/settings', 'USER')).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/smtp-config/settings', 'USER', {})).status, 403);
});

test('GET /api/v1/user/me exposes adminAreas', async () => {
  const r = await call('GET', '/api/v1/user/me', 'RECIPIENT_MANAGEMENT');
  assert.equal(r.status, 200);
  assert.equal(r.json['isAdmin'], true);
  assert.deepEqual(r.json['adminAreas'], { dashboard: 'read', recipients: 'write', domains: 'read' });
  assert.deepEqual((await call('GET', '/api/v1/user/me', 'USER')).json['adminAreas'], {});
});

// ── Escalation guards ─────────────────────────────────────────────────────────

test('only ORGANIZATION_MANAGEMENT may assign roles or touch admin accounts', async () => {
  const P = '/api/v1/admin/mailboxes';
  assert.equal((await call('PUT', `${P}/u_user`, 'RECIPIENT_MANAGEMENT', { role: 'ORGANIZATION_MANAGEMENT' })).status, 403);
  assert.equal((await call('POST', P, 'RECIPIENT_MANAGEMENT', { email: 'n@ex.com', displayName: 'N', password: 'longpassword', domainId: 'd1', role: 'SERVER_MANAGEMENT' })).status, 403);
  assert.equal((await call('PUT', `${P}/u_admin`, 'RECIPIENT_MANAGEMENT', { password: 'newpassword1' })).status, 403);
  assert.equal((await call('DELETE', `${P}/u_admin`, 'RECIPIENT_MANAGEMENT')).status, 403);
  assert.equal((await call('PUT', `${P}/u_user`, 'RECIPIENT_MANAGEMENT', { displayName: 'Renamed', role: 'USER' })).status, 200);
  // HELP_DESK: password reset / enable-disable of USER accounts only
  assert.equal((await call('PUT', `${P}/u_user`, 'HELP_DESK', { password: 'newpassword1' })).status, 200);
  assert.equal((await call('PUT', `${P}/u_user`, 'HELP_DESK', { displayName: 'x' })).status, 403);
  assert.equal((await call('PUT', `${P}/u_admin`, 'HELP_DESK', { password: 'newpassword1' })).status, 403);
  assert.equal((await call('DELETE', `${P}/u_user`, 'HELP_DESK')).status, 403);
  assert.equal((await call('POST', P, 'HELP_DESK', {})).status, 403);
  // invalid role value → 400 (used to crash with a Prisma enum error)
  assert.equal((await call('PUT', `${P}/u_user`, 'ORGANIZATION_MANAGEMENT', { role: 'ADMIN' })).status, 400);
  updates.length = 0;
  assert.equal((await call('PUT', `${P}/u_user`, 'ORGANIZATION_MANAGEMENT', { role: 'HELP_DESK' })).status, 200);
  assert.equal(updates[0]?.['role'], 'HELP_DESK');
});

// ── Secrets ───────────────────────────────────────────────────────────────────

test('secrets never leave the API (tlsKey, setupTokenHash, passwordHash, bindPassword)', async () => {
  for (const path of ['/api/v1/admin/servers/settings', '/api/v1/admin/settings']) {
    const r = await call('GET', path, 'ORGANIZATION_MANAGEMENT');
    assert.equal(r.status, 200, path);
    assert.equal(r.json['tlsKey'], undefined, path);
    assert.equal(r.json['setupTokenHash'], undefined, path);
    assert.equal(r.json['hasTlsKey'], true, path);
  }
  const mb = await call('GET', '/api/v1/admin/mailboxes/u_user', 'ORGANIZATION_MANAGEMENT');
  assert.equal(mb.status, 200);
  assert.equal(mb.json['email'], 'user@ex.com');
  assert.ok(!JSON.stringify(mb.json).includes('SECRET'), 'passwordHash leaked');

  const ldap = await call('GET', '/api/v1/admin/ldap/d1', 'ORGANIZATION_MANAGEMENT');
  assert.equal(ldap.json['bindPassword'], undefined);
  assert.equal(ldap.json['hasBindPassword'], true);
  // write-only: PUT without bindPassword keeps the stored one and does not echo it
  const put = await call('PUT', '/api/v1/admin/ldap/d1', 'ORGANIZATION_MANAGEMENT', { host: 'ldap2', baseDN: 'dc=x', bindDN: 'cn=a', userDN: 'ou=u', bindPassword: '' });
  assert.equal(put.status, 200);
  assert.equal(put.json['bindPassword'], undefined);
  assert.equal(ldapStored?.['bindPassword'], 'LDAP-SECRET');
  assert.equal(ldapStored?.['host'], 'ldap2');
});

test('PUT /servers/settings accepts a single changed field (CLI) and keeps the rest', async () => {
  settingsPuts.length = 0;
  const r = await call('PUT', '/api/v1/admin/servers/settings', 'SERVER_MANAGEMENT', { jmapEnabled: false });
  assert.equal(r.status, 200);
  const last = settingsPuts.at(-1)!;
  assert.equal(last['jmapEnabled'], false);
  assert.equal(last['publicHostname'], 'mail.ex.com');
  assert.equal(last['tlsKey'], undefined, 'secrets are never written through this API');
  assert.equal(r.json['tlsKey'], undefined);
});

// ── Crash paths ───────────────────────────────────────────────────────────────

test('known crash paths return 4xx instead of killing the process', async () => {
  // domain delete with shared mailboxes (FK Restrict)
  const del = await call('DELETE', '/api/v1/admin/domains/d2', 'ORGANIZATION_MANAGEMENT');
  assert.equal(del.status, 409);
  // duplicate domain rename
  assert.equal((await call('PUT', '/api/v1/admin/domains/d2', 'ORGANIZATION_MANAGEMENT', { name: 'taken.com' })).status, 409);
  // delegate with unknown grantee
  assert.equal((await call('POST', '/api/v1/admin/mailboxes/u_user/delegates', 'ORGANIZATION_MANAGEMENT', { granteeId: 'nobody', permission: 'FULL_ACCESS' })).status, 404);
});
