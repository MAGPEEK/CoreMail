/**
 * 8.x: ROLE_PERMISSIONS is the single role → area map.
 *  - the map and AREA_MATRIX / areaAccess / canAccess / allowedAreas agree;
 *  - requireArea(area) admits exactly what the map grants, for every role ×
 *    area × method (synthetic router per area, real guard);
 *  - every real /api/v1/admin/* router admits (GET and a mutating method)
 *    exactly the roles the map grants for the router's area;
 *  - VIEW_ONLY_ORG: read on everything it could read before, write nowhere;
 *  - GET /api/v1/admin/me/permissions per role.
 * Fake Prisma via globalThis.__prisma, loopback Express app.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/permissions.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AdminArea } from '../../lib/rbac.js';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let requireMfaForAdmins = false;
installFakePrisma({
  user: {
    // Token actors ("actor-<ROLE>") exist with that role (current-role check).
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      if (id === 'u_user') return applySelect({ id, email: 'user@ex.com', displayName: 'U', role: 'USER', active: true }, q.select);
      return applySelect(id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null, q.select);
    },
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins }) },
  userMfa: { findFirst: () => ({ totpEnabled: true, webAuthnCredentials: [] }) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const auth = await import('../../middleware/auth.js');
const rbac = await import('../../lib/rbac.js');
const { ADMIN_MOUNTS, ADMIN_PREFIX } = await import('./index.js');
const { adminMeRouter } = await import('./me.js');

const ROLES = rbac.USER_ROLES;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const tok = (role: string, mfaVerified = true) => core.signAccessToken({
  sub: `actor-${role}`, email: `${role}@ex.com`,
  role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId: 's', mfaVerified,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  // Synthetic router per area: the real guard in front of a trivial handler.
  for (const area of rbac.ADMIN_AREAS) {
    const r = express.Router();
    r.use(auth.requireArea(area));
    r.all('/probe', (_req, res) => { res.status(200).json({ ok: true }); });
    app.use(`/probe/${area}`, r);
  }
  app.use('/api/v1/admin/me', adminMeRouter);
  for (const [path, router] of ADMIN_MOUNTS) app.use(`${ADMIN_PREFIX}${path}`, router);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, role?: string, opts: { mfaVerified?: boolean; timeoutMs?: number } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role) headers['authorization'] = `Bearer ${tok(role, opts.mfaVerified ?? true)}`;
  try {
    const r = await fetch(`${base}${path}`, {
      method, headers,
      ...(method !== 'GET' && method !== 'HEAD' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    const text = await r.text();
    let json: Row = {};
    try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch {
    // A handler that waits on Redis/BullMQ etc. never answers in the test: it
    // was reached, i.e. the guard let the request through.
    return { status: 0, json: {} };
  }
}

const isForbidden = (r: { status: number; json: Row }) => r.status === 403 && r.json['code'] === 'FORBIDDEN_ROLE';

// ── The map ──────────────────────────────────────────────────────────────────

test('ROLE_PERMISSIONS covers every role, lists each area at most once, USER has none', () => {
  assert.deepEqual(Object.keys(rbac.ROLE_PERMISSIONS).sort(), [...ROLES].sort());
  assert.deepEqual(rbac.ROLE_PERMISSIONS.USER, []);
  for (const role of ROLES) {
    const areas = rbac.ROLE_PERMISSIONS[role].map((p) => p.area);
    assert.equal(new Set(areas).size, areas.length, role);
  }
  assert.ok(Object.isFrozen(rbac.ROLE_PERMISSIONS), 'map is immutable');
  assert.equal(auth.ROLE_PERMISSIONS, rbac.ROLE_PERMISSIONS, 'the guard module exports the same map');
});

test('ROLE_PERMISSIONS agrees with AREA_MATRIX, areaAccess, canAccess and allowedAreas', () => {
  for (const role of ROLES) {
    const fromMap = Object.fromEntries(rbac.ROLE_PERMISSIONS[role].map((p) => [p.area, p.access]));
    assert.deepEqual(rbac.allowedAreas(role), fromMap, role);
    for (const area of rbac.ADMIN_AREAS) {
      const m = rbac.AREA_MATRIX[area];
      const expected = role === 'USER' ? null
        : role === 'ORGANIZATION_MANAGEMENT' || m.write.includes(role) ? 'write'
          : m.read.includes(role) ? 'read' : null;
      assert.equal(rbac.areaAccess(role, area), expected, `${role}/${area}`);
      assert.equal(fromMap[area] ?? null, expected, `${role}/${area}`);
      for (const method of METHODS) {
        const ok = expected === 'write' || (expected === 'read' && (method === 'GET' || method === 'HEAD'));
        assert.equal(rbac.canAccess(role, area, method), ok, `${role} ${method} ${area}`);
      }
    }
  }
  assert.deepEqual(rbac.allowedAreas('ADMIN'), {}, 'unknown role gets nothing');
});

test('VIEW_ONLY_ORG: read on every area it could read before (all but compliance), write nowhere', () => {
  const perms = rbac.ROLE_PERMISSIONS.VIEW_ONLY_ORG;
  assert.ok(perms.every((p) => p.access === 'read'));
  assert.deepEqual(perms.map((p) => p.area).sort(), rbac.ADMIN_AREAS.filter((a) => a !== 'compliance').sort());
});

test('pinned per-role permissions (behaviour unchanged)', () => {
  const view = (role: (typeof ROLES)[number]) => rbac.allowedAreas(role);
  assert.deepEqual(view('HELP_DESK'), { dashboard: 'read', recipients: 'read' });
  assert.deepEqual(view('RECIPIENT_MANAGEMENT'), { dashboard: 'read', recipients: 'write', domains: 'read' });
  assert.deepEqual(view('SERVER_MANAGEMENT'), { dashboard: 'read', organisation: 'read', servers: 'write', domains: 'read' });
  assert.deepEqual(view('HYGIENE_MANAGEMENT'), { dashboard: 'read', hygiene: 'write' });
  assert.deepEqual(view('COMPLIANCE_MANAGEMENT'), { dashboard: 'read', compliance: 'write' });
  assert.equal(Object.values(view('ORGANIZATION_MANAGEMENT')).length, rbac.ADMIN_AREAS.length);
  assert.ok(Object.values(view('ORGANIZATION_MANAGEMENT')).every((a) => a === 'write'));
});

// ── Guards vs. map ───────────────────────────────────────────────────────────

test('requireArea admits exactly what ROLE_PERMISSIONS grants (every role × area × method)', async () => {
  const mismatches: string[] = [];
  for (const role of [...ROLES, 'ADMIN']) {
    for (const area of rbac.ADMIN_AREAS) {
      const access = rbac.isUserRole(role) ? rbac.ROLE_PERMISSIONS[role].find((p) => p.area === area)?.access : undefined;
      for (const method of METHODS) {
        const expected = access === 'write' || (access === 'read' && (method === 'GET' || method === 'HEAD'));
        const r = await call(method, `/probe/${area}/probe`, role);
        const got = r.status === 200;
        if (got !== expected || (!got && r.status !== 403)) mismatches.push(`${role} ${method} ${area}: ${r.status}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

/** Area of every real admin mount (null = ORGANIZATION_MANAGEMENT only). */
const MOUNT_AREAS: Record<string, { area: AdminArea | null; get: string; write?: [string, string] }> = {
  '/dashboard':            { area: 'dashboard',    get: '/' },
  '/settings':             { area: 'organisation', get: '/', write: ['PUT', '/'] },
  '/mailboxes':            { area: 'recipients',   get: '/', write: ['POST', '/'] },
  '':                      { area: 'recipients',   get: '/aliases', write: ['DELETE', '/aliases/c0000000000000000000000x1'] },
  '/domains':              { area: 'domains',      get: '/', write: ['POST', '/'] },
  '/queues':               { area: 'servers',      get: '/settings', write: ['PUT', '/settings'] },
  '/backups':              { area: 'servers',      get: '/jobs' },
  '/logs':                 { area: 'servers',      get: '/levels' },
  '/compliance/retention': { area: 'compliance',   get: '/', write: ['POST', '/'] },
  '/audit-log':            { area: 'compliance',   get: '/stats' },
  '/servers':              { area: 'servers',      get: '/settings', write: ['PUT', '/settings'] },
  '/services':             { area: 'servers',      get: '/overview' },
  '/certificates':         { area: 'servers',      get: '/', write: ['DELETE', '/c0000000000000000000000x1'] },
  '/shared-mailboxes':     { area: 'recipients',   get: '/', write: ['POST', '/'] },
  '/quarantine':           { area: 'hygiene',      get: '/stats' },
  '/transport-rules':      { area: 'hygiene',      get: '/', write: ['POST', '/'] },
  '/mobile':               { area: 'recipients',   get: '/devices' },
  '/message-trace':        { area: 'compliance',   get: '/' },
  '/connectors':           { area: 'servers',      get: '/' },
  '/organisation':         { area: 'organisation', get: '/gal' },
  '/security':             { area: 'hygiene',      get: '/settings', write: ['PUT', '/settings'] },
  '/security/attacks':     { area: 'hygiene',      get: '/summary' },
  '/smtp-config':          { area: 'servers',      get: '/settings', write: ['PUT', '/settings'] },
  '/ldap':                 { area: 'identity',     get: '/' },
  '/sso':                  { area: 'identity',     get: '/providers' },
  '/storage':              { area: null,           get: '/' },
  '/branding':             { area: 'organisation', get: '/', write: ['PUT', '/'] },
  '/ems':                  { area: 'recipients',   get: '/mailboxes' },
  '/protocol-access':      { area: 'servers',      get: '/', write: ['PUT', '/'] },
  '/webmail-policies':     { area: 'servers',      get: '/', write: ['PUT', '/'] },
  // 10.3: settings view + own tokens for every admin role; the switch itself: EXTRA_PROBES
  '/mcp':                  { area: 'dashboard',    get: '/settings' },
  // 10.4.2: BCP dashboard card "Zertifikat einrichten" (state + dismiss)
  '/setup-state':          { area: 'servers',      get: '/', write: ['POST', '/certificate-hint/dismiss'] },
};
const EXTRA_PROBES: Array<{ area: AdminArea | null; method: string; path: string }> = [
  { area: 'domains', method: 'GET', path: '/ems/accepted-domains' },
  { area: 'hygiene', method: 'GET', path: '/ems/transport-rules' },
  { area: null,      method: 'GET', path: '/ems/organization-config' },
  // 9.4: domain level write = servers (its GET is servers OR domains read), user level = recipients
  { area: 'servers',    method: 'PUT', path: '/protocol-access/domains/c0000000000000000000000x1' },
  { area: 'recipients', method: 'GET', path: '/protocol-access/users/c0000000000000000000000x1' },
  { area: 'recipients', method: 'PUT', path: '/protocol-access/users/c0000000000000000000000x1' },
  // 9.4 webmail policies: same split as the protocol switches
  { area: 'servers',    method: 'PUT', path: '/webmail-policies/domains/c0000000000000000000000x1' },
  { area: 'recipients', method: 'GET', path: '/webmail-policies/users/c0000000000000000000000x1' },
  { area: 'recipients', method: 'PUT', path: '/webmail-policies/users/c0000000000000000000000x1' },
  // 10.3: the MCP switch + IP allowlist are server configuration
  { area: 'servers',    method: 'PUT', path: '/mcp/settings' },
];

test('every admin mount is in the area table', () => {
  assert.deepEqual(ADMIN_MOUNTS.map(([p]) => p).sort(), Object.keys(MOUNT_AREAS).sort());
});

test('real admin routers admit exactly the roles ROLE_PERMISSIONS grants for their area', async () => {
  const probes: Array<{ area: AdminArea | null; method: string; path: string }> = [...EXTRA_PROBES];
  for (const [mount, spec] of Object.entries(MOUNT_AREAS)) {
    probes.push({ area: spec.area, method: 'GET', path: `${mount}${spec.get}`.replace(/\/$/, '') || '/' });
    if (spec.write) probes.push({ area: spec.area, method: spec.write[0], path: `${mount}${spec.write[1]}`.replace(/\/$/, '') });
  }
  const mismatches: string[] = [];
  for (const p of probes) {
    for (const role of ROLES) {
      const expected = (p.area === null ? role === 'ORGANIZATION_MANAGEMENT' : rbac.canAccess(role, p.area, p.method))
        // narrow action grants (lib/rbac.ts ADMIN_ACTIONS): COMPLIANCE_MANAGEMENT lists backup jobs
        || (p.path === '/backups/jobs' && rbac.hasAdminAction(role, 'backupMailboxData'));
      // Admitted requests reach handlers backed by fakes; only "denied or not" matters.
      const r = await call(p.method, `${ADMIN_PREFIX}${p.path}`, role, { timeoutMs: 1_500 });
      if (isForbidden(r) === expected) mismatches.push(`${role} ${p.method} ${p.path} → ${r.status} (expected ${expected ? 'allowed' : 'denied'})`);
    }
  }
  assert.deepEqual(mismatches, []);
});

// ── GET /api/v1/admin/me/permissions ─────────────────────────────────────────

test('GET /me/permissions returns role, areas from ROLE_PERMISSIONS and mfaVerified for every admin role', async () => {
  for (const role of rbac.ADMIN_ROLES) {
    const r = await call('GET', '/api/v1/admin/me/permissions', role);
    assert.equal(r.status, 200, role);
    assert.equal(r.json['role'], role);
    assert.deepEqual(r.json['areas'], Object.fromEntries(rbac.ROLE_PERMISSIONS[role].map((p) => [p.area, p.access])), role);
    assert.equal(r.json['mfaVerified'], true);
  }
  const vo = await call('GET', '/api/v1/admin/me/permissions', 'VIEW_ONLY_ORG');
  assert.ok(Object.values(vo.json['areas'] as Row).every((a) => a === 'read'), 'VIEW_ONLY_ORG never gets write');
});

test('GET /me/permissions: USER → 403, anonymous → 401, mfaVerified reflects the session', async () => {
  assert.equal((await call('GET', '/api/v1/admin/me/permissions', 'USER')).status, 403);
  assert.equal((await call('GET', '/api/v1/admin/me/permissions')).status, 401);
  const r = await call('GET', '/api/v1/admin/me/permissions', 'HELP_DESK', { mfaVerified: false });
  assert.equal(r.status, 200);
  assert.equal(r.json['mfaVerified'], false);
  assert.deepEqual(r.json['areas'], { dashboard: 'read', recipients: 'read' });
});

test('GET /me/permissions follows forced admin MFA like every admin route', async () => {
  requireMfaForAdmins = true;
  try {
    const r = await call('GET', '/api/v1/admin/me/permissions', 'SERVER_MANAGEMENT', { mfaVerified: false });
    assert.equal(r.status, 403);
    assert.equal(r.json['code'], 'MFA_NOT_VERIFIED');
    assert.equal((await call('GET', '/api/v1/admin/me/permissions', 'SERVER_MANAGEMENT')).status, 200);
  } finally {
    requireMfaForAdmins = false;
  }
});

// ── Narrow admin actions (HELP_DESK, COMPLIANCE_MANAGEMENT backups) ──────────

test('allowedActions: HELP_DESK and COMPLIANCE get exactly their grants, write implies the recipients actions', () => {
  const RECIPIENT_ACTIONS = ['resetPassword', 'toggleActive', 'revokeSessions'];
  assert.deepEqual(rbac.allowedActions('HELP_DESK'), { recipients: RECIPIENT_ACTIONS });
  assert.deepEqual(rbac.allowedActions('RECIPIENT_MANAGEMENT'), { recipients: RECIPIENT_ACTIONS });
  assert.deepEqual(rbac.allowedActions('COMPLIANCE_MANAGEMENT'), { servers: ['backupMailboxData'] });
  assert.deepEqual(rbac.allowedActions('SERVER_MANAGEMENT'), {}, 'write on servers does not imply mailbox content');
  assert.deepEqual(rbac.allowedActions('VIEW_ONLY_ORG'), {});
  assert.deepEqual(rbac.allowedActions('USER'), {});
  assert.deepEqual(rbac.allowedActions('ORGANIZATION_MANAGEMENT'), { recipients: RECIPIENT_ACTIONS, servers: ['backupMailboxData'] });
  assert.equal(rbac.mailboxUpdateFields('RECIPIENT_MANAGEMENT'), null);
  assert.deepEqual([...(rbac.mailboxUpdateFields('HELP_DESK') ?? [])].sort(), ['active', 'password', 'revokeAppPasswords']);
  assert.deepEqual([...(rbac.mailboxUpdateFields('VIEW_ONLY_ORG') ?? [])], []);
});

test('server guards admit an action route exactly when the role has the action', async () => {
  const P = '/api/v1/admin';
  const has = (a: Parameters<typeof rbac.hasAdminAction>[1]) => (r: string) => rbac.hasAdminAction(r, a);
  const probes: Array<{ action: string; ok: (role: string) => boolean; method: string; path: string; body?: unknown }> = [
    { action: 'resetPassword',  ok: has('resetPassword'),  method: 'PUT',  path: `${P}/mailboxes/u_user`, body: { password: 'newpassword1' } },
    { action: 'toggleActive',   ok: has('toggleActive'),   method: 'PUT',  path: `${P}/mailboxes/u_user`, body: { active: true } },
    { action: 'revokeSessions', ok: has('revokeSessions'), method: 'POST', path: `${P}/mailboxes/u_user/revoke-sessions` },
    // any other field needs write on recipients — no action covers it
    { action: '(write)', ok: (r) => rbac.canAccess(r, 'recipients', 'PUT'), method: 'PUT', path: `${P}/mailboxes/u_user`, body: { displayName: 'X' } },
    { action: 'backupMailboxData', ok: has('backupMailboxData'), method: 'GET',  path: `${P}/backups/download/c0000000000000000000000x1` },
    { action: 'backupMailboxData', ok: has('backupMailboxData'), method: 'GET',  path: `${P}/backups/archive/download?key=x` },
    { action: 'backupMailboxData', ok: has('backupMailboxData'), method: 'POST', path: `${P}/backups/import/u_user?folderId=f` },
    { action: 'backupMailboxData', ok: has('backupMailboxData'), method: 'POST', path: `${P}/backups/mailbox/u_user` },
  ];
  const mismatches: string[] = [];
  for (const p of probes) {
    for (const role of ROLES) {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` };
      let status = 0; let json: Row = {};
      try {
        const res = await fetch(`${base}${p.path}`, {
          method: p.method, headers,
          ...(p.body !== undefined ? { body: JSON.stringify(p.body) } : p.method !== 'GET' ? { body: '{}' } : {}),
          signal: AbortSignal.timeout(1_500),
        });
        status = res.status;
        try { json = JSON.parse(await res.text()) as Row; } catch { /* not JSON */ }
      } catch { /* a handler waiting on a backend was reached: admitted */ }
      const denied = status === 403 && json['code'] === 'FORBIDDEN_ROLE';
      if (denied === p.ok(role)) mismatches.push(`${role} ${p.method} ${p.path} [${p.action}] → ${status} ${String(json['error'] ?? '')}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('GET /me/permissions reports the actions from the same map', async () => {
  for (const role of rbac.ADMIN_ROLES) {
    const r = await call('GET', '/api/v1/admin/me/permissions', role);
    assert.deepEqual(r.json['actions'], rbac.allowedActions(role), role);
  }
  const hd = await call('GET', '/api/v1/admin/me/permissions', 'HELP_DESK');
  assert.deepEqual(hd.json['actions'], { recipients: ['resetPassword', 'toggleActive', 'revokeSessions'] });
  assert.deepEqual(hd.json['areas'], { dashboard: 'read', recipients: 'read' });
});
