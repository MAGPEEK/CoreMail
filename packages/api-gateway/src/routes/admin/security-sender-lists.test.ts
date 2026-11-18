/**
 * 9.4: BCP → Protection → Sender lists (CRUD, CSV import/export, audit, hygiene RBAC)
 * and → Spoofing (BCP settings with the environment override, validation, reload).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/security-sender-lists.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let lists: Row[] = [];
let security: Row = {};
const audits: Row[] = [];
let seq = 0;
const DOMAINS = [{ id: 'd1', name: 'corp.test' }, { id: 'd2', name: 'bücher.example' }];
const MAILBOXES = [{ id: 'u1', email: 'bob@corp.test' }];

const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
  return row[k] === v;
});

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      if (q.where['email']) return applySelect(MAILBOXES.find((m) => m.email === q.where['email']) ?? null, q.select);
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
    findMany: (a) => MAILBOXES.filter((m) => matches(m, (a as { where: Row }).where)),
    findFirst: (a) => applySelect(MAILBOXES.find((m) => matches(m, (a as { where: Row }).where)) ?? null, (a as { select?: Row }).select),
  },
  domain: {
    findUnique: (a) => DOMAINS.find((d) => d.name === (a as { where: Row }).where['name']) ?? null,
    findMany: (a) => DOMAINS.filter((d) => matches(d, (a as { where: Row }).where)),
    findFirst: (a) => DOMAINS.find((d) => matches(d, (a as { where: Row }).where)) ?? null,
  },
  blacklist: {
    findMany: (a) => lists.filter((r) => matches(r, (a as { where: Row }).where)),
    findFirst: (a) => lists.find((r) => matches(r, (a as { where: Row }).where)) ?? null,
    findUnique: (a) => { const r = lists.find((x) => x['id'] === (a as { where: Row }).where['id']); return r ? { ...r } : null; },
    create: (a) => { const row = { id: `bl${++seq}`, createdAt: new Date(0), ...(a as { data: Row }).data }; lists.push(row); return row; },
    createMany: (a) => { for (const d of (a as { data: Row[] }).data) lists.push({ id: `bl${++seq}`, createdAt: new Date(0), ...d }); return { count: 0 }; },
    update: (a) => { const q = a as { where: Row; data: Row }; const row = lists.find((r) => r['id'] === q.where['id'])!; Object.assign(row, q.data); return row; },
    delete: (a) => { lists = lists.filter((r) => r['id'] !== (a as { where: Row }).where['id']); return {}; },
  },
  securitySettings: {
    findUnique: () => ({ ...security }),
    upsert: (a) => { Object.assign(security, (a as { update: Row }).update); return { ...security }; },
  },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminSecurityRouter } = await import('./security.js');

const token = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/security', requireAuth, adminSecurityRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/security`;
});
after(() => server?.close());
beforeEach(() => {
  lists = [{ id: 'junk1', scope: 'USER-JUNK', scopeId: 'u1', pattern: 'x@y.z', patternType: 'EXACT', listType: 'BLOCK', comment: '', active: true }];
  security = { localSpoofAction: 'policy', localSpoofAllow: [], arcTrustedSealers: [] };
  audits.length = 0;
  for (const v of ['LOCAL_SPOOF_ACTION', 'LOCAL_SPOOF_ALLOW', 'ARC_TRUSTED_SEALERS']) delete process.env[v];
});

const call = (method: string, path: string, role = 'HYGIENE_MANAGEMENT', body?: unknown) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${token(role)}`, 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const flush = () => new Promise((r) => setTimeout(r, 30));

test('create → list with target names; duplicates 409; webmail Junk entries are not listed', async () => {
  const c1 = await call('POST', '/sender-lists', undefined, { listType: 'BLOCK', scope: 'GLOBAL', patternType: 'WILDCARD', pattern: '*@Spam.Example' });
  assert.equal(c1.status, 201);
  const c2 = await call('POST', '/sender-lists', undefined, { listType: 'ALLOW', scope: 'USER', target: 'bob@corp.test', pattern: 'boss@spam.example' });
  assert.equal(c2.status, 201);
  assert.equal((await call('POST', '/sender-lists', undefined, { scope: 'DOMAIN', target: 'nope.test', pattern: 'a@b.c' })).status, 400);
  assert.equal((await call('POST', '/sender-lists', undefined, { patternType: 'WILDCARD', pattern: '*@spam.example' })).status, 409);
  const list = await (await call('GET', '/sender-lists', 'VIEW_ONLY_ORG')).json() as Row[];
  assert.deepEqual(list.map((r) => [r['listType'], r['scope'], r['target'], r['pattern']]), [
    ['BLOCK', 'GLOBAL', '', '*@spam.example'], ['ALLOW', 'USER', 'bob@corp.test', 'boss@spam.example'],
  ]);
  await flush();
  const created = audits.filter((a) => a['action'] === 'security.sender-list.create');
  assert.equal(created.length, 2);
  assert.deepEqual(created[1]!['changes'], { listType: 'ALLOW', scope: 'USER', target: 'bob@corp.test', patternType: 'EXACT', pattern: 'boss@spam.example' });
});

test('patch / delete with audit diff; USER-JUNK rows are not reachable; invalid patch refused', async () => {
  const id = (await (await call('POST', '/sender-lists', undefined, { pattern: 'a@spam.example' })).json() as Row)['id'] as string;
  assert.equal((await call('PATCH', `/sender-lists/${id}`, undefined, { active: false, comment: 'paused' })).status, 200);
  assert.equal((await call('PATCH', `/sender-lists/${id}`, undefined, { patternType: 'WILDCARD' })).status, 400, 'a@… has no *');
  assert.equal((await call('PATCH', `/sender-lists/${id}`, undefined, { scope: 'USER' })).status, 400, 'strict schema');
  // review fix: a patch must not create a duplicate of another entry
  const other = (await (await call('POST', '/sender-lists', undefined, { pattern: 'b@spam.example' })).json() as Row)['id'] as string;
  assert.equal((await call('PATCH', `/sender-lists/${other}`, undefined, { pattern: 'A@spam.example' })).status, 409);
  assert.equal((await call('PATCH', `/sender-lists/${other}`, undefined, { pattern: 'b@spam.example', comment: 'same' })).status, 200, 'its own identity is no clash');
  assert.equal((await call('DELETE', `/sender-lists/${other}`)).status, 200);
  assert.equal((await call('PATCH', '/sender-lists/junk1', undefined, { active: false })).status, 404);
  assert.equal((await call('DELETE', '/sender-lists/junk1')).status, 404);
  assert.equal((await call('DELETE', `/sender-lists/${id}`)).status, 200);
  await flush();
  assert.deepEqual(audits.find((a) => a['action'] === 'security.sender-list.update')!['changes'], {
    pattern: 'a@spam.example', comment: { from: '', to: 'paused' }, active: { from: 'true', to: 'false' },
  });
  assert.ok(audits.some((a) => a['action'] === 'security.sender-list.delete' && a['targetId'] === id));
});

test('CSV export → import: all-or-nothing validation, duplicates skipped, audited', async () => {
  await call('POST', '/sender-lists', undefined, { patternType: 'WILDCARD', pattern: '*@spam.example', comment: 'bulk, promo' });
  const exp = await call('GET', '/sender-lists/export.csv', 'VIEW_ONLY_ORG');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await exp.text();
  assert.match(csv, /^listType,scope,target,patternType,pattern,comment,active\r\nBLOCK,GLOBAL,,WILDCARD,\*@spam\.example,"bulk, promo",true\r\n$/);

  const bad = `${csv}ALLOW,DOMAIN,unknown.test,EXACT,a@b.c,,true\r\nBLOCK,GLOBAL,,EXACT,*broken,,true\r\n`;
  const refused = await call('POST', '/sender-lists/import', undefined, { csv: bad });
  assert.equal(refused.status, 400);
  assert.deepEqual(((await refused.json()) as { errors: Array<{ line: number }> }).errors.map((e) => e.line), [3, 4]);
  assert.equal(lists.filter((r) => r['scope'] !== 'USER-JUNK').length, 1, 'nothing written');

  const good = `${csv}ALLOW,DOMAIN,corp.test,EXACT,ceo@partner.example,,true\r\n`;
  const ok = await call('POST', '/sender-lists/import', undefined, { csv: good });
  assert.deepEqual(await ok.json(), { created: 1, skipped: 1 });
  assert.ok(lists.some((r) => r['scope'] === 'DOMAIN' && r['scopeId'] === 'd1' && r['listType'] === 'ALLOW'));
  await flush();
  assert.equal(audits.find((a) => a['action'] === 'security.sender-list.import')!['targetId'], 'csv');
});

test('hygiene RBAC: read-only roles may read and export, not change', async () => {
  assert.equal((await call('POST', '/sender-lists', 'VIEW_ONLY_ORG', { pattern: 'a@b.c' })).status, 403);
  assert.equal((await call('POST', '/sender-lists/import', 'VIEW_ONLY_ORG', { csv: 'pattern\na@b.c\n' })).status, 403);
  assert.equal((await call('GET', '/sender-lists', 'USER')).status, 403);
  assert.equal((await call('PUT', '/spoofing', 'HELP_DESK', { localSpoofAction: 'junk' })).status, 403);
});

test('spoofing: GET shows stored + effective values and environment overrides', async () => {
  security = { localSpoofAction: 'junk', localSpoofAllow: ['198.51.100.0/24'], arcTrustedSealers: [] };
  process.env['ARC_TRUSTED_SEALERS'] = 'lists.example.org';
  const body = await (await call('GET', '/spoofing', 'VIEW_ONLY_ORG')).json() as Row;
  assert.equal(body['localSpoofAction'], 'junk');
  assert.deepEqual(body['effective'], { action: 'junk', allow: ['198.51.100.0/24'], arcTrustedSealers: ['lists.example.org'] });
  assert.deepEqual(body['envOverrides'], [{ field: 'arcTrustedSealers', variable: 'ARC_TRUSTED_SEALERS' }]);
});

test('spoofing: PUT validates entries, saves normalised lists and audits the diff', async () => {
  for (const bad of [{ localSpoofAction: 'drop' }, { localSpoofAllow: ['not valid!'] }, { arcTrustedSealers: ['10.0.0.1'] }, { other: 1 }]) {
    assert.equal((await call('PUT', '/spoofing', undefined, bad)).status, 400, JSON.stringify(bad));
  }
  const r = await call('PUT', '/spoofing', undefined, { localSpoofAction: 'reject', localSpoofAllow: ['203.0.113.7', 'Mailer.Example.'] });
  assert.equal(r.status, 200);
  assert.deepEqual(security['localSpoofAllow'], ['203.0.113.7', 'mailer.example']);
  await flush();
  const entry = audits.find((a) => a['action'] === 'settings.spoofing.update')!;
  assert.deepEqual(entry['changes'], {
    localSpoofAction: { from: '"policy"', to: '"reject"' },
    localSpoofAllow: { from: '[]', to: '["203.0.113.7","mailer.example"]' },
  });
});

test('9.4 review IDN: entries are stored as A-label, both spellings are one entry, an IDN domain target is found', async () => {
  const c = await call('POST', '/sender-lists', undefined, { listType: 'BLOCK', scope: 'GLOBAL', patternType: 'EXACT', pattern: 'Spam@Bücher.Example' });
  assert.equal(c.status, 201);
  assert.equal(((await c.json()) as Row)['pattern'], 'spam@xn--bcher-kva.example');
  const dup = await call('POST', '/sender-lists', undefined, { listType: 'BLOCK', scope: 'GLOBAL', patternType: 'EXACT', pattern: 'spam@xn--bcher-kva.example' });
  assert.equal(dup.status, 409, 'the punycode spelling is the same entry');
  const wild = await call('POST', '/sender-lists', undefined, { scope: 'DOMAIN', target: 'xn--bcher-kva.example', patternType: 'WILDCARD', pattern: '*@Bücher.example' });
  assert.equal(wild.status, 201, 'the domain stored as U-label is found by its A-label');
  const row = (await wild.json()) as Row;
  assert.equal(row['scopeId'], 'd2');
  assert.equal(row['pattern'], '*@xn--bcher-kva.example');
});

test('9.4 review IDN: a domain that is no valid IDN is refused with 400 (globs stay allowed)', async () => {
  for (const pattern of ['spam@xn--bücher.example', 'spam@\u0301bc.example']) {
    const r = await call('POST', '/sender-lists', undefined, { listType: 'BLOCK', scope: 'GLOBAL', patternType: 'EXACT', pattern });
    assert.equal(r.status, 400, pattern);
    assert.match(String(((await r.json()) as Row)['error']), /internationalized domain/);
  }
  const glob = await call('POST', '/sender-lists', undefined, { listType: 'BLOCK', scope: 'GLOBAL', patternType: 'WILDCARD', pattern: '*@*bücher*' });
  assert.equal(glob.status, 201, 'a glob label is matched as written');
});
