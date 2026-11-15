/**
 * v8.1 wave-1 follow-ups — route-level regression tests on a loopback app:
 *  - inbox rules / transport rules: unsupported `regex` patterns → 400
 *  - POST /mail/send: client `references` validated + preferred over the server chain
 *  - message-trace CSV export honours subject + status like the list
 *  - shared-mailbox message: attachments carry contentId + inline (cid: images)
 * Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/followups.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const ruleWrites: Row[] = [];
const transportWrites: Row[] = [];
let existingRules: Array<{ id: string; conditions: unknown; exceptions: unknown }> = [];
let lastAttachmentSelect: unknown = null;
const traceRows = [
  { timestamp: new Date('2026-11-01T10:00:00Z'), message: 'm1', metadata: { sender: 'a@x', recipient: 'b@y', subject: 'Invoice 42', status: 'DELIVERED', messageId: 'id1' } },
  { timestamp: new Date('2026-11-01T11:00:00Z'), message: 'm2', metadata: { sender: 'a@x', recipient: 'b@y', subject: 'Invoice 43', status: 'REJECTED', messageId: 'id2' } },
  { timestamp: new Date('2026-11-01T12:00:00Z'), message: 'm3', metadata: { sender: 'a@x', recipient: 'b@y', subject: 'Hello', status: 'DELIVERED', messageId: 'id3' } },
];

installFakePrisma({
  user: { findUnique: (a) => ((a as { where: { id: string } }).where.id === 'admin' ? { role: 'ORGANIZATION_MANAGEMENT', active: true } : { role: 'USER', active: true }) },
  mailRule: {
    findMany: () => existingRules,
    findFirst: () => null,
    create: (a) => { const d = (a as { data: Row }).data; ruleWrites.push(d); return { id: 'r1', ...d }; },
  },
  transportRule: {
    create: (a) => { const d = (a as { data: Row }).data; transportWrites.push(d); return { id: 't1', ...d }; },
  },
  systemLog: { findMany: () => traceRows, count: () => traceRows.length },
  sharedMailboxPerm: {
    findFirst: () => ({ sharedMailbox: { id: 'sm1', active: true } }),
    findMany: () => [{ permission: 'FULL_ACCESS', sharedMailbox: { id: 'sm1', email: 'team@ex.com', displayName: 'Team', active: true, mailbox: { id: 'mb-shared' } } }],
  },
  mailboxDelegate: { findMany: () => [] },
  mailbox: { findFirst: () => ({ id: 'mb-shared' }) },
  message: {
    findFirst: (a) => {
      lastAttachmentSelect = (a as { include?: { attachments?: unknown } }).include?.attachments ?? null;
      return { id: 'msg1', subject: 's', attachments: [] };
    },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { userRouter } = await import('./user.js');
const { adminTransportRulesRouter } = await import('./admin/transport-rules.js');
const { adminMessageTraceRouter, matchesTraceFilter } = await import('./admin/message-trace.js');
const { parseClientReferences, resolveReplyHeaders, MAX_CLIENT_REFERENCES } = await import('../lib/reply-headers.js');
const { requireAuth } = await import('../middleware/auth.js');

type Role = Parameters<typeof core.signAccessToken>[0]['role'];
const tok = (sub: string, role: Role = 'USER') => core.signAccessToken({ sub, email: `${sub}@ex.com`, role, domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/user', userRouter);
  app.use('/api/v1/admin/transport-rules', requireAuth, adminTransportRulesRouter);
  app.use('/api/v1/admin/message-trace', requireAuth, adminMessageTraceRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Row; text: string }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* CSV */ }
  return { status: r.status, json, text };
}

test('inbox rules: an unsupported regex is refused with a readable 400', async () => {
  const t = tok('u1');
  const rule = (value: string, where: 'conditions' | 'exceptions' = 'conditions') => ({
    name: 'r', actions: [{ type: 'markRead' }], [where]: [{ field: 'subject', operator: 'regex', value }],
  });
  const bad = await call('POST', '/api/v1/user/rules', t, rule('(a)\\1'));
  assert.equal(bad.status, 400);
  assert.equal(bad.json['code'], 'INVALID_RULE_PATTERN');
  assert.match(String(bad.json['error']), /Invalid regular expression/);
  assert.equal((await call('POST', '/api/v1/user/rules', t, rule('x'.repeat(201), 'exceptions'))).status, 400);
  assert.equal((await call('PUT', '/api/v1/user/rules/r1', t, rule('(?<=a)b'))).status, 400);
  assert.equal(ruleWrites.length, 0);
  const ok = await call('POST', '/api/v1/user/rules', t, rule('^invoice\\s+#\\d+'));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  // other operators are not regex-validated
  assert.equal((await call('POST', '/api/v1/user/rules', t, { name: 'c', actions: [{ type: 'markRead' }], conditions: [{ field: 'subject', operator: 'contains', value: '(a)\\1' }] })).status, 201);
});

test('inbox rules: at most 20 regex conditions per user over all rules', async () => {
  const t = tok('u1');
  const regex = (n: number) => Array.from({ length: n }, (_, i) => ({ field: 'subject', operator: 'regex', value: `x${i}` }));
  existingRules = [
    { id: 'a', conditions: regex(12), exceptions: [] },
    { id: 'b', conditions: [{ field: 'subject', operator: 'contains', value: 'y' }], exceptions: regex(6) },
  ];
  try {
    const writes = ruleWrites.length;
    // 18 existing + 3 new = 21 → refused
    const over = await call('POST', '/api/v1/user/rules', t, { name: 'r', actions: [{ type: 'markRead' }], conditions: regex(3) });
    assert.equal(over.status, 400);
    assert.equal(over.json['code'], 'TOO_MANY_REGEX_CONDITIONS');
    // 18 + 2 = 20 → allowed
    assert.equal((await call('POST', '/api/v1/user/rules', t, { name: 'r', actions: [{ type: 'markRead' }], conditions: regex(2) })).status, 201);
    assert.equal(ruleWrites.length, writes + 1);
  } finally {
    existingRules = [];
  }
  const { regexConditionLimitMessage } = await import('./user.js');
  // replacing rule "a" (12 regex) with 14 → 6 + 14 = 20 → fine; with 15 → refused
  const rules = [{ id: 'a', conditions: regex(12), exceptions: [] }, { id: 'b', conditions: [], exceptions: regex(6) }];
  assert.equal(regexConditionLimitMessage(rules, [regex(14)], 'a'), null);
  assert.match(regexConditionLimitMessage(rules, [regex(15)], 'a') ?? '', /at most 20/);
});

test('transport rules: an unsupported regex is refused on save', async () => {
  const t = tok('admin', 'ORGANIZATION_MANAGEMENT');
  const body = (value: string) => ({ name: 'n', conditions: [{ field: 'subject', op: 'regex', value }], actions: [{ type: 'addHeader', value: 'X-A: 1' }] });
  const bad = await call('POST', '/api/v1/admin/transport-rules', t, body('(a+)+\\1'));
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  assert.equal(bad.json['code'], 'INVALID_RULE_PATTERN');
  assert.equal((await call('PUT', '/api/v1/admin/transport-rules/t1', t, { conditions: body('(?!x)').conditions })).status, 400);
  assert.equal(transportWrites.length, 0);
  assert.equal((await call('POST', '/api/v1/admin/transport-rules', t, body('^\\[ext\\]'))).status, 201);
});

test('POST /mail/send references: validated <msg-id> list; preferred over the server chain', async () => {
  assert.deepEqual(parseClientReferences(undefined), { ok: true, refs: null });
  assert.deepEqual(parseClientReferences('<a@x> <b@y>  <a@x>'), { ok: true, refs: ['<a@x>', '<b@y>'] });
  assert.deepEqual(parseClientReferences(['<a@x>']), { ok: true, refs: ['<a@x>'] });
  assert.equal(parseClientReferences('<a@x>\r\nBcc: v@x').ok, false, 'CR/LF');
  assert.equal(parseClientReferences(['<a@x>\n']).ok, false);
  assert.equal(parseClientReferences('a@x').ok, false, 'brackets required');
  assert.equal(parseClientReferences(['<a@x>', 7]).ok, false);
  const many = Array.from({ length: MAX_CLIENT_REFERENCES + 1 }, (_, i) => `<m${i}@x>`).join(' ');
  assert.equal(parseClientReferences(many).ok, false, 'max 50');

  const lookup = { findParent: async () => ({ id: 'p', messageId: '<parent@x>', inReplyTo: '<root@x>' }) };
  // fallback: server-resolved chain
  assert.deepEqual(await resolveReplyHeaders('cmparent', 'u1', lookup), { inReplyTo: '<parent@x>', references: '<root@x> <parent@x>' });
  // client list wins; the resolved parent is always last
  assert.deepEqual(await resolveReplyHeaders('cmparent', 'u1', lookup, ['<root@x>', '<mid@x>', '<parent@x>']),
    { inReplyTo: '<parent@x>', references: '<root@x> <mid@x> <parent@x>' });
  assert.deepEqual(await resolveReplyHeaders('cmparent', 'u1', lookup, ['<root@x>']),
    { inReplyTo: '<parent@x>', references: '<root@x> <parent@x>' });
  assert.deepEqual(await resolveReplyHeaders(undefined, 'u1', lookup, ['<root@x>']), { references: '<root@x>' });
  // (route-level 400 for an invalid list: mail-hardening.test.ts)
});

test('message-trace export honours subject + status exactly like the list', async () => {
  const t = tok('admin', 'ORGANIZATION_MANAGEMENT');
  const list = await call('GET', '/api/v1/admin/message-trace?subject=invoice&status=DELIVERED', t);
  assert.equal(list.status, 200);
  assert.deepEqual((list.json['items'] as Array<{ message: string }>).map((i) => i.message), ['m1']);
  const csv = await call('GET', '/api/v1/admin/message-trace/export?subject=invoice&status=DELIVERED', t);
  assert.equal(csv.status, 200);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, 2, csv.text);
  assert.match(lines[1]!, /"Invoice 42"/);
  const all = await call('GET', '/api/v1/admin/message-trace/export', t);
  assert.equal(all.text.trim().split('\r\n').length, 4);
  assert.equal(matchesTraceFilter({ status: 'DELIVERED' }, { status: 'delivered' }), false, 'status is exact');
  assert.equal(matchesTraceFilter(null, {}), true);
});

test('rspamd controller calls: Password header from RSPAMD_CONTROLLER_PASSWORD', async () => {
  const { rspamdControllerHeaders } = await import('../lib/rspamd-controller.js');
  assert.deepEqual(rspamdControllerHeaders({}), {});
  assert.deepEqual(rspamdControllerHeaders({ RSPAMD_CONTROLLER_PASSWORD: 'pw' }), { Password: 'pw' });
  assert.deepEqual(rspamdControllerHeaders({ RSPAMD_CONTROLLER_PASSWORD: 'pw\nX: y' }), {});
});

test('shared-mailbox message: attachment select includes contentId + inline', async () => {
  const r = await call('GET', '/api/v1/user/shared-mailboxes/sm1/messages/msg1', tok('u1'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sel = (lastAttachmentSelect as { select: Record<string, boolean> }).select;
  assert.equal(sel['contentId'], true);
  assert.equal(sel['inline'], true);
});
