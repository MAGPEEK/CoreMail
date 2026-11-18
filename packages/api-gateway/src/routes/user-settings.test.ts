/**
 * 9.4 personal settings on the REST API (loopback Express app, Prisma faked via
 * globalThis.__prisma):
 *  - GET/PATCH /user/preferences: defaults, strict validation, one-time browser
 *    import (server wins afterwards), legacy inactivity field kept
 *  - /user/signatures CRUD, legacy column mirror, pre-9.4 signature import
 *  - GET /mail/messages/:id?markRead=false leaves \Seen alone
 *  - POST /mail/messages/:id/receipt (ignore / send / not requested / handled)
 *  - "empty Deleted Items on logout"
 * Run: node --import tsx --test --test-force-exit src/routes/user-settings.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let tick = 0;
const stamp = () => new Date(1_700_000_000_000 + (++tick));

const users: Record<string, Row> = {
  u1: { id: 'u1', email: 'bob@ex.com', displayName: 'Bob', role: 'USER', active: true, domainId: 'd1', domain: { id: 'd1', name: 'ex.com', dkimPrivateKey: null } },
  u2: { id: 'u2', email: 'eve@ex.com', displayName: 'Eve', role: 'USER', active: true, domainId: 'd1', domain: { id: 'd1', name: 'ex.com', dkimPrivateKey: null } },
};
let userSettings: Record<string, Row> = {};
let signatures: Row[] = [];
let messages: Row[] = [];
const flagWrites: Row[] = [];
const queued: Row[] = [];
let expunged: string[] = [];
let raw = '';

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'NOT') return !matchesWhere(row, v as Row);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gt' in (v as Row)) return (row[k] as Date) > ((v as Row)['gt'] as Date);
      return true; // relation filters: ownership is encoded in the rows themselves
    }
    if (v instanceof Date) return (row[k] as Date)?.getTime() === v.getTime();
    return row[k] === v;
  });
}

installFakePrisma({
  user: {
    findUnique: (a) => { const q = a as { where: Row; select?: Row }; const r = users[String(q.where['id'])] ?? null; return q.select ? applySelect(r, q.select) : r; },
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', inactivityTimeoutMinutes: 30, publicHostname: 'mail.ex.com' }) },
  userSettings: {
    findUnique: (a) => { const r = userSettings[String((a as { where: Row }).where['userId'])]; return r ? { ...r } : null; },
    create: (a) => {
      const d = (a as { data: Row }).data;
      if (userSettings[String(d['userId'])]) throw Object.assign(new Error('unique'), { code: 'P2002' });
      userSettings[String(d['userId'])] = { signature: '', signatureAutoNew: true, signatureAutoReply: false, preferences: {}, ...d, updatedAt: stamp() };
      return userSettings[String(d['userId'])];
    },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      const r = userSettings[String(q.where['userId'])];
      if (!r || !matchesWhere(r, q.where)) return { count: 0 };
      Object.assign(r, q.data, { updatedAt: stamp() });
      return { count: 1 };
    },
    upsert: (a) => {
      const q = a as { where: Row; update: Row; create: Row };
      const id = String(q.where['userId']);
      userSettings[id] = userSettings[id]
        ? { ...userSettings[id], ...q.update, updatedAt: stamp() }
        : { signature: '', signatureAutoNew: true, signatureAutoReply: false, preferences: {}, ...q.create, updatedAt: stamp() };
      return userSettings[id];
    },
  },
  userSignature: {
    findMany: (a) => signatures.filter((s) => s['userId'] === (a as { where: Row }).where['userId']).map((s) => ({ ...s })),
    findFirst: (a) => { const w = (a as { where: Row }).where; return signatures.find((s) => matchesWhere(s, w)) ?? null; },
    count: (a) => signatures.filter((s) => s['userId'] === (a as { where: Row }).where['userId']).length,
    create: (a) => { const d = (a as { data: Row }).data; const r = { id: `sig${signatures.length + 1}`, sortOrder: 0, html: '', ...d }; signatures.push(r); return { ...r }; },
    update: (a) => { const q = a as { where: Row; data: Row }; const r = signatures.find((s) => s['id'] === q.where['id'])!; Object.assign(r, q.data); return { ...r }; },
    updateMany: (a) => { const q = a as { where: Row; data: Row }; const r = signatures.find((s) => matchesWhere(s, q.where)); if (!r) return { count: 0 }; Object.assign(r, q.data); return { count: 1 }; },
    deleteMany: (a) => { const w = (a as { where: Row }).where; const n = signatures.length; signatures = signatures.filter((s) => !matchesWhere(s, w)); return { count: n - signatures.length }; },
  },
  message: {
    findFirst: (a) => {
      const w = (a as { where: Row }).where;
      const m = messages.find((x) => x['id'] === w['id']);
      return m ? { ...m, attachments: [], folder: { mailboxId: 'mb1', name: m['folderName'] ?? 'INBOX' } } : null;
    },
    findMany: (a) => {
      const w = (a as { where: Row }).where;
      const ids = (w['id'] as Row | undefined)?.['in'] as string[] | undefined;
      const hit = ids ? messages.filter((m) => ids.includes(String(m['id']))) : messages.filter((m) => m['folderId'] === w['folderId']);
      return hit.map((m) => ({ id: m['id'], folder: { mailboxId: 'mb1' } }));
    },
    aggregate: () => ({ _max: { modSeq: null, uid: null } }),
    update: (a) => { const q = a as { where: Row; data: Row }; flagWrites.push({ id: q.where['id'], ...q.data }); const m = messages.find((x) => x['id'] === q.where['id']); if (m && q.data['flags']) m['flags'] = q.data['flags']; return m; },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      const ids = ((q.where['id'] as Row | undefined)?.['in'] as string[] | undefined) ?? [];
      for (const id of ids) {
        const m = messages.find((x) => x['id'] === id);
        if (q.data['deletedAt']) expunged.push(id);
        if (m && q.data['flags']) { m['flags'] = q.data['flags']; flagWrites.push({ id, flags: q.data['flags'] }); }
      }
      return { count: ids.length };
    },
  },
  mailbox: {
    findUnique: () => ({ id: 'mb1', highestModSeq: 1n, uidNext: 1 }),
    update: () => ({ id: 'mb1', uidNext: 1, highestModSeq: 2n }),
  },
  folder: {
    findFirst: (a) => ((a as { where: Row }).where['name'] === 'Trash' ? { id: 'trash', mailboxId: 'mb1' } : null),
    update: () => ({}),
  },
});

(globalThis as Record<string, unknown>)['__outboundQueue'] = { add: async (_n: string, data: Row) => { queued.push(data); return { id: 'j1' }; } };
// raw originals (receipt route): every object read returns the current `raw`
(globalThis as Record<string, unknown>)['__objectStore'] = { get: async () => Buffer.from(raw) };

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { userSettingsRouter } = await import('./user-settings.js');
const { userRouter } = await import('./user.js');
const { readReceiptRouter } = await import('./read-receipts.js');
const { mailRouter } = await import('./mail.js');
const { emptyTrashAfterLogout } = await import('../lib/empty-folder.js');

const tok = (sub: string, sessionId = `s-${sub}`) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/v1/mail', readReceiptRouter);
  app.use('/api/v1/mail', mailRouter);
  app.use('/api/v1/user', userSettingsRouter);
  app.use('/api/v1/user', userRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  userSettings = {}; signatures = []; messages = []; flagWrites.length = 0; queued.length = 0; expunged = []; raw = '';
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}
const prefsOf = (r: { json: Row }) => r.json['preferences'] as Record<string, Row>;

// ── Preferences ──────────────────────────────────────────────────────────────

test('GET /user/preferences: defaults + legacy inactivity fields; 401 without token', async () => {
  const r = await call('GET', '/api/v1/user/preferences', { token: tok('u1') });
  assert.equal(r.status, 200);
  assert.equal(r.json['inactivityTimeoutMinutes'], null);
  assert.equal(r.json['inactivityTimeoutMinutesGlobal'], 30);
  assert.equal(prefsOf(r)['view']!['readingPane'], 'right');
  assert.equal(prefsOf(r)['migratedAt'], null);
  assert.equal((await call('GET', '/api/v1/user/preferences')).status, 401);
});

test('PATCH /user/preferences: partial update, other fields kept, invalid → 400', async () => {
  const t = tok('u1');
  const a = await call('PATCH', '/api/v1/user/preferences', { token: t, body: { preferences: { view: { density: 'compact' }, regional: { timeZone: 'Europe/Berlin' } } } });
  assert.equal(a.status, 200);
  assert.equal(prefsOf(a)['view']!['density'], 'compact');
  assert.ok(prefsOf(a)['migratedAt']);
  const b = await call('PATCH', '/api/v1/user/preferences', { token: t, body: { preferences: { view: { readingPane: 'bottom' } } } });
  assert.equal(prefsOf(b)['view']!['density'], 'compact');
  assert.equal(prefsOf(b)['view']!['readingPane'], 'bottom');
  assert.equal((await call('PATCH', '/api/v1/user/preferences', { token: t, body: { preferences: { view: { density: 'huge' } } } })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/user/preferences', { token: t, body: { preferences: { evil: {} } } })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/user/preferences', { token: t, body: { other: 1 } })).status, 400);
  // the legacy PUT with only the inactivity field still works and keeps the prefs
  const p = await call('PUT', '/api/v1/user/preferences', { token: t, body: { inactivityTimeoutMinutes: 10 } });
  assert.equal(p.status, 200);
  assert.equal(p.json['inactivityTimeoutMinutes'], 10);
  assert.equal(prefsOf(p)['view']!['readingPane'], 'bottom');
});

test('migrateFromLocal is applied once; afterwards the server copy wins', async () => {
  const t = tok('u1');
  const first = await call('PATCH', '/api/v1/user/preferences', { token: t, body: { migrateFromLocal: true, preferences: { theme: { mode: 'dark' } } } });
  assert.equal(first.json['applied'], true);
  assert.equal(prefsOf(first)['theme']!['mode'], 'dark');
  const second = await call('PATCH', '/api/v1/user/preferences', { token: t, body: { migrateFromLocal: true, preferences: { theme: { mode: 'light' } } } });
  assert.equal(second.json['applied'], false);
  assert.equal(prefsOf(second)['theme']!['mode'], 'dark');
});

// ── Signatures ───────────────────────────────────────────────────────────────

test('signatures: create, defaults per identity, legacy column mirrors the own default', async () => {
  const t = tok('u2');
  const a = await call('POST', '/api/v1/user/signatures', { token: t, body: { name: 'Kurz', html: '<p>Gruß</p>' } });
  assert.equal(a.status, 201);
  const b = await call('POST', '/api/v1/user/signatures', { token: t, body: { name: 'Lang', html: '<p>Mit freundlichen Grüßen</p>' } });
  const aId = String(a.json['id']); const bId = String(b.json['id']);
  await call('PATCH', '/api/v1/user/preferences', { token: t, body: { preferences: { signatures: { defaults: { own: { newId: bId, replyId: aId }, 'shared:team1': { newId: aId, replyId: null } } } } } });
  const legacy = await call('GET', '/api/v1/user/signature', { token: t });
  assert.deepEqual(legacy.json, { signature: '<p>Mit freundlichen Grüßen</p>', autoNew: true, autoReply: true });
  const list = await call('GET', '/api/v1/user/signatures', { token: t });
  assert.equal((list.json['signatures'] as Row[]).length, 2);
  assert.deepEqual((list.json['defaults'] as Row)['shared:team1'], { newId: aId, replyId: null });
  // deleting a signature clears the defaults that pointed at it
  assert.equal((await call('DELETE', `/api/v1/user/signatures/${bId}`, { token: t })).status, 200);
  const after = await call('GET', '/api/v1/user/signatures', { token: t });
  assert.deepEqual((after.json['defaults'] as Row)['own'], { newId: null, replyId: aId });
  assert.deepEqual((await call('GET', '/api/v1/user/signature', { token: t })).json, { signature: '<p>Gruß</p>', autoNew: false, autoReply: true });
  // validation + ownership
  assert.equal((await call('POST', '/api/v1/user/signatures', { token: t, body: { name: '', html: '' } })).status, 400);
  assert.equal((await call('PUT', `/api/v1/user/signatures/${aId}`, { token: tok('u1'), body: { name: 'x' } })).status, 404);
});

test('signatures: the pre-9.4 single signature is imported once as "Standard"', async () => {
  userSettings['u1'] = { userId: 'u1', signature: '<p>Alt</p>', signatureAutoNew: true, signatureAutoReply: false, preferences: {}, updatedAt: stamp() };
  const r = await call('GET', '/api/v1/user/signatures', { token: tok('u1') });
  const list = r.json['signatures'] as Row[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!['name'], 'Standard');
  assert.deepEqual((r.json['defaults'] as Row)['own'], { newId: list[0]!['id'], replyId: null });
  assert.equal(((await call('GET', '/api/v1/user/signatures', { token: tok('u1') })).json['signatures'] as Row[]).length, 1);
});

test('legacy PUT /user/signature edits the primary signature', async () => {
  const t = tok('u1');
  assert.equal((await call('PUT', '/api/v1/user/signature', { token: t, body: { signature: '<p>Neu</p>', autoNew: true, autoReply: true } })).status, 200);
  const list = await call('GET', '/api/v1/user/signatures', { token: t });
  assert.equal((list.json['signatures'] as Row[])[0]!['html'], '<p>Neu</p>');
  assert.deepEqual((await call('GET', '/api/v1/user/signature', { token: t })).json, { signature: '<p>Neu</p>', autoNew: true, autoReply: true });
});

// ── markRead=false ───────────────────────────────────────────────────────────

test('GET /mail/messages/:id?markRead=false does not set \\Seen; default still does', async () => {
  messages = [{ id: 'm1', folderId: 'f1', flags: [], subject: 's' }];
  const t = tok('u1');
  const r = await call('GET', '/api/v1/mail/messages/m1?markRead=false', { token: t });
  assert.equal(r.status, 200);
  assert.equal(flagWrites.length, 0);
  await call('GET', '/api/v1/mail/messages/m1', { token: t });
  assert.ok(flagWrites.some((w) => (w['flags'] as string[] | undefined)?.includes('\\Seen')));
});

// ── Read receipts ────────────────────────────────────────────────────────────

test('POST /mail/messages/:id/receipt: ignore sets $MDNSent; a second answer is 409', async () => {
  messages = [{ id: 'm2', folderId: 'f1', flags: ['\\Seen'], subject: 's', messageId: '<o@ext.example>', storagePath: null, bodyText: 'x', bodyHtml: '', toAddrs: [], ccAddrs: [], fromAddr: 'a@ext.example', fromName: '', date: new Date() }];
  const t = tok('u1');
  assert.equal((await call('POST', '/api/v1/mail/messages/m2/receipt', { token: t, body: { action: 'nope' } })).status, 400);
  const r = await call('POST', '/api/v1/mail/messages/m2/receipt', { token: t, body: { action: 'ignore' } });
  assert.equal(r.status, 200);
  assert.deepEqual(messages[0]!['flags'], ['\\Seen', '$MDNSent']);
  assert.equal((await call('POST', '/api/v1/mail/messages/m2/receipt', { token: t, body: { action: 'send' } })).json['code'], 'RECEIPT_HANDLED');
  assert.equal(queued.length, 0);
  assert.equal((await call('POST', '/api/v1/mail/messages/zzz/receipt', { token: t, body: { action: 'ignore' } })).status, 404);
});

test('POST /mail/messages/:id/receipt send: refused without a request in the original', async () => {
  // no storagePath → the raw message is rebuilt from the columns (no DNT header)
  messages = [{ id: 'm3', folderId: 'f1', flags: [], subject: 's', messageId: '<o@ext.example>', storagePath: null, bodyText: 'x', bodyHtml: '', toAddrs: ['bob@ex.com'], ccAddrs: [], bccAddrs: [], fromAddr: 'a@ext.example', fromName: '', date: new Date(), attachments: [] }];
  const r = await call('POST', '/api/v1/mail/messages/m3/receipt', { token: tok('u1'), body: { action: 'send' } });
  assert.equal(r.status, 409);
  assert.equal(r.json['code'], 'NO_RECEIPT_REQUESTED');
  assert.equal(queued.length, 0);
});

test('POST /mail/messages/:id/receipt send: queues a receipt to the requested address and sets $MDNSent', async () => {
  raw = 'From: a@ext.example\r\nTo: bob@ex.com\r\nDisposition-Notification-To: "A" <a@ext.example>\r\n'
    + 'Subject: Frage\r\nMessage-ID: <o@ext.example>\r\n\r\nbody\r\n';
  messages = [{ id: 'm4', folderId: 'f1', flags: [], subject: 'Frage', messageId: '<o@ext.example>', storagePath: 'raw/m4', dispositionNotificationTo: 'a@ext.example' }];
  const r = await call('POST', '/api/v1/mail/messages/m4/receipt', { token: tok('u1'), body: { action: 'send' } });
  assert.equal(r.status, 200);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0]!['to'], ['a@ext.example']);
  assert.equal(queued[0]!['from'], '', 'null envelope sender');
  const mdn = Buffer.from(String(queued[0]!['rawMessage']), 'base64').toString();
  assert.match(mdn, /Original-Message-ID: <o@ext\.example>/);
  assert.match(mdn, /Disposition: manual-action\/MDN-sent-manually; displayed/);
  assert.deepEqual(messages[0]!['flags'], ['$MDNSent']);
});

test('POST /mail/messages/:id/receipt: never for Junk; automatic only with "always answer"', async () => {
  raw = 'From: a@ext.example\r\nTo: bob@ex.com\r\nDisposition-Notification-To: a@ext.example\r\nSubject: x\r\n\r\nbody\r\n';
  queued.length = 0;
  messages = [{ id: 'm5', folderId: 'junk', folderName: 'Junk', flags: [], subject: 'x', messageId: '<j@ext.example>', storagePath: 'raw/m5' }];
  const junk = await call('POST', '/api/v1/mail/messages/m5/receipt', { token: tok('u2'), body: { action: 'send' } });
  assert.equal(junk.json['code'], 'RECEIPT_NOT_ALLOWED');
  messages = [{ id: 'm6', folderId: 'f1', flags: [], subject: 'x', messageId: '<k@ext.example>', storagePath: 'raw/m6' }];
  const auto = await call('POST', '/api/v1/mail/messages/m6/receipt', { token: tok('u2'), body: { action: 'send', mode: 'automatic' } });
  assert.equal(auto.json['code'], 'RECEIPT_NOT_AUTOMATIC');
  assert.equal(queued.length, 0);
  await call('PATCH', '/api/v1/user/preferences', { token: tok('u2'), body: { preferences: { reading: { answerReceipts: 'always' } } } });
  const ok = await call('POST', '/api/v1/mail/messages/m6/receipt', { token: tok('u2'), body: { action: 'send', mode: 'automatic' } });
  assert.equal(ok.status, 200);
  assert.match(Buffer.from(String(queued[0]!['rawMessage']), 'base64').toString(), /Disposition: automatic-action\/MDN-sent-automatically; displayed/);
});

// ── Empty Deleted Items on logout ────────────────────────────────────────────

test('emptyTrashAfterLogout empties Trash only when the user enabled it', async () => {
  messages = [{ id: 't1', folderId: 'trash', flags: [] }, { id: 't2', folderId: 'trash', flags: [] }];
  await emptyTrashAfterLogout('u1');
  assert.deepEqual(expunged, []);
  await call('PATCH', '/api/v1/user/preferences', { token: tok('u1'), body: { preferences: { reading: { emptyTrashOnLogout: true } } } });
  await emptyTrashAfterLogout('u1');
  assert.deepEqual(expunged.sort(), ['t1', 't2']);
});
