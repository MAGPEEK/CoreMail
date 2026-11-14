/**
 * Raw-always storage: content-addressed store, loader, legacy reconstruction +
 * lazy migration, body column truncation; header sender identity (submission).
 * Run: node --import tsx --test src/raw-message.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma ??= { $on: () => undefined };

const { createRawMessageStore, rawContentKey, truncateBodyColumn } = await import('./raw-message.js');
const { evaluateHeaderSenders } = await import('./sender-identity.js');
const { parseMimeTree } = await import('./mime/tree.js');

function fakeStore() {
  const objects = new Map<string, Buffer>();
  const marked: Array<{ id: string; key: string; size: number }> = [];
  let uploads = 0;
  const store = createRawMessageStore({
    download: async (k) => { const b = objects.get(k); if (!b) throw new Error(`NoSuchKey ${k}`); return b; },
    upload: async (k, d) => { uploads++; objects.set(k, Buffer.from(d)); },
    exists: async (k) => objects.has(k),
    findAttachments: async () => [{ filename: 'a.txt', mimeType: 'text/plain', storagePath: 'attachments/m1/0', contentId: null, inline: false }],
    markStored: async (id, key, size) => { marked.push({ id, key, size }); },
  });
  return { store, objects, marked, uploads: () => uploads };
}

const legacy = {
  id: 'm1', storagePath: null, subject: 'Legacy', fromAddr: 'a@x.test', fromName: 'A', toAddrs: ['b@x.test'],
  ccAddrs: [], replyTo: null, messageId: '<l@x.test>', inReplyTo: null, date: new Date('2026-01-01T00:00:00Z'),
  bodyText: 'old body', bodyHtml: '',
};

test('storeRawMessage is content-addressed and uploads identical content once', async () => {
  const { store, objects, uploads } = fakeStore();
  const raw = Buffer.from('Subject: x\r\n\r\nbody');
  const a = await store.storeRawMessage(raw);
  const b = await store.storeRawMessage(Buffer.from(raw));
  const sha = createHash('sha256').update(raw).digest('hex');
  assert.equal(a.storagePath, rawContentKey(sha));
  assert.equal(a.storagePath, `raw/${sha.slice(0, 2)}/${sha}.eml`);
  assert.deepEqual(b, a);
  assert.equal(a.size, raw.length);
  assert.equal(uploads(), 1);
  assert.deepEqual(objects.get(a.storagePath), raw);
});

test('loadRawMessage returns the stored octets unchanged', async () => {
  const { store } = fakeStore();
  const raw = Buffer.from('From: a@x.test\r\nSubject: =?UTF-8?B?w6Q=?=\r\nX-Custom: kept\r\n\r\nÿ binary \u0000');
  const { storagePath } = await store.storeRawMessage(raw);
  assert.deepEqual(await store.loadRawMessage({ ...legacy, storagePath }), raw);
});

test('a missing stored object is an error, never a silent reconstruction', async () => {
  const { store } = fakeStore();
  await assert.rejects(store.loadRawMessage({ ...legacy, storagePath: 'raw/aa/missing.eml' }), /NoSuchKey/);
});

test('legacy rows are reconstructed with their attachments and persisted once', async () => {
  const { store, objects, marked } = fakeStore();
  objects.set('attachments/m1/0', Buffer.from('attached text'));
  const raw = await store.loadRawMessage(legacy);
  const root = parseMimeTree(raw);
  assert.equal(root.subtype, 'mixed');
  assert.equal(root.children.length, 2);
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.id, 'm1');
  assert.equal(marked[0]!.size, raw.length);
  assert.deepEqual(objects.get(marked[0]!.key), raw);
  // deterministic: a second reconstruction is byte-identical
  assert.deepEqual(await store.reconstructRawMessage(legacy), raw);
  // persist:false does not record anything
  await store.loadRawMessage(legacy, { persist: false });
  assert.equal(marked.length, 1);
});

test('body columns are truncated, not emptied', () => {
  assert.equal(truncateBodyColumn('abc', 2), 'ab');
  assert.equal(truncateBodyColumn('a\u{1F600}', 2), 'a');
  assert.equal(truncateBodyColumn(null), '');
  assert.equal(truncateBodyColumn('short'), 'short');
});

// ── Submission header sender identity ────────────────────────────────────────

const msg = (headers: string): Buffer => Buffer.from(`${headers}\r\nSubject: t\r\n\r\nbody`);
const ALLOWED = ['bob@corp.test', 'info@corp.test'];

test('From: own address, alias or shared mailbox (SEND_AS) is accepted', () => {
  assert.deepEqual(evaluateHeaderSenders(msg('From: Bob <BOB@corp.test>'), ALLOWED), { ok: true });
  assert.deepEqual(evaluateHeaderSenders(msg('From: "Info" <info@corp.test>'), ALLOWED), { ok: true });
  assert.deepEqual(evaluateHeaderSenders(msg('To: x@y.test'), ALLOWED), { ok: true });
});

test('a foreign From: or Sender: is rejected', () => {
  assert.equal(evaluateHeaderSenders(msg('From: CEO <ceo@corp.test>'), ALLOWED).ok, false);
  assert.equal(evaluateHeaderSenders(msg('From: bob@corp.test, ceo@corp.test'), ALLOWED).ok, false);
  assert.equal(evaluateHeaderSenders(msg('From: bob@corp.test\r\nSender: ceo@corp.test'), ALLOWED).ok, false);
  assert.equal(evaluateHeaderSenders(msg('From: bob@corp.test\r\nFrom: ceo@corp.test'), ALLOWED).ok, false);
  assert.equal(evaluateHeaderSenders(msg('From: undisclosed'), ALLOWED).ok, false);
  // folded header trying to hide the real address
  assert.equal(evaluateHeaderSenders(msg('From: "bob@corp.test"\r\n <ceo@corp.test>'), ALLOWED).ok, false);
});

test('SEND_ON_BEHALF: shared address in From: only with the own address in Sender:', () => {
  const onBehalf = ['sales@corp.test'];
  assert.equal(evaluateHeaderSenders(msg('From: sales@corp.test'), ALLOWED, onBehalf).ok, false);
  assert.equal(evaluateHeaderSenders(msg('From: sales@corp.test\r\nSender: bob@corp.test'), ALLOWED, onBehalf).ok, true);
});
