/**
 * storeRawInFolder: raw object first, row through the message store (UID +
 * modSeq from the mailbox counters), attachment rows with their objects,
 * folder counters. In-memory Prisma fake + object-store seam.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const { emptyDb, createFake } = await import('./test-support/mailbox-fake.js');
const db = emptyDb();
(globalThis as unknown as { __prisma: unknown }).__prisma = createFake(db);
const objects = new Map<string, Buffer>();
(globalThis as unknown as { __objectStore: unknown }).__objectStore = {
  driver: 'memory', location: 'memory',
  put: async (k: string, b: Buffer) => { objects.set(k, Buffer.from(b)); },
  get: async (k: string) => objects.get(k) ?? Buffer.alloc(0),
  exists: async (k: string) => objects.has(k),
  delete: async (k: string) => { objects.delete(k); },
};

const { storeRawInFolder } = await import('./store-raw.js');
const { resetMessageStoreCache } = await import('./message-store.js');

const RAW = Buffer.from([
  'From: Alice <alice@example.test>',
  'To: bob@example.test',
  'Subject: Hello',
  'Message-ID: <m1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body text',
  '--b',
  'Content-Type: application/octet-stream; name="a.bin"',
  'Content-Disposition: attachment; filename="a.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('attachment-bytes').toString('base64'),
  '--b--',
  '',
].join('\r\n'));

beforeEach(() => {
  Object.assign(db, emptyDb());
  objects.clear();
  resetMessageStoreCache();
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 7, highestModSeq: 40n });
  db.folders.push({ id: 'sent', mailboxId: 'mb1', name: 'Sent', displayName: 'Sent Items', totalCount: 0, unreadCount: 0 });
});

test('storeRawInFolder: raw object, row with message-store UID/modSeq, attachments, counters', async () => {
  const msg = await storeRawInFolder({ mailboxId: 'mb1', folderId: 'sent', raw: RAW, flags: ['\\Seen'], bccAddrs: ['carol@example.test'] });
  assert.equal(msg.uid, 7);
  assert.equal(msg.modSeq, 41n);
  assert.equal(msg.subject, 'Hello');
  assert.deepEqual(msg.bccAddrs, ['carol@example.test']);
  assert.ok(msg.storagePath && objects.has(msg.storagePath), 'raw object stored');
  assert.equal(objects.get(msg.storagePath!)!.equals(RAW), true);
  assert.equal(db.attachments.length, 1);
  assert.equal(db.attachments[0]!['filename'], 'a.bin');
  assert.equal(objects.get(String(db.attachments[0]!['storagePath']))!.toString(), 'attachment-bytes');
  assert.deepEqual([db.folders[0]!['totalCount'], db.folders[0]!['unreadCount']], [1, 0]);
});

test('storeRawInFolder: an unread message counts as unread', async () => {
  await storeRawInFolder({ mailboxId: 'mb1', folderId: 'sent', raw: RAW, flags: [] });
  assert.deepEqual([db.folders[0]!['totalCount'], db.folders[0]!['unreadCount']], [1, 1]);
});
