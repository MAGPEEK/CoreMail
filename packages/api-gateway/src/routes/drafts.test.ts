/**
 * Server drafts (routes/drafts.ts): CRUD, ownership (IDOR → 404), attachment
 * reuse, send-from-draft parity with POST /mail/send (shared send core, rate
 * limit), undo hold / unsend, double-send claim and message-store invariants.
 * In-memory Prisma (globalThis.__prisma), object store (__objectStore) and
 * outbound queue (__outboundQueue).
 * Run: node --import tsx --test --test-force-exit src/routes/drafts.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
process.env['MAIL_SEND_RATE_LIMIT'] = '40';

type Row = Record<string, unknown>;

// ── In-memory database ────────────────────────────────────────────────────────
const users: Record<string, Row> = {
  u1: { id: 'u1', email: 'u1@ex.com', displayName: 'User One', domain: { name: 'ex.com', dkimPrivateKey: null, dkimSelector: null } },
  u2: { id: 'u2', email: 'u2@ex.com', displayName: 'User Two', domain: { name: 'ex.com', dkimPrivateKey: null, dkimSelector: null } },
};
const mailboxes: Record<string, { id: string; userId: string; uidNext: number; highestModSeq: bigint }> = {
  mb1: { id: 'mb1', userId: 'u1', uidNext: 1, highestModSeq: 0n },
  mb2: { id: 'mb2', userId: 'u2', uidNext: 1, highestModSeq: 0n },
};
const folders: Array<Row & { id: string; name: string; mailboxId: string; totalCount: number }> = [
  { id: 'd1', name: 'Drafts', mailboxId: 'mb1', totalCount: 0 },
  { id: 's1', name: 'Sent', mailboxId: 'mb1', totalCount: 0 },
  { id: 'i1', name: 'INBOX', mailboxId: 'mb1', totalCount: 0 },
  { id: 'd2', name: 'Drafts', mailboxId: 'mb2', totalCount: 0 },
  { id: 's2', name: 'Sent', mailboxId: 'mb2', totalCount: 0 },
];
const sharedPerms = [
  { userId: 'u1', permission: 'SEND_AS', sharedMailbox: { email: 'team@ex.com', displayName: 'Team', active: true } },
];
const messages = new Map<string, Row>();
const attachments: Row[] = [];
/** Quota usage per user id (bytes) for the receive-quota check. */
const usage: Record<string, number> = {};
/** Makes message update/updateMany throw for matching data (DB failure injection). */
let failMessageWrite: ((data: Row) => boolean) | null = null;
const modSeqLog: Array<{ mailboxId: string; modSeq: bigint }> = [];
let seq = 0;

const folderOf = (id: unknown) => folders.find((f) => f.id === id);
function matchFolder(f: Row | undefined, w: Row): boolean {
  if (!f) return false;
  for (const [k, v] of Object.entries(w)) {
    if (k === 'mailbox') {
      const mb = mailboxes[f['mailboxId'] as string];
      if (!mb || (v as Row)['userId'] !== mb.userId) return false;
    } else if (v && typeof v === 'object' && 'in' in (v as Row)) {
      if (!((v as { in: unknown[] }).in).includes(f[k])) return false;
    } else if (f[k] !== v) return false;
  }
  return true;
}
function match(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'NOT') { if (match(row, v as Row)) return false; continue; }
    if (k === 'folder') { if (!matchFolder(folderOf(row['folderId']), v as Row)) return false; continue; }
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in (v as Row)) {
      if (!((v as { in: unknown[] }).in).includes(row[k])) return false;
      continue;
    }
    if ((row[k] ?? null) !== v) return false;
  }
  return true;
}
function withIncludes(row: Row, a: { include?: Row; select?: Row }): Row {
  const out: Row = { ...row };
  if (a.include?.['attachments']) out['attachments'] = attachments.filter((x) => x['messageId'] === row['id']);
  if (a.include?.['folder'] || a.select?.['folder']) { const f = folderOf(row['folderId'])!; out['folder'] = { id: f.id, mailboxId: f.mailboxId }; }
  return out;
}
function applyData(target: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && ('increment' in (v as Row) || 'decrement' in (v as Row))) {
      const inc = (v as Row)['increment'] as number | undefined;
      const dec = (v as Row)['decrement'] as number | undefined;
      const cur = target[k];
      target[k] = typeof cur === 'bigint' ? cur + BigInt(inc ?? 0) - BigInt(dec ?? 0) : (cur as number) + (inc ?? 0) - (dec ?? 0);
    } else target[k] = v;
  }
}

installFakePrisma({
  user: { findUnique: (a) => users[(a as { where: { id: string } }).where.id] ?? null },
  mailbox: {
    update: (a) => {
      const q = a as { where: { id: string }; data: Row };
      const mb = mailboxes[q.where.id]!;
      applyData(mb as unknown as Row, q.data);
      modSeqLog.push({ mailboxId: mb.id, modSeq: mb.highestModSeq });
      return { uidNext: mb.uidNext, highestModSeq: mb.highestModSeq };
    },
  },
  folder: {
    findFirst: (a) => folders.find((f) => matchFolder(f, (a as { where: Row }).where)) ?? null,
    findUnique: (a) => folderOf((a as { where: { id: string } }).where.id) ?? null,
    update: (a) => { const q = a as { where: { id: string }; data: Row }; const f = folderOf(q.where.id)!; applyData(f, q.data); return f; },
  },
  message: {
    findFirst: (a) => {
      const q = a as { where: Row; include?: Row; select?: Row };
      const row = [...messages.values()].find((m) => match(m, q.where));
      return row ? withIncludes(row, q) : null;
    },
    findMany: (a) => [...messages.values()].filter((m) => match(m, (a as { where: Row }).where))
      .sort((x, y) => (x['uid'] as number) - (y['uid'] as number))
      .map((m) => ((a as { select?: Row }).select?.['attachments'] ? { ...m, attachments: attachments.filter((x) => x['messageId'] === m['id']) } : m)),
    count: (a) => [...messages.values()].filter((m) => match(m, (a as { where: Row }).where)).length,
    aggregate: (a) => {
      // quota usage (mailbox-quota usageWhere: folder.mailbox.userId)
      const userId = (((a as { where?: Row }).where?.['folder'] as Row | undefined)?.['mailbox'] as Row | undefined)?.['userId'];
      return { _max: { modSeq: null, uid: null }, ...(typeof userId === 'string' && usage[userId] !== undefined ? { _sum: { rawSize: usage[userId] } } : {}) };
    },
    create: (a) => {
      const data = { ...(a as { data: Row }).data };
      const id = `m${++seq}`;
      const nested = data['attachments'] as { create: Row[] } | undefined;
      delete data['attachments'];
      const row: Row = { deletedAt: null, scheduledAt: null, scheduledStatus: null, scheduledJobId: null, createdAt: new Date(), ...data, id };
      messages.set(id, row);
      for (const att of nested?.create ?? []) attachments.push({ id: `a${++seq}`, ...att, messageId: id });
      return row;
    },
    update: (a) => {
      const q = a as { where: { id: string }; data: Row };
      if (failMessageWrite?.(q.data)) throw new Error('db write failed');
      const m = messages.get(q.where.id)!; applyData(m, q.data); return m;
    },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      if (failMessageWrite?.(q.data)) throw new Error('db write failed');
      let count = 0;
      for (const m of messages.values()) if (match(m, q.where)) { applyData(m, q.data); count++; }
      return { count };
    },
  },
  attachment: {
    findMany: (a) => attachments.filter((x) => x['messageId'] === (a as { where: { messageId: string } }).where.messageId),
    count: (a) => attachments.filter((x) => x['storagePath'] === (a as { where: { storagePath: string } }).where.storagePath).length,
    deleteMany: (a) => {
      const ids = ((a as { where: { messageId: { in: string[] } } }).where.messageId.in);
      const keep = attachments.filter((x) => !ids.includes(String(x['messageId'])));
      const n = attachments.length - keep.length;
      attachments.splice(0, attachments.length, ...keep);
      return { count: n };
    },
  },
  sharedMailboxPerm: {
    findFirst: (a) => {
      const w = (a as { where: { userId: string; permission: string | { in: string[] }; sharedMailbox: { email: string } } }).where;
      const perms = typeof w.permission === 'string' ? [w.permission] : w.permission.in;
      return sharedPerms.find((p) => p.userId === w.userId && perms.includes(p.permission) && p.sharedMailbox.email === w.sharedMailbox.email) ?? null;
    },
  },
});

// ── Object store + outbound queue + rate-limit Redis ─────────────────────────
const objects = new Map<string, Buffer>();
const notFound = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { code: 'NoSuchKey' });
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  init: async () => ({ lifecycle: false }),
  put: async (k: string, d: Buffer) => { objects.set(k, Buffer.from(d)); },
  putStream: async (k: string, s: Readable) => { const c: Buffer[] = []; for await (const x of s) c.push(Buffer.from(x as Buffer)); objects.set(k, Buffer.concat(c)); },
  get: async (k: string) => { const b = objects.get(k); if (!b) throw notFound(k); return b; },
  getStream: async (k: string) => { const b = objects.get(k); if (!b) throw notFound(k); return Readable.from([b]); },
  stat: async (k: string) => (objects.has(k) ? { size: objects.get(k)!.length, lastModified: new Date() } : null),
  exists: async (k: string) => objects.has(k),
  delete: async (k: string) => { objects.delete(k); },
  list: async function* () { /* unused */ },
};

interface FakeJob { id: string; data: Row; opts: Row; state: string; getState(): Promise<string>; remove(): Promise<void> }
const jobs = new Map<string, FakeJob>();
let queueFails = false;
(globalThis as Record<string, unknown>)['__outboundQueue'] = {
  add: async (_name: string, data: Row, opts: Row) => {
    if (queueFails) throw new Error('redis down');
    const job: FakeJob = {
      id: String(opts['jobId']), data, opts, state: opts['delay'] ? 'delayed' : 'waiting',
      getState: async () => job.state,
      remove: async () => { if (job.state === 'active') throw new Error('locked'); jobs.delete(job.id); },
    };
    jobs.set(job.id, job);
    return job;
  },
  getJob: async (id: string) => jobs.get(id),
};
const counters = new Map<string, number>();
(globalThis as Record<string, unknown>)['__rateLimitRedis'] = {
  incr: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
  expire: async () => 1,
};
const draftState = new Map<string, string>();
let draftStateDown = false;
(globalThis as Record<string, unknown>)['__draftStateRedis'] = {
  get: async (k: string) => { if (draftStateDown) throw new Error('redis down'); return draftState.get(k) ?? null; },
  set: async (k: string, v: string) => { if (draftStateDown) throw new Error('redis down'); draftState.set(k, v); return 'OK'; },
  del: async (k: string) => { draftState.delete(k); return 1; },
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { draftsRouter } = await import('./drafts.js');
const { mailRouter } = await import('./mail.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: false });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mail/drafts', draftsRouter);
  app.use('/api/v1/mail', mailRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, opts: { user?: string; body?: unknown; form?: FormData } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = {};
  if (!opts.form) headers['content-type'] = 'application/json';
  if (opts.user) headers['authorization'] = `Bearer ${tok(opts.user)}`;
  const body = opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const r = await fetch(`${base}/api/v1/mail${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

const rawOf = (id: string) => objects.get(String(messages.get(id)!['storagePath']))!.toString('utf8');

/** Message-store invariants: unique UIDs per folder, uid < uidNext, modSeq ≤ highestModSeq. */
function assertStoreInvariants(): void {
  const seen = new Set<string>();
  for (const m of messages.values()) {
    const key = `${String(m['folderId'])}:${String(m['uid'])}`;
    assert.ok(!seen.has(key), `duplicate UID ${key}`);
    seen.add(key);
    const mb = mailboxes[folderOf(m['folderId'])!.mailboxId]!;
    assert.ok((m['uid'] as number) < mb.uidNext, 'uid below uidNext');
    assert.ok((m['modSeq'] as bigint) <= mb.highestModSeq, 'modSeq within highestModSeq');
  }
  for (const mbId of Object.keys(mailboxes)) {
    const seqs = modSeqLog.filter((x) => x.mailboxId === mbId).map((x) => x.modSeq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, 'modSeq strictly increasing');
  }
}

test('draft CRUD: create, load (incl. Bcc), replace with new UID + expunged old version, discard', async () => {
  const created = await call('POST', '/drafts', { user: 'u1', body: {
    to: ['Jörg <joerg@x.test>', 'bob'], bcc: ['hidden@x.test'], subject: 'Hallo', bodyHtml: '<p>Text</p>', bodyText: 'Text',
  } });
  assert.equal(created.status, 201);
  const id1 = String(created.json['id']);
  const row1 = messages.get(id1)!;
  assert.equal(row1['folderId'], 'd1');
  assert.deepEqual(row1['flags'], ['\\Draft', '\\Seen']);
  assert.ok(row1['storagePath'], 'raw original stored');
  assert.match(rawOf(id1), /^Bcc: hidden@x\.test/m);
  assert.equal(folderOf('d1')!.totalCount, 1);

  const loaded = await call('GET', `/drafts/${id1}`, { user: 'u1' });
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.json['to'], ['Jörg <joerg@x.test>', 'bob']);
  assert.deepEqual(loaded.json['bcc'], ['hidden@x.test']);
  assert.equal(loaded.json['subject'], 'Hallo');
  assert.match(String(loaded.json['bodyHtml']), /<p>Text<\/p>/);
  assert.equal(loaded.json['sendAs'], null);

  const oldRawKey = String(row1['storagePath']);
  const replaced = await call('PUT', `/drafts/${id1}`, { user: 'u1', body: { to: ['bob@x.test'], subject: 'Hallo 2', bodyHtml: '<p>Neu</p>' } });
  assert.equal(replaced.status, 200);
  const id2 = String(replaced.json['id']);
  assert.notEqual(id2, id1);
  const row2 = messages.get(id2)!;
  assert.ok(messages.get(id1)!['deletedAt'] instanceof Date, 'old version expunged');
  assert.ok((row2['uid'] as number) > (row1['uid'] as number), 'new UID');
  assert.ok((messages.get(id1)!['modSeq'] as bigint) >= (row2['modSeq'] as bigint), 'expunge has its own modSeq');
  assert.equal(row2['messageId'], row1['messageId'], 'Message-ID stays stable across versions');
  assert.equal(folderOf('d1')!.totalCount, 1);
  assert.equal((await call('GET', `/drafts/${id1}`, { user: 'u1' })).status, 404, 'old version is gone');
  const stale = await call('PUT', `/drafts/${id1}`, { user: 'u1', body: { subject: 'x' } });
  assert.deepEqual([stale.status, stale.json['code'], stale.json['currentId']], [409, 'DRAFT_SUPERSEDED', id2], 'stale replace names the current version');
  // 8.1: the replaced version is no recoverable item and holds no objects
  const old = messages.get(id1)!;
  assert.ok((old['flags'] as string[]).includes('$CoreMailSuperseded'));
  assert.deepEqual([old['storagePath'], old['rawSize'], old['bodyHtml']], [null, 0, '']);
  assert.ok(!objects.has(oldRawKey), 'raw object of the old version deleted');

  assert.equal((await call('DELETE', `/drafts/${id2}`, { user: 'u1' })).status, 200);
  assert.ok(messages.get(id2)!['deletedAt'] instanceof Date);
  assert.equal(folderOf('d1')!.totalCount, 0);
  assert.equal((await call('DELETE', `/drafts/${id2}`, { user: 'u1' })).status, 404);
  assertStoreInvariants();
});

test('attachments: uploaded once, kept by id on replace (same object, no new upload), dropped otherwise', async () => {
  const form = new FormData();
  form.append('draft', JSON.stringify({ to: ['a@x.test'], subject: 'Anhang' }));
  form.append('attachments', new Blob([Buffer.from('PDFDATA'.repeat(100))], { type: 'application/pdf' }), 'report.pdf');
  const created = await call('POST', '/drafts', { user: 'u1', form });
  assert.equal(created.status, 201);
  const atts = created.json['attachments'] as Row[];
  assert.equal(atts.length, 1);
  assert.equal(atts[0]!['filename'], 'report.pdf');
  const firstKey = String(attachments.find((a) => a['id'] === atts[0]!['id'])!['storagePath']);
  const objectCount = objects.size;

  const kept = await call('PUT', `/drafts/${String(created.json['id'])}`, { user: 'u1', body: { to: ['a@x.test'], subject: 'Anhang 2', keepAttachmentIds: [atts[0]!['id']] } });
  assert.equal(kept.status, 200);
  const keptAtts = kept.json['attachments'] as Row[];
  assert.equal(keptAtts.length, 1);
  const keptRow = attachments.find((a) => a['id'] === keptAtts[0]!['id'])!;
  assert.equal(keptRow['storagePath'], firstKey, 'object reused');
  assert.equal(objects.size, objectCount, 'new raw written, old raw released, kept attachment not stored again');
  assert.ok(objects.has(firstKey), 'kept attachment object still there');
  // the superseded id resolves to the new version, with the attachment id mapping
  const stale = await call('PUT', `/drafts/${String(created.json['id'])}`, { user: 'u1', body: { keepAttachmentIds: [atts[0]!['id']] } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json['attachmentIds'], { [String(atts[0]!['id'])]: keptAtts[0]!['id'] });

  assert.equal((await call('PUT', `/drafts/${String(kept.json['id'])}`, { user: 'u1', body: { keepAttachmentIds: ['nope'] } })).status, 400);
  const dropped = await call('PUT', `/drafts/${String(kept.json['id'])}`, { user: 'u1', body: { subject: 'ohne' } });
  assert.equal(dropped.status, 200);
  assert.deepEqual(dropped.json['attachments'], []);
  assert.ok(!objects.has(firstKey), 'dropped attachment object released');

  // the same file attached twice is stored once
  const twice = new FormData();
  twice.append('draft', JSON.stringify({ to: ['a@x.test'], subject: 'zweimal' }));
  for (const name of ['x.bin', 'y.bin']) twice.append('attachments', new Blob([Buffer.from('SAME'.repeat(50))], { type: 'application/octet-stream' }), name);
  const t = await call('POST', '/drafts', { user: 'u1', form: twice });
  const keys = attachments.filter((a) => a['messageId'] === t.json['id']).map((a) => a['storagePath']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'one object for equal content');
  assert.equal((await call('POST', '/drafts', { user: 'u1', body: { keepAttachmentIds: [keptAtts[0]!['id']] } })).status, 400, 'create cannot keep');
});

test('ownership: another user\'s draft id, or a non-draft message, is a 404 everywhere', async () => {
  const mine = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'privat' } });
  const id = String(mine.json['id']);
  assert.equal((await call('GET', `/drafts/${id}`, { user: 'u2' })).status, 404);
  assert.equal((await call('PUT', `/drafts/${id}`, { user: 'u2', body: { subject: 'hijack' } })).status, 404);
  assert.equal((await call('DELETE', `/drafts/${id}`, { user: 'u2' })).status, 404);
  assert.equal((await call('POST', `/drafts/${id}/send`, { user: 'u2', body: {} })).status, 404);
  assert.equal(messages.get(id)!['deletedAt'], null, 'untouched');
  assert.equal((await call('GET', `/drafts/${id}`)).status, 401);
  // a message in the owner's INBOX is not a draft
  const inbox = messages.get(id)!;
  messages.set('inbox-msg', { ...inbox, id: 'inbox-msg', folderId: 'i1', uid: 999 });
  mailboxes['mb1']!.uidNext = Math.max(mailboxes['mb1']!.uidNext, 1000);
  assert.equal((await call('GET', '/drafts/inbox-msg', { user: 'u1' })).status, 404);
  assert.equal((await call('DELETE', '/drafts/inbox-msg', { user: 'u1' })).status, 404);
  messages.delete('inbox-msg');
});

test('send-from-draft runs the /send checks: recipients, sender permission, schedule window', async () => {
  // invalid recipient → same 400 as /send; the draft stays and is not claimed
  const bad = await call('POST', '/drafts', { user: 'u1', body: { to: ['bob'], subject: 's' } });
  const badId = String(bad.json['id']);
  const viaDraft = await call('POST', `/drafts/${badId}/send`, { user: 'u1', body: {} });
  const viaSend = await call('POST', '/send', { user: 'u1', body: { to: ['bob'], subject: 's' } });
  assert.equal(viaDraft.status, 400);
  assert.equal(viaDraft.json['error'], viaSend.json['error']);
  assert.equal(messages.get(badId)!['folderId'], 'd1');
  assert.equal(messages.get(badId)!['scheduledStatus'], null, 'claim released');

  const none = await call('POST', '/drafts', { user: 'u1', body: { subject: 'ohne Empfänger' } });
  const noneSend = await call('POST', `/drafts/${String(none.json['id'])}/send`, { user: 'u1', body: {} });
  assert.equal(noneSend.status, 400);
  assert.equal(noneSend.json['error'], (await call('POST', '/send', { user: 'u1', body: { to: [], subject: 's' } })).json['error']);

  // send-as needs the shared-mailbox permission (already when saving)
  assert.equal((await call('POST', '/drafts', { user: 'u2', body: { to: ['a@x.test'], sendAs: 'team@ex.com' } })).status, 403);

  const ok = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'später' } });
  const tooSoon = await call('POST', `/drafts/${String(ok.json['id'])}/send`, { user: 'u1', body: { scheduledAt: new Date(Date.now() + 5_000).toISOString() } });
  assert.equal(tooSoon.status, 400);
  assert.match(String(tooSoon.json['error']), /30 Sekunden/);
  assert.equal((await call('POST', `/drafts/${String(ok.json['id'])}/send`, { user: 'u1', body: { undoDelaySec: 31 } })).status, 400);
});

test('send-from-draft enqueues like /send, then the draft becomes the Sent copy', async () => {
  const form = new FormData();
  form.append('draft', JSON.stringify({ to: ['Jörg <joerg@x.test>'], cc: ['c@x.test'], bcc: ['b@x.test'], subject: 'Bericht', bodyHtml: '<p>Hi</p>', sendAs: 'team@ex.com' }));
  form.append('attachments', new Blob([Buffer.from('attachment-bytes')], { type: 'text/plain' }), 'a.txt');
  const d = await call('POST', '/drafts', { user: 'u1', form });
  const id = String(d.json['id']);
  const draftAttKey = String(attachments.find((a) => a['messageId'] === id)!['storagePath']);
  const draftMid = messages.get(id)!['messageId'];

  const before = jobs.size;
  const r = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json['scheduled'], false);
  assert.equal(jobs.size, before + 1);
  const job = [...jobs.values()].at(-1)!;
  const m = job.data['message'] as Row;
  assert.equal(job.data['from'], 'team@ex.com', 'send-as resolved like /send');
  assert.deepEqual(job.data['to'], ['joerg@x.test', 'c@x.test', 'b@x.test'], 'envelope: bare addresses');
  assert.equal(job.data['dsn'], undefined, 'no delivery receipt asked for');
  assert.deepEqual(m['bcc'], ['b@x.test']);
  assert.equal(m['messageId'], draftMid, 'draft Message-ID is kept');
  const qAtt = (m['attachments'] as Row[])[0]!;
  assert.match(String(qAtt['minioPath']), /^outbound-queue\//);
  assert.equal(objects.get(String(qAtt['minioPath']))!.toString(), 'attachment-bytes', 'copied to the outbound key');
  assert.ok(objects.has(draftAttKey), 'draft attachment object untouched (worker deletes only outbound keys)');

  const row = messages.get(id)!;
  assert.equal(row['folderId'], 's1', 'moved to Sent');
  assert.ok(!(row['flags'] as string[]).includes('\\Draft'));
  assert.equal(row['scheduledStatus'], null);
  assert.equal((await call('GET', `/drafts/${id}`, { user: 'u1' })).status, 404);
  assert.equal((await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} })).status, 404, 'cannot send twice');
  assertStoreInvariants();
});

test('queue failure: 500 and the draft stays in Drafts, unclaimed', async () => {
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'q' } });
  const id = String(d.json['id']);
  queueFails = true;
  const r = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} });
  queueFails = false;
  assert.equal(r.status, 500);
  assert.equal(messages.get(id)!['folderId'], 'd1');
  assert.equal(messages.get(id)!['scheduledStatus'], null);
  assert.equal((await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} })).status, 200, 'retry works');
});

test('concurrent sends of one draft enqueue exactly one job', async () => {
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'race' } });
  const id = String(d.json['id']);
  const before = jobs.size;
  const results = await Promise.all([1, 2, 3].map(() => call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} })));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  assert.ok(results.every((x) => [200, 404, 409].includes(x.status)));
  assert.equal(jobs.size, before + 1);
});

test('undo hold: delayed job + PENDING Sent copy; unsend moves it back to Drafts; too late → 409', async () => {
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'undo' } });
  const id = String(d.json['id']);
  const r = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: { undoDelaySec: 10 } });
  assert.equal(r.status, 200);
  assert.ok(r.json['sendAt']);
  const job = [...jobs.values()].at(-1)!;
  assert.equal(job.opts['delay'], 10_000);
  const sentRow = messages.get(id)!;
  assert.equal(sentRow['folderId'], 's1');
  assert.equal(sentRow['scheduledStatus'], 'PENDING');
  assert.equal(sentRow['scheduledJobId'], job.id);
  const sentUid = sentRow['uid'] as number;

  const undo = await call('POST', `/drafts/${id}/unsend`, { user: 'u2', body: {} });
  assert.equal(undo.status, 404, 'not the owner');
  const undone = await call('POST', `/drafts/${id}/unsend`, { user: 'u1', body: {} });
  assert.equal(undone.status, 200);
  assert.ok(!jobs.has(job.id), 'job removed');
  const back = messages.get(id)!;
  assert.equal(back['folderId'], 'd1');
  assert.ok((back['flags'] as string[]).includes('\\Draft'));
  assert.equal(back['scheduledStatus'], null);
  assert.ok((back['uid'] as number) > sentUid, 'new UID in Drafts');
  assert.equal((await call('GET', `/drafts/${id}`, { user: 'u1' })).status, 200, 'editable again');
  assert.equal((await call('POST', `/drafts/${id}/unsend`, { user: 'u1', body: {} })).status, 404);

  // the worker already picked it up → too late
  await call('POST', `/drafts/${id}/send`, { user: 'u1', body: { undoDelaySec: 5 } });
  [...jobs.values()].at(-1)!.state = 'active';
  assert.equal((await call('POST', `/drafts/${id}/unsend`, { user: 'u1', body: {} })).status, 409);
  assert.equal(messages.get(id)!['folderId'], 's1');
  assertStoreInvariants();
});

test('send-from-draft shares the per-user send rate limit with /send', async () => {
  const d = await call('POST', '/drafts', { user: 'u2', body: { to: ['a@x.test'], subject: 'rl' } });
  const id = String(d.json['id']);
  for (let i = 0; i < 40; i++) await call('POST', '/send', { user: 'u2', body: { to: [], subject: 's' } });
  const limited = await call('POST', `/drafts/${id}/send`, { user: 'u2', body: {} });
  assert.equal(limited.status, 429);
  assert.equal(messages.get(id)!['folderId'], 'd2');
});

// ── 8.1 review fixes ──────────────────────────────────────────────────────────

test('a draft being sent: PUT → 409 DRAFT_SENDING, DELETE → 409 (stale claim: deletable again)', async () => {
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'claimed' } });
  const id = String(d.json['id']);
  Object.assign(messages.get(id)!, { scheduledStatus: 'SENDING', scheduledAt: new Date() });
  const put = await call('PUT', `/drafts/${id}`, { user: 'u1', body: { subject: 'x' } });
  assert.deepEqual([put.status, put.json['code']], [409, 'DRAFT_SENDING']);
  const del = await call('DELETE', `/drafts/${id}`, { user: 'u1' });
  assert.deepEqual([del.status, del.json['code']], [409, 'DRAFT_SENDING']);
  assert.equal(messages.get(id)!['deletedAt'], null, 'not deleted under a running send');
  // an abandoned claim (process crash) does not block forever
  messages.get(id)!['scheduledAt'] = new Date(Date.now() - 120_000);
  assert.equal((await call('DELETE', `/drafts/${id}`, { user: 'u1' })).status, 200);
});

test('superseded chain: an id two versions old resolves to the newest; unknown id → 404 DRAFT_GONE', async () => {
  const a = await call('POST', '/drafts', { user: 'u1', body: { subject: 'v1' } });
  const b = await call('PUT', `/drafts/${String(a.json['id'])}`, { user: 'u1', body: { subject: 'v2' } });
  const c = await call('PUT', `/drafts/${String(b.json['id'])}`, { user: 'u1', body: { subject: 'v3' } });
  assert.equal(c.json['supersedes'], b.json['id']);
  const stale = await call('PUT', `/drafts/${String(a.json['id'])}`, { user: 'u1', body: { subject: 'tab 2' } });
  assert.deepEqual([stale.status, stale.json['currentId']], [409, c.json['id']]);
  // another user never learns about the chain
  assert.equal((await call('PUT', `/drafts/${String(a.json['id'])}`, { user: 'u2', body: {} })).status, 404);
  const gone = await call('PUT', '/drafts/never-existed', { user: 'u1', body: {} });
  assert.deepEqual([gone.status, gone.json['code']], [404, 'DRAFT_GONE']);
});

test('send-from-draft carries inline images (cid without brackets, inline) to the outbound job', async () => {
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'inline', bodyHtml: '<p>x</p>' } });
  const id = String(d.json['id']);
  attachments.push({ id: 'att-inline', messageId: id, filename: 'logo.png', mimeType: 'image/png', size: 4, sha256: 'x', storagePath: 'attachments/inline/logo', contentId: '<logo@x>', inline: true });
  objects.set('attachments/inline/logo', Buffer.from('PNG!'));
  const r = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} });
  assert.equal(r.status, 200);
  const qAtt = (([...jobs.values()].at(-1)!.data['message'] as Row)['attachments'] as Row[])[0]!;
  assert.equal(qAtt['cid'], 'logo@x');
  assert.equal(qAtt['inline'], true);
});

test('post-enqueue failure: queued draft is marked SENT/PENDING, never re-sendable; undo still works', async () => {
  // move to Sent fails → fallback state in Drafts, 200
  const d = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'fallback' } });
  const id = String(d.json['id']);
  failMessageWrite = (data) => data['folderId'] === 's1';
  const r = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} });
  failMessageWrite = null;
  assert.equal(r.status, 200);
  const row = messages.get(id)!;
  assert.deepEqual([row['folderId'], row['scheduledStatus']], ['d1', 'SENT']);
  const before = jobs.size;
  const again = await call('POST', `/drafts/${id}/send`, { user: 'u1', body: {} });
  assert.deepEqual([again.status, again.json['code']], [409, 'DRAFT_SENT']);
  assert.equal(jobs.size, before, 'not enqueued twice');
  assert.equal((await call('PUT', `/drafts/${id}`, { user: 'u1', body: { subject: 'x' } })).json['code'], 'DRAFT_SENT');

  // held send + failed move → PENDING with the job id in Drafts; unsend works
  const h = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'held' } });
  const hid = String(h.json['id']);
  failMessageWrite = (data) => data['folderId'] === 's1';
  assert.equal((await call('POST', `/drafts/${hid}/send`, { user: 'u1', body: { undoDelaySec: 10 } })).status, 200);
  failMessageWrite = null;
  const job = [...jobs.values()].at(-1)!;
  assert.deepEqual([messages.get(hid)!['scheduledStatus'], messages.get(hid)!['scheduledJobId']], ['PENDING', job.id]);
  assert.equal((await call('POST', `/drafts/${hid}/unsend`, { user: 'u1', body: {} })).status, 200);
  assert.ok(!jobs.has(job.id));
  assert.equal(messages.get(hid)!['scheduledStatus'], null);
  assert.equal((await call('PUT', `/drafts/${hid}`, { user: 'u1', body: { to: ['a@x.test'], subject: 'edited' } })).status, 200, 'editable after undo');

  // every DB write fails → non-200 with queued:true, the claim is kept, no resend
  const z = await call('POST', '/drafts', { user: 'u1', body: { to: ['a@x.test'], subject: 'zero' } });
  const zid = String(z.json['id']);
  failMessageWrite = (data) => data['folderId'] === 's1' || data['scheduledStatus'] === 'SENT';
  const zr = await call('POST', `/drafts/${zid}/send`, { user: 'u1', body: {} });
  failMessageWrite = null;
  assert.deepEqual([zr.status, zr.json['code'], zr.json['queued']], [500, 'SEND_STATE_UNSAVED', true]);
  assert.equal(messages.get(zid)!['scheduledStatus'], 'SENDING', 'claim not released');
  messages.get(zid)!['scheduledAt'] = new Date(Date.now() - 120_000); // claim expired
  const n = jobs.size;
  assert.equal((await call('POST', `/drafts/${zid}/send`, { user: 'u1', body: {} })).json['code'], 'DRAFT_SENT');
  // also when Redis is down (in-process fallback of the draft state)
  draftStateDown = true;
  assert.equal((await call('POST', `/drafts/${zid}/send`, { user: 'u1', body: {} })).json['code'], 'DRAFT_SENT');
  draftStateDown = false;
  assert.equal(jobs.size, n, 'never re-sent');
});

test('9.4 importance: stored in the draft (headers + column), loaded back, carried to the outbound job; CRLF only', async () => {
  const created = await call('POST', '/drafts', { user: 'u1', body: { to: ['imp@x.test'], subject: 'Wichtig', bodyText: 'a\nb\n', importance: 'high' } });
  assert.equal(created.status, 201);
  const id = String(created.json['id']);
  const raw = rawOf(id);
  assert.match(raw, /^Importance: High\r$/m);
  assert.match(raw, /^X-Priority: 1 \(Highest\)\r$/m);
  assert.doesNotMatch(raw, /(^|[^\r])\n/, 'generated MIME uses CRLF line ends only');
  assert.equal(messages.get(id)!['importance'], 'high');
  assert.equal((await call('GET', `/drafts/${id}`, { user: 'u1' })).json['importance'], 'high');

  const low = await call('PUT', `/drafts/${id}`, { user: 'u1', body: { to: ['imp@x.test'], subject: 'Wichtig', importance: 'low' } });
  const lowId = String(low.json['id']);
  assert.equal((await call('GET', `/drafts/${lowId}`, { user: 'u1' })).json['importance'], 'low');
  const sent = await call('POST', `/drafts/${lowId}/send`, { user: 'u1', body: { requestDeliveryReceipt: true } });
  assert.equal(sent.status, 200);
  const job = [...jobs.values()].at(-1)!;
  assert.equal((job.data['message'] as Row)['importance'], 'low');
  // 9.4: delivery receipt = success DSN for every envelope recipient
  assert.deepEqual(job.data['dsn'], { ret: 'HDRS', rcpts: { 'imp@x.test': { notify: ['SUCCESS', 'FAILURE'] } } });

  const normal = await call('POST', '/drafts', { user: 'u1', body: { to: ['imp@x.test'], subject: 'Normal' } });
  const nid = String(normal.json['id']);
  assert.doesNotMatch(rawOf(nid), /Importance|X-Priority/i);
  assert.equal(messages.get(nid)!['importance'] ?? null, null);
  assert.equal((await call('GET', `/drafts/${nid}`, { user: 'u1' })).json['importance'], 'normal');
  assert.equal((await call('POST', '/drafts', { user: 'u1', body: { to: [], importance: 'urgent' } })).status, 400);
  await call('DELETE', `/drafts/${nid}`, { user: 'u1' });
});

test('draft writes: refused at ProhibitSendReceive; per-user rate limit', async () => {
  Object.assign(users['u2']!, { quotaBytes: 1000n, usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null, mailbox: { id: 'mb2' } });
  usage['u2'] = 2000;
  const full = await call('POST', '/drafts', { user: 'u2', body: { to: ['a@x.test'], subject: 'voll' } });
  assert.deepEqual([full.status, full.json['code']], [403, 'MAILBOX_FULL']);
  delete usage['u2'];
  delete users['u2']!['quotaBytes'];
  (await import('@coremail/storage')).resetQuotaCache();

  let limited = 0;
  for (let i = 0; i < 70 && !limited; i++) {
    const r = await call('POST', '/drafts', { user: 'u2', body: { subject: `n${i}` } });
    if (r.status === 429) limited = i + 1;
  }
  assert.ok(limited > 0 && limited <= 61, `rate limited after at most 60 writes (got ${limited})`);
});
