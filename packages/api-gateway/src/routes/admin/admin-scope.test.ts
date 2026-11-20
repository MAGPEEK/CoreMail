/**
 * 9.5 admin management scopes — route tests over the real admin routers
 * (mountAdminRoutes + /admin/me) with an in-memory Prisma
 * (test-support/memory-model.ts). Two domains: a.example (dA) and b.example
 * (dB); the scoped admins are limited to dA. Per router family: lists are
 * filtered, objects of dB answer 404 exactly like unknown ids, creates in dB
 * are 403 OUT_OF_SCOPE, server-wide routes 403. Plus: GET /me/permissions,
 * scope assignment (ORGANIZATION_MANAGEMENT only, audited, sessions revoked,
 * role cache dropped) and the escalation guards.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/admin-scope.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';
import { memoryModel, type Row } from '../../test-support/memory-model.js';

setTestEnv();
process.env['BACKUP_SERVICE_URL'] = 'http://127.0.0.1:1';

const dA = { id: 'dA', name: 'a.example', active: true, primary: true, dkimSelector: 'coremail', dkimPrivateKey: 'k', createdAt: new Date() };
const dB = { id: 'dB', name: 'b.example', active: true, primary: false, dkimSelector: 'coremail', dkimPrivateKey: 'k', createdAt: new Date() };
const user = (id: string, role: string, domain: typeof dA, extra: Row = {}): Row => ({
  id, email: `${id}@${domain.name}`, displayName: id, role, active: true, domainId: domain.id,
  quotaBytes: 1000n, usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null,
  createdAt: new Date(), lastLoginAt: null, mailbox: { id: `mb-${id}` }, ...extra,
});

const db: Record<string, Row[]> = {
  domain: [dA, dB],
  user: [
    user('org', 'ORGANIZATION_MANAGEMENT', dA),
    user('rmOrg', 'RECIPIENT_MANAGEMENT', dB), // unscoped
    user('hdA', 'HELP_DESK', dA),
    user('rmA', 'RECIPIENT_MANAGEMENT', dA),
    user('hyA', 'HYGIENE_MANAGEMENT', dA),
    user('coA', 'COMPLIANCE_MANAGEMENT', dA),
    user('voA', 'VIEW_ONLY_ORG', dA),
    user('adminA', 'SERVER_MANAGEMENT', dA), // an organisation-wide admin account inside dA
    user('ua1', 'USER', dA),
    user('ub1', 'USER', dB),
  ],
  adminScope: ['hdA', 'rmA', 'hyA', 'coA', 'voA'].map((u) => ({ id: `sc-${u}`, userId: u, domainId: 'dA', domain: { id: 'dA', name: 'a.example' } })),
  sharedMailbox: [
    { id: 'smA', email: 'team@a.example', displayName: 'Team A', domainId: 'dA', active: true, quotaBytes: 1n, quotaWarningBytes: null, quotaProhibitSendBytes: null, permissions: [], mailbox: { id: 'mb-smA' } },
    { id: 'smB', email: 'team@b.example', displayName: 'Team B', domainId: 'dB', active: true, quotaBytes: 1n, quotaWarningBytes: null, quotaProhibitSendBytes: null, permissions: [], mailbox: { id: 'mb-smB' } },
  ],
  emailAlias: [
    { id: 'alA', address: 'x@a.example', domainId: 'dA', targetUserId: 'ua1', targetUser: { domainId: 'dA' }, targetShared: null },
    { id: 'alB', address: 'x@b.example', domainId: 'dB', targetUserId: 'ub1', targetUser: { domainId: 'dB' }, targetShared: null },
    { id: 'alMix', address: 'y@a.example', domainId: 'dA', targetUserId: 'ub1', targetUser: { domainId: 'dB' }, targetShared: null },
    // an alias of the organisation-wide admin account inside dA
    { id: 'alAdm', address: 'boss@a.example', domainId: 'dA', targetUserId: 'adminA', targetUser: { domainId: 'dA', role: 'SERVER_MANAGEMENT' }, targetShared: null },
  ],
  activeSyncDevice: [
    { id: 'devA', deviceId: 'A', status: 'OK', userId: 'ua1', user: { id: 'ua1', domainId: 'dA', role: 'USER' } },
    { id: 'devB', deviceId: 'B', status: 'OK', userId: 'ub1', user: { id: 'ub1', domainId: 'dB', role: 'USER' } },
    // the phone of the organisation-wide admin account inside dA
    { id: 'devAdm', deviceId: 'C', status: 'OK', userId: 'adminA', user: { id: 'adminA', domainId: 'dA', role: 'SERVER_MANAGEMENT' } },
  ],
  blacklist: [
    { id: 'gl', scope: 'GLOBAL', scopeId: null, listType: 'BLOCK', patternType: 'EXACT', pattern: 'g@spam.test', comment: '', active: true, createdAt: new Date() },
    { id: 'dmA', scope: 'DOMAIN', scopeId: 'dA', listType: 'BLOCK', patternType: 'EXACT', pattern: 'a@spam.test', comment: '', active: true, createdAt: new Date() },
    { id: 'dmB', scope: 'DOMAIN', scopeId: 'dB', listType: 'BLOCK', patternType: 'EXACT', pattern: 'b@spam.test', comment: '', active: true, createdAt: new Date() },
    { id: 'usA', scope: 'USER', scopeId: 'ua1', listType: 'ALLOW', patternType: 'EXACT', pattern: 'ua@friend.test', comment: '', active: true, createdAt: new Date() },
    { id: 'usB', scope: 'USER', scopeId: 'ub1', listType: 'ALLOW', patternType: 'EXACT', pattern: 'ub@friend.test', comment: '', active: true, createdAt: new Date() },
  ],
  quarantine: [
    { id: 'qA', fromAddr: 's@spam.test', toAddr: 'ua1@a.example', subject: 'A', reason: 'SPAM', released: false, rawPath: 'q/qA', details: { envelope: { from: 's@spam.test', recipients: ['ua1@a.example'] } }, createdAt: new Date() },
    { id: 'qB', fromAddr: 's@spam.test', toAddr: 'ub1@b.example', subject: 'B', reason: 'SPAM', released: false, rawPath: 'q/qB', details: { envelope: { from: 's@spam.test', recipients: ['ub1@b.example'] } }, createdAt: new Date() },
    { id: 'qMix', fromAddr: 's@spam.test', toAddr: 'ua1@a.example', subject: 'M', reason: 'SPAM', released: false, rawPath: 'q/qM', details: { envelope: { from: 's@spam.test', recipients: ['ua1@a.example', 'ub1@b.example'] } }, createdAt: new Date() },
  ],
  auditLog: [
    { id: 'au1', timestamp: new Date(), actorId: 'org', action: 'mailboxes.put', targetType: 'mailboxes', targetId: 'ua1', targetName: null, success: true },
    { id: 'au2', timestamp: new Date(), actorId: 'org', action: 'mailboxes.put', targetType: 'mailboxes', targetId: 'ub1', targetName: null, success: true },
    { id: 'au3', timestamp: new Date(), actorId: 'org', action: 'quarantine.release', targetType: 'quarantine', targetId: 'q9', targetName: 'z@a.example', success: true },
    { id: 'au4', timestamp: new Date(), actorId: 'org', action: 'mailbox.foreign.open', targetType: 'mailbox', targetId: 'mb-ub1', targetName: null, success: true },
  ],
  systemLog: [
    { id: 'lA', category: 'MAIL_FLOW', timestamp: new Date(), level: 'INFO', message: 'm', metadata: { sender: 'ext@other.test', recipient: 'ua1@a.example', status: 'DELIVERED' } },
    { id: 'lB', category: 'MAIL_FLOW', timestamp: new Date(), level: 'INFO', message: 'm', metadata: { sender: 'ext@other.test', recipient: 'ub1@b.example', status: 'DELIVERED' } },
  ],
  session: [],
  mailboxDelegate: [],
  sharedMailboxPerm: [],
};
const settings = { id: 'singleton', requireMfaForAdmins: false, auditLogEnabled: true };

const models: Record<string, Record<string, (...a: unknown[]) => unknown>> = Object.fromEntries(
  Object.entries(db).map(([name, rows]) => [name, memoryModel(rows)]),
);
models['serverSettings'] = { findUnique: () => ({ ...settings }) };
models['message'] = { aggregate: () => ({ _sum: { rawSize: 0 } }) };
models['mailbox'] = { findUnique: (a) => ({ id: `mb-${String((a as { where: Row }).where['userId'])}` }) };
models['mailboxDelegate']!['upsert'] = (a) => ({ id: 'del', ...(a as { create: Row }).create });
// AdminScope rows embed their domain (the memory model has no relations)
models['adminScope']!['createMany'] = (a) => {
  const data = (a as { data: Row[] }).data;
  for (const d of data) {
    const dom = db['domain']!.find((x) => x['id'] === d['domainId'])!;
    db['adminScope']!.push({ id: `sc-${Math.random()}`, ...d, domain: { id: dom['id'], name: dom['name'] } });
  }
  return { count: data.length };
};
const userFindMany = models['user']!['findMany']!;
models['user']!['findMany'] = (a) => (userFindMany(a) as Row[]).map((u) => (
  (a as { select?: Row } | undefined)?.select?.['adminScopes']
    ? { ...u, adminScopes: db['adminScope']!.filter((s) => s['userId'] === u['id']).map((s) => ({ domain: s['domain'] })) }
    : u));
installFakePrisma(models);

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { adminMeRouter } = await import('./me.js');
const { dashboardSections } = await import('./dashboard.js');

const roleOf = (id: string): string => String(db['user']!.find((u) => u['id'] === id)?.['role']);
const tok = (id: string) => core.signAccessToken({
  sub: id, email: `${id}@a.example`, role: roleOf(id) as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'dA', sessionId: `${id}-s`, mfaVerified: true,
});

const events: Array<{ userId: string; reason: string }> = [];
core.onAuthInvalidation((e) => { events.push({ userId: e.userId, reason: String(e.reason) }); });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/me', adminMeRouter);
  mountAdminRoutes(app);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(actor: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Row & Row[] }> {
  const r = await fetch(`${base}/api/v1/admin${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(actor)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: unknown = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json: json as Row & Row[] };
}
const ids = (list: unknown): string[] => (list as Row[]).map((r) => String(r['id'])).sort();
const NOT_FOUND = { error: 'Not found' };
const OUT_OF_SCOPE = 'OUT_OF_SCOPE';

test('GET /me/permissions: scope, areas without the server-wide ones', async () => {
  const hd = await call('hdA', 'GET', '/me/permissions');
  assert.equal(hd.status, 200);
  assert.deepEqual(hd.json['scope'], { kind: 'domains', domains: [{ id: 'dA', name: 'a.example' }] });
  assert.deepEqual(hd.json['areas'], { dashboard: 'read', recipients: 'read' });
  const vo = await call('voA', 'GET', '/me/permissions');
  assert.equal((vo.json['areas'] as Row)['servers'], undefined, 'VIEW_ONLY_ORG scoped loses the servers area');
  assert.equal((vo.json['areas'] as Row)['organisation'], undefined);
  assert.equal((vo.json['areas'] as Row)['domains'], 'read');
  const co = await call('coA', 'GET', '/me/permissions');
  assert.deepEqual(co.json['actions'], {}, 'no per-mailbox backups for scoped compliance admins');
  const o = await call('org', 'GET', '/me/permissions');
  assert.deepEqual(o.json['scope'], { kind: 'organisation' });
});

test('mailboxes: list filtered, other domain = 404 like an unknown id, create only in scope', async () => {
  assert.deepEqual(ids((await call('hdA', 'GET', '/mailboxes')).json), ['adminA', 'coA', 'hdA', 'hyA', 'org', 'rmA', 'ua1', 'voA']);
  assert.equal(ids((await call('rmOrg', 'GET', '/mailboxes')).json).length, 10, 'unscoped admins see everything');
  for (const [m, p, b] of [
    ['GET', '/mailboxes/ub1', undefined], ['PUT', '/mailboxes/ub1', { active: false }],
    ['POST', '/mailboxes/ub1/revoke-sessions', {}], ['GET', '/mailboxes/ub1/mail-flow', undefined],
    ['GET', '/mailboxes/ub1/delegates', undefined],
  ] as const) {
    const out = await call('hdA', m, p, b);
    const unknown = await call('hdA', m, p.replace('ub1', 'nope'), b);
    assert.deepEqual([out.status, out.json], [404, NOT_FOUND], `${m} ${p}`);
    assert.deepEqual([unknown.status, unknown.json], [out.status, out.json], `${m} ${p}: no existence oracle`);
  }
  assert.equal((await call('hdA', 'PUT', '/mailboxes/ua1', { active: true })).status, 200, 'HELP_DESK action inside the scope');
  const outside = await call('rmA', 'POST', '/mailboxes', { email: 'n@b.example', displayName: 'N', password: 'x'.repeat(16), domainId: 'dB' });
  assert.deepEqual([outside.status, outside.json['code']], [403, OUT_OF_SCOPE]);
  const delegate = await call('rmA', 'POST', '/mailboxes/ua1/delegates', { granteeId: 'ub1', permission: 'READ_ONLY' });
  assert.deepEqual([delegate.status, delegate.json['error']], [404, 'Grantee not found'], 'grantee outside the scope');
  for (const p of ['/mailboxes/quota-defaults', '/mailboxes/recalculate-all-quotas', '/mailboxes/bulk-provision']) {
    const r = await call('rmA', p.endsWith('defaults') ? 'PUT' : 'POST', p, p.endsWith('defaults') ? { quotaWarningPercent: 50 } : {});
    assert.deepEqual([r.status, r.json['code']], [403, 'SCOPE_ORG_ONLY'], p);
  }
});

test('mailboxes: scoped admins cannot edit organisation-wide admin accounts or assign roles', async () => {
  const r = await call('rmA', 'PUT', '/mailboxes/adminA', { displayName: 'X' });
  assert.deepEqual([r.status, r.json['code']], [403, 'FORBIDDEN_ROLE']);
  const c = await call('rmA', 'POST', '/mailboxes', { email: 'n2@a.example', displayName: 'N', password: 'x'.repeat(16), domainId: 'dA', role: 'HELP_DESK' });
  assert.deepEqual([c.status, c.json['code']], [403, 'FORBIDDEN_ROLE']);
});

test('domains: only the scope, other domains 404', async () => {
  const list = await call('rmA', 'GET', '/domains');
  assert.deepEqual(ids((list.json as Row)['domains']), ['dA']);
  assert.equal((list.json as Row)['total'], 1);
  assert.equal((await call('rmA', 'GET', '/domains/dA')).status, 200);
  assert.deepEqual((await call('rmA', 'GET', '/domains/dB')).json, NOT_FOUND);
  assert.deepEqual((await call('rmA', 'GET', '/domains/dB/dns-check')).json, NOT_FOUND);
});

test('shared mailboxes: list, 404, create and grantee in scope', async () => {
  assert.deepEqual(ids((await call('hdA', 'GET', '/shared-mailboxes')).json['items']), ['smA']);
  assert.deepEqual((await call('hdA', 'GET', '/shared-mailboxes/smB')).json, NOT_FOUND);
  const c = await call('rmA', 'POST', '/shared-mailboxes', { email: 'x@b.example', displayName: 'X', domainId: 'dB' });
  assert.deepEqual([c.status, c.json['code']], [403, OUT_OF_SCOPE]);
  const g = await call('rmA', 'POST', '/shared-mailboxes/smA/permissions', { userId: 'ub1', permissions: ['FULL_ACCESS'] });
  assert.deepEqual([g.status, g.json['error']], [404, 'User not found']);
});

test('10.0: the room/equipment admin API is gone', async () => {
  for (const [method, path] of [['GET', '/resources'], ['POST', '/resources'], ['GET', '/ems/resource-mailboxes']] as const) {
    assert.equal((await call('org', method, path, method === 'POST' ? {} : undefined)).status, 404, `${method} ${path}`);
  }
});

test('aliases: alias domain and target must be in scope', async () => {
  assert.deepEqual(ids((await call('hdA', 'GET', '/aliases')).json), ['alA', 'alAdm']);
  assert.deepEqual((await call('rmA', 'PATCH', '/aliases/alB', { active: false })).json, NOT_FOUND);
  assert.deepEqual((await call('rmA', 'DELETE', '/aliases/alMix')).json, NOT_FOUND, 'target mailbox in another domain');
  assert.deepEqual((await call('rmA', 'GET', '/mailboxes/ub1/aliases')).json, NOT_FOUND);
  const c = await call('rmA', 'POST', '/mailboxes/ua1/aliases', { address: 'z@b.example' });
  assert.deepEqual([c.status, c.json['code']], [403, OUT_OF_SCOPE]);
});

test('mobile devices: list and 404', async () => {
  assert.deepEqual(ids((await call('hdA', 'GET', '/mobile/devices')).json['items']), ['devA', 'devAdm']);
  assert.deepEqual((await call('rmA', 'PATCH', '/mobile/devices/devB/status', { status: 'BLOCKED' })).json, NOT_FOUND);
});

// ── review fixes (9.5 review) ────────────────────────────────────────────────

test('review: devices and aliases of admin accounts are ORGANIZATION_MANAGEMENT-only', async () => {
  for (const [m, p, b] of [
    ['POST', '/mobile/devices/devAdm/wipe', {}], ['PATCH', '/mobile/devices/devAdm/status', { status: 'BLOCKED' }],
    ['DELETE', '/mobile/devices/devAdm', undefined],
    ['DELETE', '/aliases/alAdm', undefined], ['PATCH', '/aliases/alAdm', { active: false }],
    ['POST', '/mailboxes/adminA/aliases', { localPart: 'boss2' }],
  ] as const) {
    const r = await call('rmA', m, p, b);
    assert.deepEqual([r.status, r.json['code']], [403, 'FORBIDDEN_ROLE'], `${m} ${p}`);
  }
  assert.equal((await call('rmOrg', 'POST', '/mobile/devices/devAdm/wipe', {})).status, 403, 'also for unscoped recipient admins');
  assert.equal((await call('rmA', 'PATCH', '/mobile/devices/devA/status', { status: 'OK' })).status, 200, 'USER devices stay manageable');
  assert.equal((await call('org', 'PATCH', '/mobile/devices/devAdm/status', { status: 'OK' })).status, 200);
});

test('review: shared-mailbox permissions — no self-grant except ORGANIZATION_MANAGEMENT', async () => {
  const self = await call('rmA', 'POST', '/shared-mailboxes/smA/permissions', { userId: 'rmA', permissions: ['FULL_ACCESS'] });
  assert.deepEqual([self.status, self.json['code']], [403, 'FORBIDDEN_ROLE'], 'scoped recipient admin, grantee itself (in scope)');
  const selfOrg = await call('rmOrg', 'POST', '/shared-mailboxes/smB/permissions', { userId: 'rmOrg', permissions: ['READ_ONLY'] });
  assert.deepEqual([selfOrg.status, selfOrg.json['code']], [403, 'FORBIDDEN_ROLE'], 'unscoped recipient admin as well');
  const hd = await call('hdA', 'POST', '/shared-mailboxes/smA/permissions', { userId: 'ua1', permissions: ['READ_ONLY'] });
  assert.equal(hd.status, 403, 'HELP_DESK has no recipients write');
  const other = await call('rmA', 'POST', '/shared-mailboxes/smA/permissions', { userId: 'ua1', permissions: ['READ_ONLY'] });
  assert.equal(other.status, 201, 'in-scope recipient admin grants an in-scope user');
  const org = await call('org', 'POST', '/shared-mailboxes/smA/permissions', { userId: 'org', permissions: ['READ_ONLY'] });
  assert.equal(org.status, 201, 'ORGANIZATION_MANAGEMENT may grant itself');
  const selfDelegate = await call('rmA', 'POST', '/mailboxes/ua1/delegates', { granteeId: 'rmA', permission: 'FULL_ACCESS' });
  assert.deepEqual([selfDelegate.status, selfDelegate.json['code']], [403, 'FORBIDDEN_ROLE'], 'delegations: same rule');
});

test('review: no existence oracle for addresses of other domains', async () => {
  // mailbox create: an existing and an unknown address of another domain answer alike
  const taken = await call('rmA', 'POST', '/mailboxes', { email: 'ub1@b.example', displayName: 'N', password: 'x'.repeat(16), domainId: 'dB' });
  const free = await call('rmA', 'POST', '/mailboxes', { email: 'free@b.example', displayName: 'N', password: 'x'.repeat(16), domainId: 'dB' });
  assert.deepEqual([taken.status, taken.json], [free.status, free.json]);
  assert.equal(taken.json['code'], OUT_OF_SCOPE);
  // sender lists: a USER target of another domain is refused before the lookup
  const entry = (target: string) => ({ listType: 'BLOCK', scope: 'USER', target, patternType: 'EXACT', pattern: 'o@spam.test' });
  const known = await call('hyA', 'POST', '/security/sender-lists', entry('ub1@b.example'));
  const unknown = await call('hyA', 'POST', '/security/sender-lists', entry('nobody@b.example'));
  assert.deepEqual([known.status, known.json], [unknown.status, unknown.json]);
  assert.equal(known.json['code'], OUT_OF_SCOPE);
  const imp = await call('hyA', 'POST', '/security/sender-lists/import', {
    csv: 'listType,scope,target,patternType,pattern,comment,active\nBLOCK,USER,ub1@b.example,EXACT,i@spam.test,,true\nBLOCK,USER,nobody@b.example,EXACT,i@spam.test,,true\n',
  });
  const rowErrors = ((imp.json as Row)['errors'] as Row[]).map((e) => e['error']);
  assert.deepEqual(rowErrors, [rowErrors[0], rowErrors[0]], 'both import rows fail alike');
  assert.match(String(rowErrors[0]), /management scope/);
});

test('review: targetNamedInScope (pure)', async () => {
  const { targetNamedInScope } = await import('./security-sender-lists.js');
  const scope = { kind: 'domains' as const, domains: [{ id: 'dA', name: 'a.example' }] };
  assert.equal(targetNamedInScope(scope, 'GLOBAL', ''), false);
  assert.equal(targetNamedInScope(scope, 'DOMAIN', 'A.Example'), true);
  assert.equal(targetNamedInScope(scope, 'DOMAIN', 'b.example'), false);
  assert.equal(targetNamedInScope(scope, 'USER', 'u@a.example'), true);
  assert.equal(targetNamedInScope(scope, 'USER', 'u@sub.a.example'), false);
  assert.equal(targetNamedInScope({ kind: 'organisation' }, 'GLOBAL', ''), true);
});

test('sender lists: DOMAIN / USER entries of the scope only; GLOBAL and other domains refused', async () => {
  assert.deepEqual(ids((await call('hyA', 'GET', '/security/sender-lists')).json), ['dmA', 'usA']);
  const glob = await call('hyA', 'POST', '/security/sender-lists', { listType: 'BLOCK', scope: 'GLOBAL', target: '', patternType: 'EXACT', pattern: 'n@spam.test' });
  assert.deepEqual([glob.status, glob.json['code']], [403, OUT_OF_SCOPE]);
  const other = await call('hyA', 'POST', '/security/sender-lists', { listType: 'BLOCK', scope: 'DOMAIN', target: 'b.example', patternType: 'EXACT', pattern: 'n@spam.test' });
  assert.deepEqual([other.status, other.json['code']], [403, OUT_OF_SCOPE]);
  const own = await call('hyA', 'POST', '/security/sender-lists', { listType: 'BLOCK', scope: 'DOMAIN', target: 'a.example', patternType: 'EXACT', pattern: 'n@spam.test' });
  assert.equal(own.status, 201);
  assert.deepEqual((await call('hyA', 'DELETE', '/security/sender-lists/dmB')).json, NOT_FOUND);
  assert.deepEqual((await call('hyA', 'PATCH', '/security/sender-lists/gl', { active: false })).json, NOT_FOUND);
  const imp = await call('hyA', 'POST', '/security/sender-lists/import', { csv: 'listType,scope,target,patternType,pattern,comment,active\nBLOCK,DOMAIN,b.example,EXACT,i@spam.test,,true\n' });
  assert.equal(imp.status, 400, 'import rows outside the scope are row errors');
  assert.match(JSON.stringify(imp.json), /management scope/);
});

test('hygiene: everything but sender lists and quarantine is organisation-wide only', async () => {
  for (const p of ['/security/settings', '/security/capabilities', '/security/spoofing', '/security/attacks', '/transport-rules', '/security/dnsbl', '/security/protection/rules', '/security/protection/locks']) {
    const r = await call('hyA', 'GET', p);
    assert.deepEqual([r.status, r.json['code']], [403, 'SCOPE_ORG_ONLY'], p);
  }
});

test('quarantine: visible by first recipient, actions need every recipient in scope', async () => {
  assert.deepEqual(ids((await call('hyA', 'GET', '/quarantine')).json['items']), ['qA', 'qMix']);
  assert.equal((await call('hyA', 'GET', '/quarantine/stats')).json['total'], 2);
  assert.deepEqual((await call('hyA', 'GET', '/quarantine/qB')).json, NOT_FOUND);
  const mix = await call('hyA', 'DELETE', '/quarantine/qMix');
  assert.deepEqual([mix.status, mix.json['code']], [403, OUT_OF_SCOPE]);
  assert.equal((await call('hyA', 'DELETE', '/quarantine/qA')).status, 204);
  const bulk = await call('hyA', 'DELETE', '/quarantine', {});
  assert.deepEqual([bulk.status, bulk.json['code']], [403, 'SCOPE_ORG_ONLY']);
});

test('audit log: entries about targets in scope only; stats / anomalies organisation-wide only', async () => {
  const list = await call('coA', 'GET', '/audit-log');
  const got = ((list.json as Row)['entries'] as Row[]).map((e) => e['id']).filter((x) => String(x).startsWith('au')).sort();
  assert.deepEqual(got, ['au1', 'au3'], 'user of dA by id, address of dA by name — not dB');
  const json = await call('coA', 'GET', '/audit-log/export.json');
  assert.ok(!JSON.stringify(json.json).includes('"ub1"'), 'exports follow the scope');
  for (const p of ['/audit-log/stats', '/audit-log/anomalies']) {
    assert.deepEqual((await call('coA', 'GET', p)).json['code'], 'SCOPE_ORG_ONLY', p);
  }
  assert.equal((await call('org', 'GET', '/audit-log')).json['total'] as number >= 4, true);
});

test('message trace (mail-flow log): only flows of the scope; retention organisation-wide only', async () => {
  const r = await call('coA', 'GET', '/message-trace');
  assert.deepEqual(ids(r.json['items']), ['lA']);
  assert.equal(r.json['total'], 1);
  assert.deepEqual((await call('coA', 'GET', '/compliance/retention')).json['code'], 'SCOPE_ORG_ONLY');
});

test('server-wide areas are closed to scoped admins (also through narrow actions)', async () => {
  for (const [actor, p] of [['voA', '/servers/settings'], ['voA', '/logs'], ['voA', '/certificates'], ['voA', '/settings'],
    ['voA', '/ldap'], ['coA', '/backups/jobs'], ['voA', '/protocol-access'], ['voA', '/organisation/role-assignments'], ['rmA', '/ems/mailboxes']] as const) {
    const r = await call(actor, 'GET', p);
    assert.equal(r.status, 403, `${actor} GET ${p}`);
  }
});

test('protocol access / webmail policies: user and domain level inside the scope only', async () => {
  assert.equal((await call('rmA', 'GET', '/protocol-access/users/ua1')).status, 200);
  assert.deepEqual((await call('rmA', 'GET', '/protocol-access/users/ub1')).json, NOT_FOUND);
  assert.equal((await call('rmA', 'GET', '/protocol-access/domains/dA')).status, 200);
  assert.deepEqual((await call('rmA', 'GET', '/protocol-access/domains/dB')).json, NOT_FOUND);
  assert.deepEqual((await call('rmA', 'GET', '/webmail-policies/users/ub1')).json, NOT_FOUND);
  assert.deepEqual((await call('rmA', 'GET', '/webmail-policies/domains/dB')).json, NOT_FOUND);
});

test('dashboard: organisation-wide widgets are off for scoped admins', () => {
  // (the route itself needs the outbound queue; its domain filters use the helpers tested in lib/admin-scope.test.ts)
  assert.equal(dashboardSections('COMPLIANCE_MANAGEMENT').audit, true);
  const scoped = dashboardSections('COMPLIANCE_MANAGEMENT', true);
  assert.deepEqual([scoped.audit, scoped.logins, scoped.mailFlowErrors], [false, false, false]);
  assert.equal(dashboardSections('VIEW_ONLY_ORG', true).errors, false, 'servers area');
  assert.equal(dashboardSections('HYGIENE_MANAGEMENT', true).attacks, false);
  assert.equal(dashboardSections('HELP_DESK', true).storageUsers, true, 'recipients of the own domains');
});

test('scope assignment: ORGANIZATION_MANAGEMENT only — no escalation', async () => {
  const rm = await call('rmOrg', 'PUT', '/organisation/role-assignments/rmA/scope', { domainIds: [] });
  assert.equal(rm.status, 403, 'an unscoped RECIPIENT_MANAGEMENT cannot widen a scope');
  const self = await call('hdA', 'PUT', '/organisation/role-assignments/hdA/scope', { domainIds: ['dA', 'dB'] });
  assert.equal(self.status, 403, 'nobody widens its own scope');
  const notScopable = await call('org', 'PUT', '/organisation/role-assignments/adminA/scope', { domainIds: ['dA'] });
  assert.deepEqual([notScopable.status, notScopable.json['code']], [400, 'ROLE_NOT_SCOPABLE']);
  const orgTarget = await call('org', 'PUT', '/organisation/role-assignments/org/scope', { domainIds: ['dA'] });
  assert.deepEqual([orgTarget.status, orgTarget.json['code']], [400, 'ROLE_NOT_SCOPABLE'], 'ORGANIZATION_MANAGEMENT stays organisation-wide');
  const unknown = await call('org', 'PUT', '/organisation/role-assignments/hdA/scope', { domainIds: ['nope'] });
  assert.deepEqual([unknown.status, unknown.json['code']], [400, 'UNKNOWN_DOMAIN']);
});

test('scope assignment: audited, sessions revoked, the admin sees the new scope at once', async () => {
  assert.deepEqual(ids((await call('hdA', 'GET', '/shared-mailboxes')).json['items']), ['smA']); // cached scope dA
  events.length = 0;
  const r = await call('org', 'PUT', '/organisation/role-assignments/hdA/scope', { domainIds: ['dA', 'dB'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json['scope'], { kind: 'domains', domains: [{ id: 'dA', name: 'a.example' }, { id: 'dB', name: 'b.example' }] });
  const entry = db['auditLog']!.find((e) => e['action'] === 'user.role.scope' && e['targetId'] === 'hdA');
  assert.ok(entry, 'audited');
  assert.deepEqual((entry['changes'] as Row)['after'], { domains: ['a.example', 'b.example'] });
  assert.ok(events.some((e) => e.userId === 'hdA' && e.reason === 'scope-change'), 'publishUserAuthChange via revokeAllSessions');
  assert.deepEqual(ids((await call('hdA', 'GET', '/shared-mailboxes')).json['items']), ['smA', 'smB'], 'role/scope cache dropped');
  const list = await call('org', 'GET', '/organisation/role-assignments');
  assert.deepEqual((list.json.find((u) => u['id'] === 'hdA') as Row)['scope'], r.json['scope']);
  // back to dA only; clearing to [] would make the account organisation-wide
  assert.equal((await call('org', 'PUT', '/organisation/role-assignments/hdA/scope', { domainIds: ['dA'] })).status, 200);
  // review: narrowing takes effect at once as well (the open session sees dB disappear)
  assert.deepEqual(ids((await call('hdA', 'GET', '/shared-mailboxes')).json['items']), ['smA']);
  assert.deepEqual((await call('hdA', 'GET', '/shared-mailboxes/smB')).json, NOT_FOUND);
});

test('event stream: scoped admins never join the organisation-wide admin feed (security:attack)', async () => {
  const { EventEmitter } = await import('node:events');
  const { createSseHandler } = await import('../../sse.js');
  const joined: Array<{ userId: string; isAdmin: boolean }> = [];
  const handler = createSseHandler({
    start: () => undefined,
    addClient: (c) => { joined.push({ userId: c.userId, isAdmin: c.isAdmin }); return () => undefined; },
    register: () => () => undefined,
    heartbeatMs: 60_000,
  });
  // review: voA with a token claiming ORGANIZATION_MANAGEMENT (issued before a demotion) — the
  // database role and scope decide, as on every admin route
  const reqs = [['org', roleOf('org')], ['hyA', roleOf('hyA')], ['ua1', roleOf('ua1')], ['voA', 'ORGANIZATION_MANAGEMENT']].map(([id, role]) => {
    const req = Object.assign(new EventEmitter(), { apiUser: { userId: id, email: `${id}@a.example`, role } });
    const res = { setHeader: () => undefined, flushHeaders: () => undefined, write: () => true, end: () => undefined };
    void handler(req as never, res as never);
    return req;
  });
  await new Promise((r) => setTimeout(r, 50));
  for (const r of reqs) r.emit('close');
  assert.deepEqual(joined.filter((j) => j.isAdmin).map((j) => j.userId), ['org']);
});

test('a domain that still scopes an admin cannot be deleted', async () => {
  const r = await call('org', 'DELETE', '/domains/dB');
  // dB has mailboxes too; drop them from the check by asking for a domain only an admin scope references
  db['domain']!.push({ id: 'dC', name: 'c.example', active: true, primary: false, dkimSelector: 'coremail', dkimPrivateKey: 'k', createdAt: new Date() });
  db['adminScope']!.push({ id: 'sc-x', userId: 'voA', domainId: 'dC', domain: { id: 'dC', name: 'c.example' } });
  const c = await call('org', 'DELETE', '/domains/dC');
  assert.deepEqual([c.status, c.json['code']], [409, 'DOMAIN_SCOPES_ADMINS']);
  assert.equal(r.status, 409);
});
