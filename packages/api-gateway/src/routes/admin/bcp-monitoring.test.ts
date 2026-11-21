/**
 * BCP review (monitoring/compliance pages): dashboard sections per role, log
 * viewer filters, audit-log query validation, message-trace paging, global
 * settings partial updates.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/bcp-monitoring.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
type Row = Record<string, unknown>;
const upserts: Row[] = [];
const logQueries: Row[] = [];
installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect(id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null, q.select);
    },
  },
  serverSettings: {
    findUnique: () => ({ id: 'singleton', requireMfaForAdmins: false, auditLogEnabled: true }),
    upsert: (a) => { upserts.push(a as Row); return { id: 'singleton', ...((a as { update: Row }).update) }; },
  },
  systemLog: {
    findMany: (a) => { logQueries.push(a as Row); return []; },
  },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { dashboardSections } = await import('./dashboard.js');
const { buildLogsWhere, LogsQuerySchema } = await import('./logs.js');
const { auditFilterError, auditPage } = await import('./audit-log.js');
const { pageFiltered, tracePage, traceWhere } = await import('./message-trace.js');
const { ALWAYS_AUDIT } = await import('../../lib/audit.js');

const tok = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId: 's', mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  mountAdminRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, role: string, body?: unknown) {
  const r = await fetch(`${base}/api/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${tok(role)}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Row };
}

test('dashboard: widgets with data of other areas follow the role', () => {
  const help = dashboardSections('HELP_DESK');
  assert.deepEqual(help, { errors: false, storageUsers: true, audit: false, logins: false, mailFlowErrors: false, attacks: false });
  const view = dashboardSections('VIEW_ONLY_ORG');
  assert.equal(view.errors, true);
  assert.equal(view.audit, false, 'VIEW_ONLY_ORG has no compliance access (personal data)');
  assert.equal(view.mailFlowErrors, false);
  assert.equal(dashboardSections('COMPLIANCE_MANAGEMENT').logins, true);
  assert.ok(Object.values(dashboardSections('ORGANIZATION_MANAGEMENT')).every(Boolean));
});

test('logs: MAIL_FLOW entries only with compliance access; free-text service filter', () => {
  const q = LogsQuerySchema.parse({ service: 'smtp' });
  assert.deepEqual(buildLogsWhere(q, false), { service: { contains: 'smtp', mode: 'insensitive' }, category: { not: 'MAIL_FLOW' } });
  assert.deepEqual(buildLogsWhere(q, true), { service: { contains: 'smtp', mode: 'insensitive' } });
  assert.deepEqual(buildLogsWhere(LogsQuerySchema.parse({ category: 'MAIL_FLOW' }), false)['category'], { in: [] });
  assert.equal(buildLogsWhere(LogsQuerySchema.parse({ category: 'SYSTEM' }), false)['category'], 'SYSTEM');
  assert.equal(LogsQuerySchema.safeParse({ from: 'yesterday-ish' }).success, false);
  assert.equal(LogsQuerySchema.safeParse({ limit: '0' }).success, false);
  assert.equal(LogsQuerySchema.safeParse({ offset: '-5' }).success, false);
});

test('logs route: invalid date → 400 (not a Prisma 500); VIEW_ONLY_ORG query hides MAIL_FLOW', async () => {
  assert.equal((await call('GET', '/logs?from=nope', 'SERVER_MANAGEMENT')).status, 400);
  logQueries.length = 0;
  assert.equal((await call('GET', '/logs', 'VIEW_ONLY_ORG')).status, 200);
  assert.deepEqual((logQueries[0]!['where'] as Row)['category'], { not: 'MAIL_FLOW' });
  assert.equal((await call('DELETE', '/logs/purge?before=garbage', 'SERVER_MANAGEMENT')).status, 400);
});

test('audit-log: filter validation and paging clamps', async () => {
  assert.equal(auditFilterError({ from: '2026-01-01T00:00:00.000Z' }), null);
  assert.match(auditFilterError({ to: 'not-a-date' }) ?? '', /to/);
  assert.ok(auditFilterError({ success: 'yes' }));
  assert.deepEqual(auditPage('abc', '-3'), { limit: 100, offset: 0 });
  assert.deepEqual(auditPage('9999', '200'), { limit: 500, offset: 200 });
  assert.deepEqual(auditPage('0', undefined), { limit: 1, offset: 0 });
  assert.equal((await call('GET', '/audit-log?from=garbage', 'COMPLIANCE_MANAGEMENT')).status, 400);
  assert.equal((await call('GET', '/audit-log/export.csv?to=garbage', 'COMPLIANCE_MANAGEMENT')).status, 400);
  assert.equal((await call('GET', '/audit-log?limit=abc', 'COMPLIANCE_MANAGEMENT')).status, 200);
});

test('ALWAYS_AUDIT covers the action names the middleware really writes', () => {
  for (const a of ['mailboxes.delete', 'domains.delete', 'settings.security.put', 'audit.disabled', 'audit-log.export.csv.get']) {
    assert.ok(ALWAYS_AUDIT.test(a), a);
  }
  assert.equal(ALWAYS_AUDIT.test('mailboxes.put'), false);
  // 10.6 review: MFA overrides and remembered-device revocations are always audited
  for (const a of ['mfa.policy.override', 'mfa.trusted-devices.revoke', 'user.mfa.trusted-device.revoke', 'user.mfa.trusted-devices.revoke']) {
    assert.ok(ALWAYS_AUDIT.test(a), a);
  }
  assert.equal(ALWAYS_AUDIT.test('usermfa.x'), false, 'escaped dots');
  assert.ok(ALWAYS_AUDIT.test('passkey.admin_recovery_issue') && ALWAYS_AUDIT.test('mailbox.mfa.reset'), 'existing alternatives kept');
});

test('message trace: filtered paging is consistent; dates validated', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), metadata: { sender: i % 3 === 0 ? 'a@x.de' : 'b@x.de', status: 'DELIVERED' } }));
  const p1 = pageFiltered(rows, { sender: 'A@X' }, 1, 4);
  assert.equal(p1.total, 10);
  assert.deepEqual(p1.items.map((r) => r.id), ['0', '3', '6', '9']);
  assert.deepEqual(pageFiltered(rows, { sender: 'a@x' }, 3, 4).items.map((r) => r.id), ['24', '27']);
  assert.deepEqual(tracePage('0', 'x'), { page: 1, limit: 100 });
  assert.deepEqual(tracePage('2', '1000'), { page: 2, limit: 500 });
  assert.ok('error' in traceWhere('garbage', ''));
  const ok = traceWhere('2026-11-01T00:00:00.000Z', '');
  assert.ok('where' in ok && (ok.where['timestamp'] as Row)['gte'] instanceof Date);
});

test('global settings: partial update keeps omitted fields; field errors are named', async () => {
  upserts.length = 0;
  const r = await call('PUT', '/settings/security', 'ORGANIZATION_MANAGEMENT', { requireMfaForAdmins: true });
  assert.equal(r.status, 200);
  // 10.6: the legacy switch also writes the new policy column (+ the activation time of the admin grace)
  const { mfaAdminEnforcementSince, ...rest } = upserts[0]!['update'] as Row;
  assert.deepEqual(rest, { requireMfaForAdmins: true, mfaAdminPolicy: 'REQUIRED' }, 'no defaults written for omitted fields');
  assert.ok(mfaAdminEnforcementSince instanceof Date);
  const bad = await call('PUT', '/settings/security', 'ORGANIZATION_MANAGEMENT', { minPasswordLength: 4 });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json['error']), /minPasswordLength/);
  assert.equal((await call('PUT', '/settings/org', 'SERVER_MANAGEMENT', { orgName: 'x' })).status, 403, 'organisation is read-only for SERVER_MANAGEMENT');
});
