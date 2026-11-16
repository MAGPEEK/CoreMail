/**
 * 9.1.x BCP review — servers / services / SSO / retention routes:
 *  - derive goes through deriveServerUrls (same rules as PUT / setup)
 *  - service listeners: 587 is seeded as STARTTLS (ssl:false), duplicate ports
 *    of a service → 409, bind address must be an IP
 *  - SSO: forcedDomains must be CoreMail domains, 400 names the bad field
 *  - retention: a tag type switch re-derives folderTarget, unique name → 409,
 *    PUT policy validates enums, assignment list carries labels, picker targets
 * Prisma faked via globalThis.__prisma, loopback Express app.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/servers-identity-retention.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const listeners: Row[] = [];
let nextId = 1;
const tags: Row[] = [
  { id: 't-rpt', name: 'Inbox 1y', type: 'RPT', folderTarget: 'INBOX', isSystem: false, action: 'MOVE_TO_ARCHIVE', retentionDays: 365, enabled: true },
  { id: 't-taken', name: 'Taken', type: 'PERSONAL', folderTarget: null, isSystem: false, action: 'MOVE_TO_ARCHIVE', retentionDays: 30, enabled: true },
];
const tagUpdates: Row[] = [];

installFakePrisma({
  user: {
    findUnique: (a) => {
      const id = String((a as { where: Row }).where['id']);
      return id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null;
    },
    findMany: (a) => {
      const w = (a as { where?: Row }).where ?? {};
      if (w['id']) return [{ id: 'u1', email: 'anna@ex.com' }];
      return [{ id: 'u1', email: 'anna@ex.com', displayName: 'Anna' }];
    },
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins: false }) },
  serviceListener: {
    count: (a) => listeners.filter((l) => l['service'] === (a as { where: Row }).where['service']).length,
    createMany: (a) => { for (const d of (a as { data: Row[] }).data) listeners.push({ id: `l${nextId++}`, active: true, ...d }); return { count: 1 }; },
    findMany: (a) => listeners.filter((l) => l['service'] === (a as { where: Row }).where['service']),
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      const not = (w['NOT'] as Row | undefined)?.['id'];
      return listeners.find((l) => l['service'] === w['service'] && l['port'] === w['port'] && l['id'] !== not) ?? null;
    },
    findUnique: (a) => listeners.find((l) => l['id'] === (a as { where: Row }).where['id']) ?? null,
    create: (a) => { const r = { id: `l${nextId++}`, ...(a as { data: Row }).data }; listeners.push(r); return r; },
    update: (a) => { const q = a as { where: Row; data: Row }; const r = listeners.find((l) => l['id'] === q.where['id'])!; Object.assign(r, q.data); return r; },
  },
  domain: {
    findUnique: (a) => ((a as { where: Row }).where['id'] === 'd1' ? { id: 'd1', name: 'ex.com' } : null),
    findMany: (a) => {
      const names = ((a as { where?: { name?: { in?: string[] } } }).where?.name?.in);
      const all = [{ id: 'd1', name: 'ex.com' }, { id: 'd2', name: 'other.com' }];
      return names ? all.filter((d) => names.includes(d.name)) : all;
    },
  },
  oidcProvider: { create: (a) => ({ id: 'p1', ...(a as { data: Row }).data }) },
  retentionTag: {
    findUnique: (a) => tags.find((t) => t['id'] === (a as { where: Row }).where['id']) ?? null,
    update: (a) => {
      const q = a as { where: Row; data: Row };
      if (q.data['name'] === 'Taken') throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      tagUpdates.push(q.data);
      return { ...tags.find((t) => t['id'] === q.where['id']), ...q.data };
    },
  },
  retentionPolicyTag: { findFirst: () => null },
  retentionPolicy: { findUnique: () => ({ id: 'pol1', action: 'ARCHIVE', targetFolder: null }), update: (a) => ({ id: 'pol1', ...(a as { data: Row }).data }) },
  retentionPolicyAssignment: {
    findMany: () => [
      { id: 'a1', target: 'GLOBAL', targetId: '' },
      { id: 'a2', target: 'USER', targetId: 'u1' },
      { id: 'a3', target: 'DOMAIN', targetId: 'ex.com' },
    ],
  },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminServersRouter } = await import('./servers.js');
const { adminServicesRouter } = await import('./services.js');
const { adminSsoRouter } = await import('./sso.js');
const { adminRetentionRouter, resolveFolderTarget } = await import('./retention.js');

const tok = (role: string) => core.signAccessToken({ sub: `actor-${role}`, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'], domainId: 'd1', sessionId: 's', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/servers', adminServersRouter);
  app.use('/api/v1/admin/services', adminServicesRouter);
  app.use('/api/v1/admin/sso', adminSsoRouter);
  app.use('/api/v1/admin/compliance/retention', adminRetentionRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, role: string, body?: unknown): Promise<{ status: number; json: Row & Row[] }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = {} as Row & Row[];
  try { json = JSON.parse(text) as Row & Row[]; } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('derive: same rules as PUT (autodiscover.<root>, standard port omitted)', async () => {
  const r = await call('POST', '/api/v1/admin/servers/settings/derive', 'SERVER_MANAGEMENT', { publicHostname: 'mail.example.com', useHttps: true, httpPort: 443 });
  assert.equal(r.status, 200);
  assert.equal(r.json['owaUrl'], 'https://mail.example.com/owa/');
  assert.equal(r.json['autodiscoverBase'], 'https://autodiscover.example.com');
  assert.equal(r.json['easUrl'], 'https://mail.example.com/Microsoft-Server-ActiveSync');
});

test('derive / health are guarded: VIEW_ONLY_ORG may not POST derive', async () => {
  const r = await call('POST', '/api/v1/admin/servers/settings/derive', 'VIEW_ONLY_ORG', { publicHostname: 'x.example.com' });
  assert.equal(r.status, 403);
});

test('listeners: 587 seeded as STARTTLS (ssl:false), 465 implicit TLS', async () => {
  const r = await call('GET', '/api/v1/admin/services/listeners/smtp-receive', 'SERVER_MANAGEMENT');
  assert.equal(r.status, 200);
  const byPort = new Map((r.json as Row[]).map((l) => [l['port'], l['ssl']]));
  assert.equal(byPort.get(587), false);
  assert.equal(byPort.get(465), true);
  assert.equal(byPort.get(25), false);
});

test('listeners: a duplicate port of the same service → 409 (add and edit)', async () => {
  const dup = await call('POST', '/api/v1/admin/services/listeners/smtp-receive', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 25, ssl: false, active: true });
  assert.equal(dup.status, 409);
  const id = String(listeners.find((l) => l['port'] === 465)!['id']);
  const edit = await call('PUT', `/api/v1/admin/services/listeners/${id}`, 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 587, ssl: true, active: true });
  assert.equal(edit.status, 409);
  const same = await call('PUT', `/api/v1/admin/services/listeners/${id}`, 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 465, ssl: true, active: false });
  assert.equal(same.status, 200, 'keeping its own port is fine');
  const missing = await call('PUT', '/api/v1/admin/services/listeners/nope', 'SERVER_MANAGEMENT', { address: '0.0.0.0', port: 2525 });
  assert.equal(missing.status, 404);
});

test('listeners: bind address must be an IP; the 400 names the field', async () => {
  const r = await call('POST', '/api/v1/admin/services/listeners/imap', 'SERVER_MANAGEMENT', { address: 'mail.example.com', port: 1143 });
  assert.equal(r.status, 400);
  assert.match(String(r.json['error']), /address/);
});

test('SSO: unknown forcedDomains → 400 naming them; known ones pass', async () => {
  const body = { domainId: 'd1', name: 'IdP', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', clientId: 'c', clientSecret: 's', forcedDomains: ['ex.com', 'nope.org'] };
  const bad = await call('POST', '/api/v1/admin/sso/providers', 'ORGANIZATION_MANAGEMENT', body);
  assert.equal(bad.status, 400);
  assert.match(String(bad.json['error']), /nope\.org/);
  const ok = await call('POST', '/api/v1/admin/sso/providers', 'ORGANIZATION_MANAGEMENT', { ...body, forcedDomains: ['ex.com', 'other.com'] });
  assert.equal(ok.status, 201);
  const invalid = await call('POST', '/api/v1/admin/sso/providers', 'ORGANIZATION_MANAGEMENT', { ...body, scopes: 'email' });
  assert.equal(invalid.status, 400);
  assert.match(String(invalid.json['error']), /scopes/);
});

test('retention: folderTarget follows the tag type', () => {
  assert.deepEqual(resolveFolderTarget('PERSONAL', 'INBOX'), { folderTarget: null });
  assert.deepEqual(resolveFolderTarget('DPT', undefined), { folderTarget: 'ALL_OTHER' });
  assert.ok('error' in resolveFolderTarget('RPT', undefined));
  assert.ok('error' in resolveFolderTarget('RPT', 'ALL_OTHER'));
  assert.ok('error' in resolveFolderTarget('DPT', 'INBOX'));
});

test('retention: switching an RPT tag to PERSONAL clears its folder; duplicate name → 409', async () => {
  const r = await call('PUT', '/api/v1/admin/compliance/retention/tags/t-rpt', 'COMPLIANCE_MANAGEMENT', { type: 'PERSONAL' });
  assert.equal(r.status, 200);
  assert.equal(tagUpdates.at(-1)?.['folderTarget'], null);
  const toRpt = await call('PUT', '/api/v1/admin/compliance/retention/tags/t-taken', 'COMPLIANCE_MANAGEMENT', { type: 'RPT' });
  assert.equal(toRpt.status, 400, 'RPT without folder');
  const dup = await call('PUT', '/api/v1/admin/compliance/retention/tags/t-rpt', 'COMPLIANCE_MANAGEMENT', { name: 'Taken' });
  assert.equal(dup.status, 409);
});

test('retention: PUT policy validates action / scope instead of failing with 500', async () => {
  assert.equal((await call('PUT', '/api/v1/admin/compliance/retention/pol1', 'COMPLIANCE_MANAGEMENT', { action: 'NUKE' })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/compliance/retention/pol1', 'COMPLIANCE_MANAGEMENT', { scope: 'X' })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/compliance/retention/pol1', 'COMPLIANCE_MANAGEMENT', { action: 'MOVE_TO_FOLDER' })).status, 400, 'needs targetFolder');
  assert.equal((await call('PUT', '/api/v1/admin/compliance/retention/pol1', 'COMPLIANCE_MANAGEMENT', { name: 'ok', enabled: false })).status, 200);
});

test('retention: assignments carry readable labels; picker lists domains + users', async () => {
  const a = await call('GET', '/api/v1/admin/compliance/retention/pol1/assignments', 'COMPLIANCE_MANAGEMENT');
  assert.equal(a.status, 200);
  assert.deepEqual((a.json as Row[]).map((x) => x['label']), ['Alle Postfächer', 'anna@ex.com', 'ex.com']);
  const t = await call('GET', '/api/v1/admin/compliance/retention/targets?q=ann', 'COMPLIANCE_MANAGEMENT');
  assert.equal(t.status, 200);
  assert.equal((t.json['domains'] as Row[]).length, 2);
  assert.equal((t.json['users'] as Row[])[0]?.['email'], 'anna@ex.com');
  const denied = await call('GET', '/api/v1/admin/compliance/retention/targets', 'VIEW_ONLY_ORG');
  assert.equal(denied.status, 403);
});

test('servers: invalid host names are a 400 on PUT and derive; valid ones still derive (live BCP test 9.2)', async () => {
  for (const [field, value] of [['publicHostname', 'bad host!'], ['smtpHost', 'mail.example.com\r\n250 x'], ['imapHost', '-x.example.com'], ['pop3Host', 'a..b']] as const) {
    const r = await call('PUT', '/api/v1/admin/servers/settings', 'SERVER_MANAGEMENT', { [field]: value });
    assert.equal(r.status, 400, `${field}=${JSON.stringify(value)}`);
    assert.ok(JSON.stringify(r.json['details']).includes(field), JSON.stringify(r.json));
  }
  assert.equal((await call('POST', '/api/v1/admin/servers/settings/derive', 'SERVER_MANAGEMENT', { publicHostname: 'bad host!' })).status, 400);
  for (const h of ['localhost', 'mail.e2e.test', '192.168.1.10', 'MAIL.Example.COM']) {
    assert.equal((await call('POST', '/api/v1/admin/servers/settings/derive', 'SERVER_MANAGEMENT', { publicHostname: h })).status, 200, h);
  }
});
