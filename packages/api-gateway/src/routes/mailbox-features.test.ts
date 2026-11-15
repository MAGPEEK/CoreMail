/**
 * v8.1 Exchange-style mailbox features on the REST API (loopback Express app,
 * Prisma faked via globalThis.__prisma):
 *  - POST /mail/send refused at ProhibitSendQuota (403 MAILBOX_QUOTA_EXCEEDED)
 *  - GET /user/quota (levels + usage)
 *  - PUT /user/oof maintains the OOF period id, validates the schedule
 *  - /mail/recoverable list/restore/purge: auth, validation, own mailbox only
 *  - admin quota levels: validation + server defaults
 * Run: node --import tsx --test --test-force-exit src/routes/mailbox-features.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const MB = 1024 * 1024;
let used = 0;
const users: Record<string, Row> = {
  u1: {
    id: 'u1', email: 'bob@ex.com', displayName: 'Bob', role: 'USER', active: true, domainId: 'd1',
    quotaBytes: BigInt(100 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null, quotaWarnedAt: new Date(),
    mailbox: { id: 'mb1' }, domain: { id: 'd1', name: 'ex.com' },
  },
  admin: { id: 'admin', email: 'adm@ex.com', role: 'ORGANIZATION_MANAGEMENT', active: true, mailbox: { id: 'mb-admin' } },
};
const settings: Row = { id: 'singleton', quotaWarningPercent: 80, quotaProhibitSendPercent: 90, publicHostname: 'mail.ex.com', requireMfaForAdmins: false };
let userSettings: Row | null = null;
const messageQueries: Row[] = [];
const deleted: Row[] = [];
const userUpdates: Row[] = [];

installFakePrisma({
  user: {
    findUnique: (a) => { const q = a as { where: Row; select?: Row }; const r = users[String(q.where['id'])] ?? null; return q.select ? { ...applySelect(r, q.select), ...(r && 'mailbox' in (q.select ?? {}) ? { mailbox: r['mailbox'] } : {}) } : r; },
    update: (a) => { const q = a as { where: Row; data: Row }; userUpdates.push(q.data); return { ...users[String(q.where['id'])], ...q.data }; },
    updateMany: () => ({ count: 0 }),
  },
  serverSettings: {
    findUnique: () => ({ ...settings }),
    upsert: (a) => { const q = a as { update: Row }; Object.assign(settings, q.update); return { ...settings }; },
  },
  message: {
    aggregate: () => ({ _sum: { rawSize: used } }),
    groupBy: () => [],
    findMany: (a) => { messageQueries.push((a as { where: Row }).where); return []; },
    count: () => 0,
    deleteMany: (a) => { deleted.push((a as { where: Row }).where); return { count: 0 }; },
  },
  mailbox: {
    findUnique: (a) => { const w = (a as { where: Row }).where; return w['userId'] === 'u1' ? { id: 'mb1', folders: [] } : null; },
  },
  userSettings: {
    findUnique: () => (userSettings ? { ...userSettings } : null),
    upsert: (a) => { const q = a as { update: Row; create: Row }; userSettings = userSettings ? { ...userSettings, ...q.update } : { ...q.create }; return userSettings; },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const { mailRouter } = await import('./mail.js');
const { userRouter } = await import('./user.js');
const { recoverableRouter } = await import('./recoverable.js');
const { adminMailboxesRouter } = await import('./admin/mailboxes.js');
const { quotaLevelError } = await import('../lib/quota-levels.js');

type TokenRole = Parameters<typeof core.signAccessToken>[0]['role'];
const tok = (sub: string, role: TokenRole = 'USER') => core.signAccessToken({ sub, email: `${sub}@ex.com`, role, domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mail/recoverable', recoverableRouter);
  app.use('/api/v1/mail', mailRouter);
  app.use('/api/v1/user', userRouter);
  app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { used = 0; storage.resetQuotaCache(); messageQueries.length = 0; deleted.length = 0; });

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('POST /mail/send is refused at the prohibit-send level with a clear error', async () => {
  used = 90 * MB;
  const r = await call('POST', '/api/v1/mail/send', { token: tok('u1'), body: { to: ['a@ext.example'], subject: 's', bodyText: 'x' } });
  assert.equal(r.status, 403);
  assert.equal(r.json['code'], 'MAILBOX_QUOTA_EXCEEDED');
  assert.equal(r.json['limitBytes'], 90 * MB);
});

test('GET /user/quota reports usage, level and the effective limits', async () => {
  used = 85 * MB;
  const r = await call('GET', '/api/v1/user/quota', { token: tok('u1') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    usedBytes: 85 * MB, level: 'warning',
    warningBytes: 80 * MB, prohibitSendBytes: 90 * MB, prohibitSendReceiveBytes: 100 * MB,
  });
  assert.equal((await call('GET', '/api/v1/user/quota')).status, 401);
});

test('PUT /user/oof keeps the period id while unchanged and starts a new one on re-enable', async () => {
  const body = { enabled: true, internalMessage: 'away', externalMessage: 'away ext', externalEnabled: true, externalOnlyContacts: true };
  assert.equal((await call('PUT', '/api/v1/user/oof', { token: tok('u1'), body })).status, 200);
  const p1 = userSettings!['oofPeriodId'];
  assert.ok(typeof p1 === 'string' && p1.length > 0);
  assert.equal(userSettings!['oofExternalOnlyContacts'], true);
  await call('PUT', '/api/v1/user/oof', { token: tok('u1'), body });
  assert.equal(userSettings!['oofPeriodId'], p1);
  await call('PUT', '/api/v1/user/oof', { token: tok('u1'), body: { ...body, enabled: false } });
  await call('PUT', '/api/v1/user/oof', { token: tok('u1'), body });
  assert.notEqual(userSettings!['oofPeriodId'], p1);
  const bad = await call('PUT', '/api/v1/user/oof', { token: tok('u1'), body: { ...body, useTimeRange: true, startDate: '2026-12-10T00:00:00Z', endDate: '2026-12-01T00:00:00Z' } });
  assert.equal(bad.status, 400);
});

test('/mail/recoverable: auth, validation and own-mailbox scoping', async () => {
  assert.equal((await call('GET', '/api/v1/mail/recoverable')).status, 401);
  const list = await call('GET', '/api/v1/mail/recoverable', { token: tok('u1') });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json['items'], []);
  assert.equal(list.json['retentionDays'], 14);
  assert.ok(messageQueries.every((w) => JSON.stringify(w).includes('"mailboxId":"mb1"')), 'queries are scoped to the caller mailbox');
  assert.equal((await call('POST', '/api/v1/mail/recoverable/restore', { token: tok('u1'), body: { ids: [] } })).status, 400);
  assert.equal((await call('POST', '/api/v1/mail/recoverable/restore', { token: tok('u1'), body: {} })).status, 400);
  const restored = await call('POST', '/api/v1/mail/recoverable/restore', { token: tok('u1'), body: { ids: ['m1'] } });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.json['notFound'], ['m1']);
  const purged = await call('POST', '/api/v1/mail/recoverable/purge', { token: tok('u1'), body: { ids: ['m1'] } });
  assert.deepEqual([purged.status, purged.json['purged']], [200, 0]);
  assert.ok(messageQueries.slice(-1).every((w) => JSON.stringify(w).includes('"mailboxId":"mb1"')));
  // a user without a mailbox
  assert.equal((await call('GET', '/api/v1/mail/recoverable', { token: tok('nobody') })).status, 404);
});

test('admin quota levels: validation and server defaults', async () => {
  assert.equal(quotaLevelError(10, 5, undefined), 'quotaWarningBytes must not exceed quotaProhibitSendBytes');
  assert.equal(quotaLevelError(null, 200, 100), 'quotaProhibitSendBytes must not exceed quotaBytes');
  assert.equal(quotaLevelError(5, 10, 0), null, 'unlimited quota');
  assert.equal(quotaLevelError(undefined, undefined, 100), null);
  const t = tok('admin', 'ORGANIZATION_MANAGEMENT');
  assert.equal((await call('GET', '/api/v1/admin/mailboxes/quota-defaults', { token: tok('u1') })).status, 403);
  const got = await call('GET', '/api/v1/admin/mailboxes/quota-defaults', { token: t });
  assert.deepEqual(got.json, { quotaWarningPercent: 80, quotaProhibitSendPercent: 90 });
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/quota-defaults', { token: t, body: { quotaWarningPercent: 95 } })).status, 400);
  const put = await call('PUT', '/api/v1/admin/mailboxes/quota-defaults', { token: t, body: { quotaWarningPercent: 85, quotaProhibitSendPercent: 92 } });
  assert.deepEqual(put.json, { quotaWarningPercent: 85, quotaProhibitSendPercent: 92 });
  const bad = await call('PUT', '/api/v1/admin/mailboxes/u1', { token: t, body: { quotaWarningBytes: 50, quotaProhibitSendBytes: 40 } });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/v1/admin/mailboxes/u1', { token: t, body: { quotaWarningBytes: 40 * MB, quotaProhibitSendBytes: null } });
  assert.equal(ok.status, 200);
  const last = userUpdates[userUpdates.length - 1]!;
  assert.equal(last['quotaWarningBytes'], BigInt(40 * MB));
  assert.equal(last['quotaProhibitSendBytes'], null);
});
