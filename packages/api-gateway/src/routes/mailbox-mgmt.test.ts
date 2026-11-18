/**
 * 9.4 mailbox management in the api-gateway: mail flow admin API (validation,
 * audit diff, admin-mailbox guard, shared mailboxes without send limits),
 * auto-mapping in the folder pane, sent-copy switches + autoMap on grants, the
 * owner's access log, the audit category "mailbox-access" and the webmail
 * send-size estimate.
 * Run: node --import tsx --test --test-force-exit src/routes/mailbox-mgmt.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let users: Record<string, Row> = {};
let policies: Record<string, Row> = {};
let sharedRows: Record<string, Row> = {};
const auditRows: Row[] = [];
const sharedUpdates: Row[] = [];
const permCreates: Row[] = [];

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      if (id.startsWith('actor-')) return { id, role: id.slice(6), active: true };
      const u = users[id];
      return u ? { ...applySelect(u, q.select), ...(q.select?.['aliases'] ? { aliases: [] } : {}) } : null;
    },
  },
  sharedMailbox: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const s = sharedRows[String(q.where['id'])];
      return s ? { ...applySelect(s, q.select), ...(q.select?.['aliases'] ? { aliases: [{ address: 'info@ex.com' }] } : {}) } : null;
    },
    update: (a) => { const q = a as { data: Row }; sharedUpdates.push(q.data); return { id: 'sm1', ...q.data }; },
  },
  mailFlowPolicy: {
    findUnique: (a) => policies[JSON.stringify((a as { where: Row }).where)] ?? null,
    upsert: (a) => {
      const q = a as { where: Row; update: Row };
      const key = JSON.stringify(q.where);
      policies[key] = { ...(policies[key] ?? {}), ...q.update };
      return policies[key];
    },
  },
  sharedMailboxPerm: {
    deleteMany: () => ({ count: 0 }),
    createMany: (a) => { permCreates.push(...((a as { data: Row[] }).data)); return { count: 1 }; },
    findMany: () => [],
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', auditLogEnabled: true, requireMfaForAdmins: false }) },
  auditLog: { create: (a) => { auditRows.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminMailboxesRouter } = await import('./admin/mailboxes.js');
const { adminSharedMailboxesRouter } = await import('./admin/shared-mailboxes.js');
const { parseMailFlowPatch, mailFlowDiff, mailFlowView } = await import('../lib/mail-flow-admin.js');
const { folderPaneHidden, nextFolderPaneLists, ownerAccessEntry } = await import('./user.js');
const { auditCategoryWhere } = await import('./admin/audit-log.js');
const { estimatedSendSize } = await import('./mail.js');
const storage = await import('@coremail/storage');

type TokenRole = Parameters<typeof core.signAccessToken>[0]['role'];
const tok = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `${role}@ex.com`, role: role as TokenRole, domainId: 'd1', sessionId: 's', mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
  app.use('/api/v1/admin/shared-mailboxes', adminSharedMailboxesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  users = {
    u1: { id: 'u1', email: 'bob@ex.com', role: 'USER', active: true },
    adm: { id: 'adm', email: 'root@ex.com', role: 'ORGANIZATION_MANAGEMENT', active: true },
  };
  sharedRows = { sm1: { id: 'sm1', email: 'team@ex.com' } };
  policies = {};
  auditRows.length = 0;
  sharedUpdates.length = 0;
  permCreates.length = 0;
});

async function call(method: string, path: string, body?: unknown, role = 'ORGANIZATION_MANAGEMENT'): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) as Row : {} };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('mail flow validation: lists normalised, self-forward and junk refused, send limits for user mailboxes only', () => {
  const ok = parseMailFlowPatch({ forwardTo: 'Boss@Partner.example', acceptFrom: ['@Partner.example', 'a@x.test'], maxRecipients: 5 }, 'user', ['bob@ex.com']);
  assert.deepEqual(ok, { ok: true, patch: { forwardTo: 'boss@partner.example', acceptFrom: ['partner.example', 'a@x.test'], maxRecipients: 5 } });
  assert.equal(parseMailFlowPatch({ forwardTo: 'BOB@ex.com' }, 'user', ['bob@ex.com']).ok, false, 'no forward to itself');
  assert.equal(parseMailFlowPatch({ forwardTo: 'not an address' }, 'user', []).ok, false);
  assert.equal(parseMailFlowPatch({ rejectFrom: ['ok.test', 'bad'] }, 'user', []).ok, false);
  assert.equal(parseMailFlowPatch({ maxSendSizeMb: 5 }, 'shared', []).ok, false, 'no send limits on shared mailboxes');
  assert.equal(parseMailFlowPatch({ maxReceiveSizeMb: 0 }, 'user', []).ok, false);
  assert.equal(parseMailFlowPatch({ unknown: 1 }, 'user', []).ok, false, 'strict body');
  assert.deepEqual(parseMailFlowPatch({ forwardTo: '' }, 'user', []), { ok: true, patch: { forwardTo: null } }, '"" clears forwarding');
  const before = storage.mailFlowFromRow(null);
  assert.deepEqual(mailFlowDiff(before, { ...before, hiddenFromGal: true }), { hiddenFromGal: { from: false, to: true } });
  assert.equal('maxSendSizeMb' in mailFlowView(before, 'shared'), false);
});

test('PUT /admin/mailboxes/:id/mail-flow merges, stores and audits the diff; GET returns it', async () => {
  const r = await call('PUT', '/api/v1/admin/mailboxes/u1/mail-flow', { hiddenFromGal: true, rejectFrom: ['spam.test'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json['hiddenFromGal'], true);
  assert.deepEqual(r.json['rejectFrom'], ['spam.test']);
  const r2 = await call('PUT', '/api/v1/admin/mailboxes/u1/mail-flow', { forwardTo: 'out@partner.example', forwardKeepCopy: false });
  assert.equal(r2.json['hiddenFromGal'], true, 'absent fields unchanged');
  assert.equal(r2.json['forwardKeepCopy'], false);
  await tick();
  const rows = auditRows.filter((a) => a['action'] === 'mailbox.mailflow.update');
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[1]!['changes'] as Row).sort(), ['forwardKeepCopy', 'forwardTo']);
  assert.equal(rows[0]!['targetName'], 'bob@ex.com');
  const g = await call('GET', '/api/v1/admin/mailboxes/u1/mail-flow');
  assert.equal(g.json['forwardTo'], 'out@partner.example');
  assert.equal((await call('GET', '/api/v1/admin/mailboxes/nope/mail-flow')).status, 404);
});

test('mail flow of admin mailboxes is Organization Management only; HELP_DESK has no access', async () => {
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/adm/mail-flow', { hiddenFromGal: true }, 'RECIPIENT_MANAGEMENT')).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/u1/mail-flow', { hiddenFromGal: true }, 'HELP_DESK')).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/mailboxes/u1/mail-flow', { hiddenFromGal: true }, 'RECIPIENT_MANAGEMENT')).status, 200);
});

test('shared mailboxes: mail flow without send limits, forward to an own alias refused, sent-copy switches, autoMap on grants', async () => {
  const r = await call('PUT', '/api/v1/admin/shared-mailboxes/sm1/mail-flow', { maxReceiveSizeMb: 10, acceptFrom: ['ex.com'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal('maxRecipients' in r.json, false);
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/sm1/mail-flow', { forwardTo: 'info@ex.com' })).status, 400);
  assert.equal((await call('PUT', '/api/v1/admin/shared-mailboxes/sm1/mail-flow', { maxRecipients: 3 })).status, 400);

  sharedRows['sm1'] = { id: 'sm1', email: 'team@ex.com', quotaBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null };
  const u = await call('PUT', '/api/v1/admin/shared-mailboxes/sm1', { sentCopySendAs: true, sentCopySendOnBehalf: false });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.deepEqual([sharedUpdates[0]!['sentCopySendAs'], sharedUpdates[0]!['sentCopySendOnBehalf']], [true, false]);

  users['u1'] = { id: 'u1', email: 'bob@ex.com', role: 'USER', active: true };
  const g = await call('POST', '/api/v1/admin/shared-mailboxes/sm1/permissions', { userId: 'u1', permissions: ['FULL_ACCESS', 'SEND_AS'], autoMap: false });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.deepEqual(permCreates.map((p) => p['autoMap']), [false, false]);
  permCreates.length = 0;
  await call('POST', '/api/v1/admin/shared-mailboxes/sm1/permissions', { userId: 'u1', permissions: ['READ_ONLY'] });
  assert.deepEqual(permCreates.map((p) => p['autoMap']), [true], 'auto-mapping is the default');
});

test('folder pane: a grant without auto-mapping is hidden until added; hide/show keep both lists consistent', () => {
  assert.equal(folderPaneHidden('shared:s1', true, new Set(), new Set()), false);
  assert.equal(folderPaneHidden('shared:s1', false, new Set(), new Set()), true, 'not added yet');
  assert.equal(folderPaneHidden('shared:s1', false, new Set(), new Set(['shared:s1'])), false);
  assert.equal(folderPaneHidden('shared:s1', true, new Set(['shared:s1']), new Set()), true, 'hidden by the user');

  const current = new Set(['shared:s1', 'shared:s2']);
  const shown = nextFolderPaneLists({ hidden: ['shared:s1', 'shared:gone'], added: [] }, current, 'shared:s1', false, false, 500);
  assert.deepEqual(shown, { hidden: [], added: ['shared:s1'] }, 'showing a non-auto-mapped box adds it; stale refs pruned');
  const hidden = nextFolderPaneLists(shown, current, 'shared:s1', true, false, 500);
  assert.deepEqual(hidden, { hidden: ['shared:s1'], added: [] });
  assert.deepEqual(nextFolderPaneLists({ hidden: [], added: [] }, current, 'shared:s2', false, true, 500), { hidden: [], added: [] }, 'auto-mapped: nothing to remember');
});

test('owner access log entries: short action, client and counts, never the IP', () => {
  const e = ownerAccessEntry({
    id: 'a1', timestamp: new Date('2026-11-17T08:00:00Z'), actorEmail: 'deputy@ex.com', action: 'mailbox.foreign.message.delete',
    changes: { mailboxId: 'mb1', source: 'imap', count: 3, folder: 'INBOX' },
  });
  assert.deepEqual(e, { id: 'a1', at: '2026-11-17T08:00:00.000Z', actor: 'deputy@ex.com', action: 'message.delete', source: 'imap', count: 3, folder: 'INBOX' });
});

test('audit category "mailbox-access" filters the mailbox access audit; unknown categories are ignored', () => {
  assert.deepEqual(auditCategoryWhere('mailbox-access'), { action: { startsWith: 'mailbox.foreign.' } });
  assert.equal(auditCategoryWhere('nope'), null);
  assert.equal(auditCategoryWhere(undefined), null);
});

test('webmail send size estimate: bodies in bytes plus attachment sizes', () => {
  assert.equal(estimatedSendSize('<p>ä</p>', 'ä', [{ size: 10 }, { size: 5 }]), 9 + 2 + 15);
});
