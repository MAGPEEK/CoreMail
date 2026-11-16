/**
 * 9.2: BCP → Protection → Antivirus. GET/PUT /admin/security/clamav (strict zod,
 * ranges, audit diff, hygiene RBAC inherited from the security router), the
 * status + EICAR proxies to the security filter (fake filter on loopback).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/security-clamav.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const DEFAULTS: Row = {
  id: 'singleton', clamavEnabled: true, clamavAction: 'quarantine', clamavBlockOnFailure: false,
  clamavTimeoutSec: 20, clamavScanLimitMb: 50, clamavOversizeAction: 'accept',
  clamavHeuristicsAsVirus: true, clamavPuaAsVirus: true, clamavEncryptedAsVirus: true,
  clamavScanArchives: true,
};
let row: Row | null = null;
const audits: Row[] = [];
const upserts: Row[] = [];

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  securitySettings: {
    findUnique: () => row,
    upsert: (a) => {
      const q = a as { update: Row; create: Row };
      if (Object.keys(q.update).length > 0) upserts.push(q.update); // GET upserts with update: {}
      row = row ? { ...row, ...q.update } : { ...DEFAULTS, ...q.create };
      return row;
    },
  },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminSecurityRouter } = await import('./security.js');
const { policyDiff } = await import('./security-clamav.js');

const token = (role: string) => core.signAccessToken({ // role cast: test roles are UserRole values
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let filter: Server;
let base = '';
const filterCalls: string[] = [];

before(async () => {
  const f = express();
  f.get('/clamav/status', (_q, r) => { filterCalls.push('status'); r.json({ online: true, version: { engine: '1.4.1', signatureVersion: 27450 } }); });
  f.post('/clamav/eicar-test', (_q, r) => { filterCalls.push('eicar'); r.json({ detected: true, outcome: 'quarantine', status: 'infected' }); });
  filter = f.listen(0, '127.0.0.1');
  await new Promise((r) => filter.once('listening', r));
  process.env['SECURITY_FILTER_URL'] = `http://127.0.0.1:${(filter.address() as AddressInfo).port}`;

  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/security', requireAuth, adminSecurityRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/security/clamav`;
});
after(() => { server?.close(); filter?.close(); });
beforeEach(() => { row = { ...DEFAULTS }; audits.length = 0; upserts.length = 0; filterCalls.length = 0; });

const call = (method: string, path: string, role: string, body?: unknown) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${token(role)}`, 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const flush = () => new Promise((r) => setTimeout(r, 30));

test('GET returns only the CoreMail policy plus the env endpoint', async () => {
  const r = await call('GET', '', 'HYGIENE_MANAGEMENT');
  assert.equal(r.status, 200);
  const body = await r.json() as Row;
  assert.equal(body['clamavTimeoutSec'], 20);
  assert.equal(body['clamavOversizeAction'], 'accept');
  assert.equal(body['clamavScanArchives'], undefined, 'engine fields are not part of the policy');
  assert.deepEqual(Object.keys(body['endpoint'] as Row).sort(), ['forcedOff', 'host', 'port']);
});

test('PUT validates strictly (ranges, enums, unknown fields)', async () => {
  for (const bad of [
    { clamavTimeoutSec: 30 }, { clamavTimeoutSec: 4 }, { clamavTimeoutSec: 10.5 },
    { clamavScanLimitMb: 51 }, { clamavScanLimitMb: 0 },
    { clamavOversizeAction: 'tempfail' }, { clamavAction: 'delete' },
    { clamavHeuristicsAsVirus: 'yes' },
    { clamavMaxFileSizeMb: 10 }, // engine limit — not settable here
    { clamavHost: 'evil.example' },
  ]) {
    const r = await call('PUT', '', 'HYGIENE_MANAGEMENT', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(upserts.length, 0);
});

test('PUT saves, answers the new policy and audits only the changed fields', async () => {
  const r = await call('PUT', '', 'HYGIENE_MANAGEMENT', {
    clamavTimeoutSec: 10, clamavOversizeAction: 'reject', clamavPuaAsVirus: false, clamavEnabled: true,
  });
  assert.equal(r.status, 200);
  const body = await r.json() as Row;
  assert.equal(body['clamavTimeoutSec'], 10);
  assert.equal(body['clamavPuaAsVirus'], false);
  assert.deepEqual(upserts[0], { clamavTimeoutSec: 10, clamavOversizeAction: 'reject', clamavPuaAsVirus: false, clamavEnabled: true });
  await flush();
  const entry = audits.find((a) => a['action'] === 'settings.clamav.update');
  assert.ok(entry, 'audit entry written');
  assert.equal(entry['actorEmail'], 'actor-HYGIENE_MANAGEMENT@ex.com');
  assert.deepEqual(entry['changes'], {
    clamavTimeoutSec: { from: '20', to: '10' },
    clamavOversizeAction: { from: 'accept', to: 'reject' },
    clamavPuaAsVirus: { from: 'true', to: 'false' },
  });
});

test('read-only and non-hygiene roles cannot change the policy or run the EICAR test', async () => {
  assert.equal((await call('GET', '', 'VIEW_ONLY_ORG')).status, 200);
  assert.equal((await call('PUT', '', 'VIEW_ONLY_ORG', { clamavTimeoutSec: 10 })).status, 403);
  assert.equal((await call('POST', '/eicar-test', 'VIEW_ONLY_ORG')).status, 403);
  assert.equal((await call('GET', '', 'USER')).status, 403);
  assert.equal((await call('PUT', '', 'HELP_DESK', { clamavTimeoutSec: 10 })).status, 403);
  assert.equal(upserts.length, 0);
  assert.deepEqual(filterCalls, []);
});

test('status and EICAR test are proxied to the security filter; an unreachable filter answers 503', async () => {
  const s = await call('GET', '/status', 'HYGIENE_MANAGEMENT');
  assert.equal(s.status, 200);
  assert.equal((await s.json() as Row)['online'], true);
  const e = await call('POST', '/eicar-test', 'HYGIENE_MANAGEMENT');
  assert.equal(e.status, 200);
  assert.equal((await e.json() as Row)['outcome'], 'quarantine');
  assert.deepEqual(filterCalls, ['status', 'eicar']);

  const saved = process.env['SECURITY_FILTER_URL'];
  process.env['SECURITY_FILTER_URL'] = 'http://127.0.0.1:1';
  try {
    assert.equal((await call('GET', '/status', 'HYGIENE_MANAGEMENT')).status, 503);
  } finally { process.env['SECURITY_FILTER_URL'] = saved; }
});

test('policyDiff ignores unchanged and unrelated fields', () => {
  assert.deepEqual(policyDiff({ clamavTimeoutSec: 20, clamavAction: 'quarantine' }, { clamavTimeoutSec: 20, clamavAction: 'reject', other: 1 }),
    { clamavAction: { from: 'quarantine', to: 'reject' } });
  assert.deepEqual(policyDiff(null, { clamavEnabled: false }), { clamavEnabled: { from: 'undefined', to: 'false' } });
});

test('PUT /settings: spam score must stay below the reject score, also against the stored value (live BCP test 9.2)', async () => {
  // base ends in /clamav — the settings route lives next to it
  const put = (body: unknown) => fetch(`${base.replace(/\/clamav$/, '')}/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token('HYGIENE_MANAGEMENT')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const both = await put({ rspamdEnabled: true, rspamdSpamScore: 10, rspamdRejectScore: 5 });
  assert.equal(both.status, 400);
  assert.equal((await both.json() as Row)['code'], 'RSPAMD_THRESHOLDS');
  const equal = await put({ rspamdSpamScore: 8, rspamdRejectScore: 8 });
  assert.equal(equal.status, 400);
  row = { ...DEFAULTS, rspamdSpamScore: 6, rspamdRejectScore: 15 };
  const onlyReject = await put({ rspamdRejectScore: 5 }); // stored spam score 6
  assert.equal(onlyReject.status, 400);
  const onlySpam = await put({ rspamdSpamScore: 20 }); // stored reject score 15
  assert.equal(onlySpam.status, 400);
  assert.equal(upserts.length, 0);
});
