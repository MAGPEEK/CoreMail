/**
 * Message trace detail (10.2) — GET /api/v1/admin/message-trace/:id: an entry
 * out of the admin's scope answers 404 exactly like an unknown id; addresses of
 * other hosted domains are redacted everywhere (metadata, stages, related
 * entries, Received hops); related entries are correlated by queue tracking id
 * / Message-ID and filtered by scope; the delivery path is the Received chain
 * of the stored original (inbound) or CoreMail → the MX used (outbound).
 * In-memory Prisma (test-support/memory-model.ts); domains a.example (dA, the
 * scope of coA) and b.example (dB).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/message-trace-detail.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
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
const T0 = new Date('2026-11-20T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const stage = (name: string, result: string, detail: Row, s = 0): Row => ({ stage: name, at: at(s).toISOString(), result, detail });

const RAW_HEAD = [
  'Received: from mx.other.test (mx.other.test [203.0.113.9])\r\n\tby mx.a.example (CoreMail) with ESMTPS id S1\r\n\tfor <ua1@a.example>; Fri, 20 Nov 2026 10:00:02 +0000',
  'Received: from client.other.test ([198.51.100.4])\r\n\tby mx.other.test with ESMTPSA id X9\r\n\tfor <ub1@b.example>; Fri, 20 Nov 2026 10:00:00 +0000',
  'Authentication-Results: mx.a.example; spf=pass smtp.mailfrom=ext@other.test; dmarc=pass header.from=other.test',
  'Subject: Angebot',
].join('\r\n') + '\r\n\r\nBODY-MUST-NOT-BE-READ';

const db: Record<string, Row[]> = {
  domain: [dA, dB],
  user: [
    user('org', 'ORGANIZATION_MANAGEMENT', dA),
    user('coA', 'COMPLIANCE_MANAGEMENT', dA),
    user('ua1', 'USER', dA),
    user('ub1', 'USER', dB),
  ],
  adminScope: [{ id: 'sc-coA', userId: 'coA', domainId: 'dA', domain: { id: 'dA', name: 'a.example' } }],
  systemLog: [
    // inbound, recipient in scope — its trace names an address of the other tenant
    { id: 'lIn', category: 'MAIL_FLOW', timestamp: at(2), level: 'INFO', message: 'Inbound: ext@other.test → ua1@a.example', messageId: '<m1@other.test>', userId: 'ua1',
      metadata: {
        sender: 'ext@other.test', recipient: 'ua1@a.example', subject: 'Angebot', status: 'DELIVERED', messageId: '<m1@other.test>', direction: 'INBOUND',
        storedMessageId: 'msg1',
        trace: { v: 1, stages: [
          stage('connection', 'ok', { clientIp: '203.0.113.9', helo: 'mx.other.test', port: 25, tls: true, tlsVersion: 'TLSv1.3' }),
          stage('spam', 'ok', { verdict: 'inbox', score: 1.2 }, 1),
          stage('aliases', 'info', { expanded: ['team@a.example → ub1@b.example'] }, 1),
          stage('transport-rules', 'info', { ruleIds: ['tr1'], actions: ['subject'] }, 1),
          { stage: 'bad stage', at: 'x', result: 'ok' },
          stage('delivery', 'ok', { outcome: 'stored', mailbox: 'ua1@a.example', folder: 'INBOX' }, 2),
        ] },
      } },
    // the same message for the other tenant's recipient
    { id: 'lIn2', category: 'MAIL_FLOW', timestamp: at(2), level: 'INFO', message: 'Inbound: ext@other.test → ub1@b.example', messageId: '<m1@other.test>', userId: 'ub1',
      metadata: { sender: 'ext@other.test', recipient: 'ub1@b.example', subject: 'Angebot', status: 'DELIVERED', messageId: '<m1@other.test>', direction: 'INBOUND' } },
    // only about b.example
    { id: 'lB', category: 'MAIL_FLOW', timestamp: at(5), level: 'INFO', message: 'Sent', messageId: null, userId: 'ub1',
      metadata: { sender: 'ub1@b.example', recipient: 'x@ext.test', status: 'ACCEPTED', messageId: 'api-job-bbbbbb', direction: 'OUTBOUND' } },
    // outbound: REST accept entry, a deferred attempt, the delivered attempt
    { id: 'lAcc', category: 'MAIL_FLOW', timestamp: at(10), level: 'INFO', message: 'Sent', messageId: null, userId: 'ua1',
      metadata: { sender: 'ua1@a.example', recipient: 'x@ext.test', subject: 'Re', status: 'ACCEPTED', messageId: 'api-job-123456', direction: 'OUTBOUND' } },
    { id: 'lDef', category: 'MAIL_FLOW', timestamp: at(20), level: 'WARN', message: 'Deferred', messageId: 'api-job-123456', userId: 'ua1',
      metadata: {
        sender: 'ua1@a.example', recipient: 'x@ext.test', status: 'DEFERRED', messageId: 'api-job-123456', direction: 'OUTBOUND',
        jobId: 'api-job-123456', attempt: '1', headerMessageId: '<out1@a.example>',
        trace: { v: 1, stages: [
          stage('queued', 'info', { jobId: 'api-job-123456', attempt: 1 }, 10),
          stage('dkim', 'ok', { domain: 'a.example', selector: 'mail' }, 19),
          stage('mx', 'ok', { domain: 'ext.test', records: ['10 mx1.ext.test', '20 mx2.ext.test'] }, 19),
          stage('remote', 'warn', { mode: 'mx', domain: 'ext.test', host: 'mx1.ext.test', address: '93.184.216.34', port: 25, tls: 'starttls', code: 451, response: '451 4.7.1 Greylisted' }, 19),
          stage('queue-result', 'warn', { final: false, reason: 'Temporary failure', attempts: 1, maxAttempts: 10 }, 20),
        ] },
      } },
    { id: 'lDel', category: 'MAIL_FLOW', timestamp: at(90), level: 'INFO', message: 'Delivered', messageId: 'api-job-123456', userId: 'ua1',
      metadata: {
        sender: 'ua1@a.example', recipient: 'x@ext.test', status: 'DELIVERED', messageId: 'api-job-123456', direction: 'OUTBOUND',
        jobId: 'api-job-123456', attempt: '2', headerMessageId: '<out1@a.example>',
        trace: { v: 1, stages: [
          stage('remote', 'ok', { mode: 'mx', domain: 'ext.test', host: 'mx1.ext.test', address: '93.184.216.34', port: 25, tls: 'starttls', code: 250, response: '250 2.0.0 OK' }, 89),
        ] },
      } },
    // an unrelated entry far away in time with the same tracking id must not be listed
    { id: 'lOld', category: 'MAIL_FLOW', timestamp: new Date('2025-01-01T00:00:00Z'), level: 'INFO', message: 'old', messageId: 'api-job-123456', userId: 'ua1',
      metadata: { sender: 'ua1@a.example', recipient: 'x@ext.test', status: 'DELIVERED', messageId: 'api-job-123456', direction: 'OUTBOUND' } },
  ],
  message: [
    { id: 'msg1', messageId: '<m1@other.test>', storagePath: 'raw/aa/msg1', folder: { mailbox: { user: { domainId: 'dA', email: 'ua1@a.example' }, sharedBox: null } } },
  ],
  transportRule: [{ id: 'tr1', name: 'Extern markieren' }],
  session: [],
};
const settings = { id: 'singleton', requireMfaForAdmins: false, auditLogEnabled: true, publicHostname: 'mx.a.example' };

const models: Record<string, Record<string, (...a: unknown[]) => unknown>> = Object.fromEntries(
  Object.entries(db).map(([name, rows]) => [name, memoryModel(rows)]),
);
models['serverSettings'] = { findUnique: () => ({ ...settings }) };
installFakePrisma(models);

const reads: string[] = [];
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem',
  getStream: async (key: string) => { reads.push(key); return Readable.from([Buffer.from(RAW_HEAD)]); },
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { correlationKeys, traceDirection, outboundHops, withRuleNames, isRelated } = await import('./message-trace.js');

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

test('scope: an entry of another domain answers 404 exactly like an unknown or malformed id', async () => {
  const foreign = await call('coA', '/message-trace/lB');
  const unknown = await call('coA', '/message-trace/does-not-exist');
  const malformed = await call('coA', `/message-trace/${encodeURIComponent('x;drop')}`);
  assert.equal(foreign.status, 404);
  assert.deepEqual([unknown.status, unknown.text], [404, foreign.text]);
  assert.deepEqual([malformed.status, malformed.text], [404, foreign.text]);
  assert.equal((await call('org', '/message-trace/lB')).status, 200);
});

test('inbound detail for a scoped admin: stages, Received hops and auth summary — other tenants redacted, related entries filtered', async () => {
  reads.length = 0;
  const r = await call('coA', '/message-trace/lIn');
  assert.equal(r.status, 200);
  assert.ok(!/ub1@b\.example/.test(r.text), 'no address of another hosted domain anywhere');
  assert.ok(!r.text.includes('BODY-MUST-NOT-BE-READ'));
  assert.equal(r.json['direction'], 'inbound');
  const stages = ((r.json['trace'] as Row)['stages'] as Row[]);
  assert.deepEqual(stages.map((s) => s['stage']), ['connection', 'spam', 'aliases', 'transport-rules', 'delivery'], 'malformed stages dropped');
  assert.deepEqual((stages[2]!['detail'] as Row)['expanded'], [`team@a.example → ${OTHER}`]);
  assert.deepEqual((stages[3]!['detail'] as Row)['ruleNames'], ['Extern markieren']);
  assert.equal(((r.json['entry'] as Row)['metadata'] as Row)['trace'], undefined, 'the raw trace is not echoed');
  assert.deepEqual((r.json['related'] as Row[]).map((x) => x['id']), [], 'the other tenant\'s recipient entry is not listed');
  const path = r.json['path'] as Row;
  assert.equal(path['kind'], 'received');
  const hops = path['hops'] as Row[];
  assert.deepEqual(hops.map((h) => [h['by'], h['fromIp'], h['tls']]), [['mx.other.test', '198.51.100.4', true], ['mx.a.example', '203.0.113.9', true]]);
  assert.equal(hops[0]!['for'], OTHER);
  assert.equal(hops[1]!['delayMs'], 2000);
  assert.equal(((path['auth'] as Row)['authResults'] as Row[])[0]!['authservId'], 'mx.a.example');
  assert.deepEqual(reads, ['raw/aa/msg1']);
});

test('inbound detail for an organisation-wide admin lists the other recipient and shows every address', async () => {
  const r = await call('org', '/message-trace/lIn');
  assert.equal(r.status, 200);
  assert.deepEqual((r.json['related'] as Row[]).map((x) => x['id']), ['lIn2']);
  assert.ok(r.text.includes('ub1@b.example'));
});

test('outbound detail: queue attempts correlated by tracking id within the time window; path CoreMail → MX in time order', async () => {
  const r = await call('coA', '/message-trace/lDef');
  assert.equal(r.status, 200);
  assert.equal(r.json['direction'], 'outbound');
  assert.deepEqual((r.json['related'] as Row[]).map((x) => x['id']), ['lAcc', 'lDel']);
  const path = r.json['path'] as Row;
  assert.equal(path['kind'], 'outbound');
  assert.deepEqual((path['hops'] as Row[]).map((h) => [h['from'], h['to'], h['address'], h['tls'], h['code'], h['result']]), [
    ['mx.a.example', 'mx1.ext.test', '93.184.216.34', true, 451, 'warn'],
    ['mx.a.example', 'mx1.ext.test', '93.184.216.34', true, 250, 'ok'],
  ]);
  const acc = await call('coA', '/message-trace/lAcc');
  assert.deepEqual((acc.json['related'] as Row[]).map((x) => x['id']), ['lDef', 'lDel']);
  assert.equal(acc.json['trace'], null, 'entries written before 10.2 have no trace');
});

test('pure: correlation keys, direction, outbound hops, rule names', () => {
  assert.deepEqual(correlationKeys({ messageId: 'api-job-123456', metadata: { messageId: 'api-job-123456', headerMessageId: '<a@b.c>', queueTrackingIds: 'trk-000001, trk-000002' } }),
    ['api-job-123456', '<a@b.c>', 'trk-000001', 'trk-000002']);
  assert.deepEqual(correlationKeys({ messageId: null, metadata: { messageId: '' } }), []);
  assert.equal(isRelated({ metadata: { messageId: 'trk-000001' } }, { messageId: 'trk-000001', metadata: {} }), true);
  assert.equal(isRelated({ metadata: { messageId: 'trk-000001' } }, { messageId: 'other-1234', metadata: {} }), false);
  const hosted = ['a.example', 'b.example'];
  assert.equal(traceDirection({ sender: 'ua1@a.example', recipient: 'ub1@b.example, x@a.example', direction: 'OUTBOUND' }, hosted), 'internal');
  assert.equal(traceDirection({ sender: 'ua1@a.example', recipient: 'x@ext.test', direction: 'OUTBOUND' }, hosted), 'outbound');
  assert.equal(traceDirection({ sender: 'x@ext.test', recipient: 'ua1@a.example', direction: 'INBOUND' }, hosted), 'inbound');
  assert.equal(traceDirection({}, hosted), 'unknown');
  const hops = outboundHops([
    { stage: 'remote', at: at(5).toISOString(), result: 'ok', detail: { host: 'b', tls: 'none' } },
    { stage: 'remote', at: at(1).toISOString(), result: 'warn', detail: { host: 'a', tls: 'implicit', port: 465 } },
    { stage: 'mx', at: at(0).toISOString(), result: 'ok', detail: { domain: 'x' } },
  ], 'mx.a.example');
  assert.deepEqual(hops.map((h) => [h.to, h.tls, h.port]), [['a', true, 465], ['b', false, undefined]]);
  const named = withRuleNames([{ stage: 'transport-rules', at: at(0).toISOString(), result: 'info', detail: { ruleIds: ['tr1', 'gone'] } }], new Map([['tr1', 'R1']]));
  assert.deepEqual(named[0]!.detail?.['ruleNames'], ['R1']);
});
