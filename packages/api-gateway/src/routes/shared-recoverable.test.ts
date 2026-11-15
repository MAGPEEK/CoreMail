/**
 * 9.1: recover deleted items + quota of shared / delegated mailboxes.
 *  - /user/shared-mailboxes/:id/recoverable[/restore|/purge]: FULL_ACCESS on THAT
 *    shared mailbox only (IDOR: no access, READ_ONLY, SEND_AS, another shared
 *    mailbox, inactive mailbox → 403), storage calls scoped to its mailbox, purge audited;
 *  - /mail/delegated-mailboxes/:id/recoverable: FULL_ACCESS delegation only;
 *  - /user/shared-mailboxes/:id/quota: read access (FULL_ACCESS or READ_ONLY).
 * Loopback Express app, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/shared-recoverable.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const MB = 1024 * 1024;

// alice: FULL_ACCESS on sm1, READ_ONLY on sm2; bob: SEND_AS on sm1; carol: FULL_ACCESS on sm3 (inactive)
const perms: Array<{ userId: string; sharedMailboxId: string; permission: string }> = [
  { userId: 'alice', sharedMailboxId: 'sm1', permission: 'FULL_ACCESS' },
  { userId: 'alice', sharedMailboxId: 'sm2', permission: 'READ_ONLY' },
  { userId: 'bob',   sharedMailboxId: 'sm1', permission: 'SEND_AS' },
  { userId: 'carol', sharedMailboxId: 'sm3', permission: 'FULL_ACCESS' },
];
const shared: Record<string, Row> = {
  sm1: { id: 'sm1', email: 'team@ex.com', displayName: 'Team', active: true, mailboxId: 'mb-sm1', quotaBytes: BigInt(100 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null },
  sm2: { id: 'sm2', email: 'sales@ex.com', displayName: 'Sales', active: true, mailboxId: 'mb-sm2', quotaBytes: BigInt(50 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null },
  sm3: { id: 'sm3', email: 'old@ex.com', displayName: 'Old', active: false, mailboxId: 'mb-sm3', quotaBytes: 0n, usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null },
};
// dave: FULL_ACCESS delegate on erin's mailbox; frank: READ_ONLY delegate on it
const delegates = [
  { granteeId: 'dave',  mailboxId: 'mb-erin', permission: 'FULL_ACCESS' },
  { granteeId: 'frank', mailboxId: 'mb-erin', permission: 'READ_ONLY' },
];
const messageQueries: string[] = [];
const auditRows: Row[] = [];
let usedBytes = 0;

const matchPerm = (want: unknown, have: string): boolean =>
  typeof want === 'string' ? want === have : ((want as { in: string[] }).in ?? []).includes(have);

installFakePrisma({
  sharedMailboxPerm: {
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      const p = perms.find((x) => x.userId === w['userId'] && x.sharedMailboxId === w['sharedMailboxId'] && matchPerm(w['permission'], x.permission));
      if (!p) return null;
      return { ...p, sharedMailbox: applySelect(shared[p.sharedMailboxId]!, { id: true, email: true, displayName: true, active: true }) };
    },
  },
  sharedMailbox: {
    findUnique: (a) => {
      const q = a as { where: Row };
      const s = shared[String(q.where['id'])];
      return s ? { ...s, mailbox: { id: s['mailboxId'] } } : null;
    },
  },
  mailbox: {
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      const s = Object.values(shared).find((x) => x['id'] === w['sharedBoxId']);
      return s ? { id: s['mailboxId'] } : null;
    },
    findUnique: () => null,
  },
  mailboxDelegate: {
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      const d = delegates.find((x) => x.granteeId === w['granteeId'] && x.mailboxId === w['mailboxId'] && matchPerm(w['permission'], x.permission));
      return d ? { mailboxId: d.mailboxId } : null;
    },
  },
  message: {
    findMany: (a) => { messageQueries.push(JSON.stringify((a as { where: Row }).where)); return []; },
    count: () => 0,
    aggregate: () => ({ _sum: { rawSize: usedBytes } }),
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', quotaWarningPercent: 80, quotaProhibitSendPercent: 90 }) },
  auditLog: { create: (a) => { auditRows.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const { sharedRecoverableRouter, delegatedRecoverableRouter } = await import('./recoverable.js');
const { userRouter } = await import('./user.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  // same mount order as server.ts
  app.use('/api/v1/user/shared-mailboxes/:id/recoverable', sharedRecoverableRouter);
  app.use('/api/v1/mail/delegated-mailboxes/:id/recoverable', delegatedRecoverableRouter);
  app.use('/api/v1/user', userRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { messageQueries.length = 0; auditRows.length = 0; usedBytes = 0; storage.resetQuotaCache(); });

async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

const S = (id: string) => `/api/v1/user/shared-mailboxes/${id}/recoverable`;
const D = (id: string) => `/api/v1/mail/delegated-mailboxes/${id}/recoverable`;
const flush = () => new Promise((r) => setTimeout(r, 20)); // audit() is fire-and-forget

test('FULL_ACCESS on the shared mailbox: list / restore / purge scoped to its mailbox, purge audited', async () => {
  const list = await call('GET', S('sm1'), tok('alice'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.json['items'], []);
  const restore = await call('POST', `${S('sm1')}/restore`, tok('alice'), { ids: ['m1'] });
  assert.equal(restore.status, 200);
  assert.deepEqual(restore.json['notFound'], ['m1']);
  const purge = await call('POST', `${S('sm1')}/purge`, tok('alice'), { ids: ['m1', 'm2'] });
  assert.deepEqual([purge.status, purge.json['purged']], [200, 0]);
  assert.ok(messageQueries.length >= 3);
  assert.ok(messageQueries.every((w) => w.includes('"mailboxId":"mb-sm1"')), 'every query is scoped to the shared mailbox');
  await flush();
  const entry = auditRows.find((a) => a['action'] === 'mailbox.recoverable.purge');
  assert.ok(entry, 'purge audited');
  assert.equal(entry!['actorId'], 'alice');
  assert.equal(entry!['targetType'], 'sharedMailbox');
  assert.equal(entry!['targetId'], 'sm1');
  // validation still applies
  assert.equal((await call('POST', `${S('sm1')}/restore`, tok('alice'), { ids: [] })).status, 400);
  assert.equal((await call('POST', `${S('sm1')}/purge`, tok('alice'), {})).status, 400);
});

test('IDOR: no access, READ_ONLY, SEND_AS, another shared mailbox, inactive, unauthenticated', async () => {
  const cases: Array<[string, string]> = [
    ['nobody', 'sm1'],   // no access at all
    ['alice', 'sm2'],    // READ_ONLY on sm2
    ['bob', 'sm1'],      // SEND_AS only
    ['alice', 'sm3'],    // a different shared mailbox (carol's)
    ['carol', 'sm3'],    // FULL_ACCESS but the mailbox is inactive
    ['alice', 'nope'],   // unknown id
  ];
  for (const [user, id] of cases) {
    for (const [method, path, body] of [
      ['GET', S(id), undefined],
      ['POST', `${S(id)}/restore`, { ids: ['m1'] }],
      ['POST', `${S(id)}/purge`, { ids: ['m1'] }],
    ] as const) {
      const r = await call(method, path, tok(user), body);
      assert.equal(r.status, 403, `${user} ${method} ${path}`);
    }
  }
  assert.equal(messageQueries.length, 0, 'no message was read or touched');
  await flush();
  assert.equal(auditRows.length, 0);
  assert.equal((await call('GET', S('sm1'))).status, 401);
});

test('delegated mailbox: FULL_ACCESS delegate only', async () => {
  const ok = await call('POST', `${D('mb-erin')}/purge`, tok('dave'), { ids: ['m1'] });
  assert.equal(ok.status, 200);
  assert.ok(messageQueries.every((w) => w.includes('"mailboxId":"mb-erin"')));
  await flush();
  assert.equal(auditRows.find((a) => a['action'] === 'mailbox.recoverable.purge')?.['targetId'], 'mb-erin');
  messageQueries.length = 0;
  assert.equal((await call('GET', D('mb-erin'), tok('frank'))).status, 403, 'READ_ONLY delegate');
  assert.equal((await call('GET', D('mb-erin'), tok('alice'))).status, 403, 'not a delegate');
  assert.equal((await call('POST', `${D('mb-other')}/restore`, tok('dave'), { ids: ['m1'] })).status, 403, 'another mailbox');
  assert.equal((await call('GET', D('mb-sm1'), tok('alice'))).status, 403, 'a shared mailbox id is not a delegation');
  assert.equal(messageQueries.length, 0);
});

test('GET /user/shared-mailboxes/:id/quota: read access, same shape as /user/quota', async () => {
  usedBytes = 85 * MB;
  const full = await call('GET', '/api/v1/user/shared-mailboxes/sm1/quota', tok('alice'));
  assert.equal(full.status, 200);
  assert.deepEqual(full.json, {
    usedBytes: 85 * MB, level: 'warning',
    warningBytes: 80 * MB, prohibitSendBytes: 90 * MB, prohibitSendReceiveBytes: 100 * MB,
  });
  assert.equal((await call('GET', '/api/v1/user/shared-mailboxes/sm2/quota', tok('alice'))).status, 200, 'READ_ONLY may see the quota');
  assert.equal((await call('GET', '/api/v1/user/shared-mailboxes/sm1/quota', tok('bob'))).status, 403, 'SEND_AS only');
  assert.equal((await call('GET', '/api/v1/user/shared-mailboxes/sm3/quota', tok('carol'))).status, 403, 'inactive');
  assert.equal((await call('GET', '/api/v1/user/shared-mailboxes/sm1/quota', tok('nobody'))).status, 403);
  assert.equal((await call('GET', '/api/v1/user/shared-mailboxes/sm1/quota')).status, 401);
});
