/**
 * w3 scope leaks — detail views of in-scope objects never show a domain-scoped
 * admin the addresses of other hosted domains (lib/admin-scope.ts
 * addressRedactor via middleware/admin-scope.ts redactorOf): delegation and
 * shared-mailbox grantees, folder-permission grantees, other quarantine
 * recipients, mail-flow rows, audit entries (target name lists, actor,
 * `changes`) incl. CSV / JSON / PDF exports; text filters run on the redacted
 * data (no search oracle). Organisation-wide admins see everything unchanged.
 * In-memory Prisma (test-support/memory-model.ts); domains a.example (dA,
 * the scope) and b.example (dB, another tenant).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/scope-redaction.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';
import { memoryModel, type Row } from '../../test-support/memory-model.js';

setTestEnv();

const dA = { id: 'dA', name: 'a.example', active: true };
const dB = { id: 'dB', name: 'b.example', active: true };
const user = (id: string, role: string, domain: typeof dA): Row => ({
  id, email: `${id}@${domain.name}`, displayName: `Name ${id}`, role, active: true, domainId: domain.id,
  quotaBytes: 1000n, usedBytes: 0n, createdAt: new Date(), mailbox: { id: `mb-${id}` },
});
const now = new Date();
const audit = (id: string, extra: Row): Row => ({
  id, timestamp: now, actorId: 'org', actorEmail: 'org@a.example', action: 'mailboxes.put', targetType: 'mailboxes',
  targetId: null, targetName: null, ipAddress: null, userAgent: null, changes: null, success: true, errorMsg: null, ...extra,
});

const db: Record<string, Row[]> = {
  domain: [dA, dB],
  user: [
    user('org', 'ORGANIZATION_MANAGEMENT', dA),
    user('coA', 'COMPLIANCE_MANAGEMENT', dA),
    user('rmA', 'RECIPIENT_MANAGEMENT', dA),
    user('hyA', 'HYGIENE_MANAGEMENT', dA),
    user('rmOrg', 'RECIPIENT_MANAGEMENT', dB), // unscoped
    user('ua1', 'USER', dA),
    user('ub1', 'USER', dB),
  ],
  adminScope: ['coA', 'rmA', 'hyA'].map((u) => ({ id: `sc-${u}`, userId: u, domainId: 'dA', domain: { id: 'dA', name: 'a.example' } })),
  sharedMailbox: [{
    id: 'smA', email: 'team@a.example', displayName: 'Team A', domainId: 'dA', active: true, mailbox: { id: 'mb-smA' },
    permissions: [
      { id: 'p1', userId: 'ua1', permission: 'FULL_ACCESS', user: { email: 'ua1@a.example', displayName: 'Name ua1' } },
      { id: 'p2', userId: 'ub1', permission: 'SEND_AS', user: { email: 'ub1@b.example', displayName: 'Name ub1' } },
    ],
  }],
  sharedMailboxPerm: [
    { id: 'p1', sharedMailboxId: 'smA', userId: 'ua1', permission: 'FULL_ACCESS', user: { email: 'ua1@a.example', displayName: 'Name ua1' } },
    { id: 'p2', sharedMailboxId: 'smA', userId: 'ub1', permission: 'SEND_AS', user: { email: 'ub1@b.example', displayName: 'Name ub1' } },
  ],
  folder: [{ id: 'fA', mailboxId: 'mb-ua1', name: 'Projekte', displayName: 'Projekte', parentId: null }],
  folderPermission: [
    { folderId: 'fA', mailboxId: 'mb-ua1', granteeKey: 'user:ub1', granteeId: 'ub1', rights: 0x401, applyToSubfolders: false },
    { folderId: 'fA', mailboxId: 'mb-ua1', granteeKey: 'user:rmA', granteeId: 'rmA', rights: 0x401, applyToSubfolders: false },
  ],
  quarantine: [
    { id: 'qMix', messageId: null, fromAddr: 's@spam.test', toAddr: 'ua1@a.example', subject: 'M', reason: 'SPAM', released: false, rawPath: 'q/qM', createdAt: now,
      details: { envelope: { from: 's@spam.test', recipients: ['ua1@a.example', 'ub1@b.example'] } } },
    { id: 'qFromB', messageId: null, fromAddr: 'ub1@b.example', toAddr: 'ua1@a.example', subject: 'Hallo', reason: 'SPAM', released: false, rawPath: 'q/qF', createdAt: now,
      details: { envelope: { from: 'ub1@b.example', recipients: ['ua1@a.example'] } } },
  ],
  auditLog: [
    // a ", " list that ends in an in-scope address (the pre-w3 filter matched it and showed every address)
    audit('auList', { action: 'quarantine.release', targetType: 'quarantine', targetId: 'q-x', targetName: 'ub1@b.example, ua1@a.example' }),
    // an in-scope address first — matched since w3 as well
    audit('auFirst', { action: 'quarantine.release', targetType: 'quarantine', targetId: 'q-y', targetName: 'ua1@a.example, ub1@b.example' }),
    // an entry about an in-scope object whose details name another domain
    audit('auChanges', {
      action: 'mailbox.delegate.grant', targetType: 'mailbox', targetId: 'ua1', targetName: 'ua1@a.example', actorEmail: 'boss@b.example',
      changes: { owner: 'ua1@a.example', grantee: 'ub1@b.example', granteeId: 'ub1' }, errorMsg: 'notify ub1@b.example failed',
    }),
    audit('auForeign', { targetId: 'ub1', targetName: 'ub1@b.example' }),
    // a domain whose name only starts like the scope's domain
    audit('auLookalike', { targetId: 'q-z', targetName: 'x@a.example.evil, y@b.example' }),
  ],
  systemLog: [
    { id: 'lMix', category: 'MAIL_FLOW', timestamp: now, level: 'INFO', message: 'delivered to ub1@b.example', userId: null,
      metadata: { sender: 'ext@other.test', recipient: 'ua1@a.example, ub1@b.example', subject: 'Angebot', status: 'DELIVERED', messageId: 'm1' } },
  ],
  session: [],
};
const settings = { id: 'singleton', requireMfaForAdmins: false, auditLogEnabled: true };

const models: Record<string, Record<string, (...a: unknown[]) => unknown>> = Object.fromEntries(
  Object.entries(db).map(([name, rows]) => [name, memoryModel(rows)]),
);
models['serverSettings'] = { findUnique: () => ({ ...settings }) };
models['mailbox'] = {
  findUnique: (a) => {
    const userId = String((a as { where: Row }).where['userId']);
    return {
      id: `mb-${userId}`,
      delegates: userId === 'ua1'
        ? [
          { id: 'd1', granteeId: 'ub1', permission: 'READ_ONLY', grantee: { id: 'ub1', email: 'ub1@b.example', displayName: 'Name ub1' } },
          { id: 'd2', granteeId: 'rmA', permission: 'FULL_ACCESS', grantee: { id: 'rmA', email: 'rmA@a.example', displayName: 'Name rmA' } },
        ]
        : [],
    };
  },
};
installFakePrisma(models);

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { redactAuditEntry, matchesAuditText } = await import('./audit-log.js');
const { quarantineSearchWhere } = await import('./quarantine.js');
const { addressRedactor, scopeFromRows, NO_REDACTION } = await import('../../lib/admin-scope.js');

const roleOf = (id: string): string => String(db['user']!.find((u) => u['id'] === id)?.['role']);
const tok = (id: string) => core.signAccessToken({
  sub: id, email: String(db['user']!.find((u) => u['id'] === id)?.['email']), role: roleOf(id) as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'dA', sessionId: `${id}-s`, mfaVerified: true,
});

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

async function call(actor: string, path: string): Promise<{ status: number; text: string; json: Row }> {
  const r = await fetch(`${base}/api/v1/admin${path}`, { headers: { authorization: `Bearer ${tok(actor)}` } });
  const text = await r.text();
  let json: unknown = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json: json as Row };
}
const OTHER = '(andere Domain)';
const leaks = (text: string): boolean => /ub1@b\.example|boss@b\.example|Name ub1/.test(text);

test('audit log: list entries carry no address of another domain; lists ending in scope no longer leak', async () => {
  const r = await call('coA', '/audit-log');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries((r.json['entries'] as Row[]).map((e) => [e['id'], e]));
  assert.deepEqual(Object.keys(byId).sort(), ['auChanges', 'auFirst', 'auList'], 'no foreign or look-alike entries');
  assert.equal(byId['auList']!['targetName'], `${OTHER}, ua1@a.example`);
  assert.equal(byId['auFirst']!['targetName'], `ua1@a.example, ${OTHER}`);
  assert.equal(byId['auChanges']!['actorEmail'], OTHER);
  assert.deepEqual(byId['auChanges']!['changes'], { owner: 'ua1@a.example', grantee: OTHER, granteeId: 'ub1' });
  assert.equal(byId['auChanges']!['errorMsg'], `notify ${OTHER} failed`);
  assert.ok(!leaks(r.text), r.text);
  // an organisation-wide admin sees the entries unchanged
  const o = await call('org', '/audit-log');
  assert.equal((o.json['entries'] as Row[]).length, 5);
  assert.ok(o.text.includes('boss@b.example') && o.text.includes('ub1@b.example, ua1@a.example'));
});

test('audit log: a scoped text search matches the redacted entries only (no search oracle)', async () => {
  for (const q of ['searchText=ub1%40b', 'actorEmail=boss', 'searchText=Name%20ub1']) {
    const r = await call('coA', `/audit-log?${q}`);
    assert.deepEqual([r.status, r.json['total'], r.json['entries']], [200, 0, []], q);
  }
  const visible = await call('coA', '/audit-log?searchText=ua1%40a');
  assert.deepEqual((visible.json['entries'] as Row[]).map((e) => e['id']).sort(), ['auChanges', 'auFirst', 'auList']);
  assert.equal(visible.json['total'], 3);
  const page = await call('coA', '/audit-log?searchText=ua1%40a&limit=1&offset=1');
  assert.deepEqual([(page.json['entries'] as Row[]).length, page.json['total']], [1, 3]);
  // organisation-wide: the database filter as before
  assert.equal((await call('org', '/audit-log?searchText=ub1%40b')).json['total'], 4);
});

test('audit log: CSV / JSON / PDF exports are redacted as well; statistics stay organisation-wide only', async () => {
  for (const ext of ['csv', 'json']) {
    const r = await call('coA', `/audit-log/export.${ext}`);
    assert.equal(r.status, 200, ext);
    assert.ok(!leaks(r.text), `${ext}: ${r.text}`);
    assert.ok(r.text.includes(OTHER), ext);
  }
  const json = await call('coA', '/audit-log/export.json?searchText=ub1%40b');
  assert.equal((json.json['entries'] as Row[]).length, 0, 'export search runs on the redacted entries');
  const pdf = await fetch(`${base}/api/v1/admin/audit-log/export.pdf`, { headers: { authorization: `Bearer ${tok('coA')}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('x-coremail-export-entries'), '3');
  assert.equal((await call('coA', '/audit-log/stats')).json['code'], 'SCOPE_ORG_ONLY');
});

test('delegations, shared-mailbox and folder permissions: grantees of other domains redacted', async () => {
  const del = await call('rmA', '/mailboxes/ua1/delegates');
  assert.equal(del.status, 200);
  assert.deepEqual((del.json as unknown as Row[]).map((d) => [d['granteeId'], (d['grantee'] as Row)['email'], (d['grantee'] as Row)['displayName']]), [
    ['ub1', OTHER, OTHER], ['rmA', 'rmA@a.example', 'Name rmA'],
  ]);
  for (const path of ['/shared-mailboxes/smA', '/shared-mailboxes', '/shared-mailboxes/smA/permissions']) {
    const r = await call('rmA', path);
    assert.equal(r.status, 200, path);
    assert.ok(!leaks(r.text), `${path}: ${r.text}`);
    assert.ok(r.text.includes(OTHER) && r.text.includes('ua1@a.example'), path);
  }
  for (const path of ['/mailboxes/ua1/folder-permissions', '/mailboxes/ua1/folders/fA/permissions']) {
    const r = await call('rmA', path);
    assert.equal(r.status, 200, `${path} ${r.text}`);
    assert.ok(!leaks(r.text), `${path}: ${r.text}`);
    assert.ok(r.text.includes('"user:ub1"') && r.text.includes(OTHER) && r.text.includes('rmA@a.example'), `${path}: ${r.text}`);
  }
  // organisation-wide recipient admin: unchanged
  for (const path of ['/mailboxes/ua1/delegates', '/shared-mailboxes/smA', '/mailboxes/ua1/folders/fA/permissions']) {
    const r = await call('rmOrg', path);
    assert.ok(r.text.includes('ub1@b.example') && !r.text.includes(OTHER), `${path}: ${r.text}`);
  }
});

test('quarantine: other recipients and senders of other domains redacted, search no oracle', async () => {
  const list = await call('hyA', '/quarantine');
  assert.equal(list.status, 200);
  assert.ok(!leaks(list.text), list.text);
  const mix = (list.json['items'] as Row[]).find((i) => i['id'] === 'qMix')!;
  assert.deepEqual(((mix['details'] as Row)['envelope'] as Row)['recipients'], ['ua1@a.example', OTHER]);
  assert.equal((list.json['items'] as Row[]).find((i) => i['id'] === 'qFromB')!['fromAddr'], OTHER);
  const detail = await call('hyA', '/quarantine/qMix');
  assert.equal(detail.status, 200);
  assert.ok(!leaks(detail.text), detail.text);
  assert.deepEqual((await call('hyA', '/quarantine?search=ub1%40b')).json['items'], [], 'a hidden sender is not searchable');
  assert.deepEqual(((await call('hyA', '/quarantine?search=spam.test')).json['items'] as Row[]).map((i) => i['id']), ['qMix'], 'external senders stay searchable');
  assert.equal(((await call('org', '/quarantine?search=ub1%40b')).json['items'] as Row[]).length, 1);
  assert.ok((await call('org', '/quarantine/qMix')).text.includes('ub1@b.example'));
});

test('message trace: rows, CSV export and filters use the redacted rows', async () => {
  const list = await call('coA', '/message-trace');
  assert.equal(list.status, 200);
  const row = (list.json['items'] as Row[])[0]!;
  assert.deepEqual([(row['metadata'] as Row)['recipient'], (row['metadata'] as Row)['sender'], row['message']], [
    `ua1@a.example, ${OTHER}`, 'ext@other.test', `delivered to ${OTHER}`,
  ]);
  assert.equal((await call('coA', '/message-trace?recipient=ub1')).json['total'], 0, 'no filter oracle');
  assert.equal((await call('coA', '/message-trace?recipient=ua1')).json['total'], 1);
  const csv = await call('coA', '/message-trace/export');
  assert.ok(!leaks(csv.text) && csv.text.includes(OTHER), csv.text);
  assert.equal((await call('org', '/message-trace?recipient=ub1')).json['total'], 1);
});

test('pure: redactAuditEntry, matchesAuditText, quarantineSearchWhere', () => {
  const scoped = addressRedactor(scopeFromRows('COMPLIANCE_MANAGEMENT', [{ id: 'dA', name: 'a.example' }]), ['a.example', 'b.example']);
  const entry = { action: 'x', actorEmail: 'boss@b.example', targetName: 'ua1@a.example', errorMsg: null, changes: { to: ['ub1@b.example'] } };
  const red = redactAuditEntry(scoped, entry);
  assert.deepEqual(red, { action: 'x', actorEmail: OTHER, targetName: 'ua1@a.example', errorMsg: null, changes: { to: [OTHER] } });
  assert.equal(redactAuditEntry(NO_REDACTION, entry), entry);
  assert.equal(matchesAuditText(red, { searchText: 'boss' }), false);
  assert.equal(matchesAuditText(red, { searchText: 'UA1@' }), true);
  assert.equal(matchesAuditText(red, { actorEmail: 'andere' }), true);
  assert.deepEqual(quarantineSearchWhere('q', NO_REDACTION)['OR'], [
    { fromAddr: { contains: 'q', mode: 'insensitive' } },
    { toAddr: { contains: 'q', mode: 'insensitive' } },
    { subject: { contains: 'q', mode: 'insensitive' } },
  ], 'organisation-wide: unchanged');
  // review: the hidden sender's domain in every spelling the database may hold
  const idn = addressRedactor(scopeFromRows('HYGIENE_MANAGEMENT', [{ id: 'dA', name: 'a.example' }]), ['a.example', 'bücher.example']);
  const excluded = ((((quarantineSearchWhere('x', idn)['OR'] as Row[])[0]!['AND'] as Row[])[1]!['NOT'] as Row)['OR'] as Row[])
    .map((c) => (c['fromAddr'] as Row)['endsWith']);
  assert.deepEqual(excluded.sort(), ['@bücher.example', '@bücher.example.', '@xn--bcher-kva.example', '@xn--bcher-kva.example.']);
});
