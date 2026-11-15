/**
 * 8.1: superseded draft versions — expunged through the message store (modSeq
 * bump), stripped (no raw key, no attachments, size 0), never recoverable,
 * hard-deleted by the purge after a day; their objects are released only when
 * no other row references them. In-memory Prisma fake + object-store seam.
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
const deletedKeys: string[] = [];
(globalThis as unknown as { __objectStore: unknown }).__objectStore = {
  driver: 'memory', location: 'memory',
  delete: async (k: string) => { deletedKeys.push(k); },
};

const v = await import('./draft-versions.js');
const r = await import('./recoverable-items.js');
const { resetMessageStoreCache } = await import('./message-store.js');
const { prisma } = await import('./prisma/index.js');

const NOW = new Date('2026-11-15T12:00:00Z');
const HOUR = 3_600_000;

function seed(): void {
  Object.assign(db, emptyDb());
  deletedKeys.length = 0;
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 10, highestModSeq: 100n });
  db.folders.push({ id: 'drafts', mailboxId: 'mb1', name: 'Drafts', displayName: 'Drafts', totalCount: 1, unreadCount: 0 });
  db.folders.push({ id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Inbox', totalCount: 1, unreadCount: 0 });
  const msg = (id: string, folderId: string, storagePath: string) => db.messages.push({
    id, folderId, uid: db.messages.length + 1, modSeq: 50n, createdModSeq: 40n, subject: `S ${id}`, fromAddr: 'a@x.example',
    fromName: 'A', date: NOW, rawSize: 5000, bodyText: 'body', bodyHtml: '<p>body</p>', storagePath,
    flags: ['\\Draft', '\\Seen'], deletedAt: null, softDeletedAt: null, createdAt: NOW,
  });
  msg('v1', 'drafts', 'raw/aa');
  msg('copy', 'inbox', 'raw/shared');          // another row with a raw key v2 shares
  msg('v2', 'drafts', 'raw/shared');
  db.attachments.push({ id: 'a1', messageId: 'v1', storagePath: 'attachments/draft-x/0-own' });
  db.attachments.push({ id: 'a2', messageId: 'v1', storagePath: 'attachments/draft-x/1-kept' });
  db.attachments.push({ id: 'a3', messageId: 'v3', storagePath: 'attachments/draft-x/1-kept' }); // new version reuses it
}
beforeEach(() => { seed(); resetMessageStoreCache(); });

test('supersede: expunge with modSeq bump, row stripped, attachment rows gone, keys returned', async () => {
  const keys = await prisma.$transaction((tx) => v.supersedeDraftVersion(tx, ['v1'], { mailboxId: 'mb1', folderId: 'drafts', now: NOW }));
  const row = db.messages.find((m) => m['id'] === 'v1')!;
  assert.ok(row['deletedAt'] instanceof Date);
  assert.ok((row['modSeq'] as bigint) > 100n, 'modSeq bump: IMAP/JMAP/EAS see the removal');
  assert.equal(row['storagePath'], null);
  assert.deepEqual([row['bodyText'], row['bodyHtml'], row['rawSize']], ['', '', 0]);
  assert.ok((row['flags'] as string[]).includes(v.SUPERSEDED_DRAFT_FLAG));
  assert.deepEqual(db.attachments.map((a) => a['id']).sort(), ['a3']);
  assert.deepEqual(keys, { rawKeys: ['raw/aa'], attachmentKeys: ['attachments/draft-x/0-own', 'attachments/draft-x/1-kept'] });
  // an already expunged / foreign-folder id is ignored
  const none = await prisma.$transaction((tx) => v.supersedeDraftVersion(tx, ['v1', 'copy'], { mailboxId: 'mb1', folderId: 'drafts' }));
  assert.deepEqual(none, { rawKeys: [], attachmentKeys: [] });
});

test('release: objects still referenced elsewhere are kept', async () => {
  const k1 = await prisma.$transaction((tx) => v.supersedeDraftVersion(tx, ['v1'], { mailboxId: 'mb1', folderId: 'drafts' }));
  const k2 = await prisma.$transaction((tx) => v.supersedeDraftVersion(tx, ['v2'], { mailboxId: 'mb1', folderId: 'drafts' }));
  const deleted = await v.releaseUnreferencedObjects({ rawKeys: [...k1.rawKeys, ...k2.rawKeys], attachmentKeys: [...k1.attachmentKeys, ...k2.attachmentKeys] });
  assert.deepEqual(deleted.sort(), ['attachments/draft-x/0-own', 'raw/aa']);
  assert.deepEqual(deletedKeys.sort(), ['attachments/draft-x/0-own', 'raw/aa']);
});

test('superseded versions are never recoverable and are purged after a day', async () => {
  await prisma.$transaction((tx) => v.supersedeDraftVersion(tx, ['v1'], { mailboxId: 'mb1', folderId: 'drafts', now: NOW }));
  const list = await r.listRecoverableItems('mb1', { now: NOW, days: 14 });
  assert.equal(list.total, 0);
  const res = await r.restoreRecoverableItems('mb1', ['v1'], { now: NOW, days: 14 });
  assert.deepEqual(res.notFound, ['v1']);
  // within the TTL: kept (JMAP /changes can still report it destroyed)
  assert.equal(await r.purgeExpiredDeletedItems({ now: new Date(NOW.getTime() + HOUR), days: 14 }), 0);
  assert.ok(db.messages.some((m) => m['id'] === 'v1'));
  // after a day — also with DELETED_ITEM_RETENTION_DAYS=0 (keep deleted items forever)
  assert.equal(await r.purgeExpiredDeletedItems({ now: new Date(NOW.getTime() + 25 * HOUR), days: 0 }), 1);
  assert.ok(!db.messages.some((m) => m['id'] === 'v1'));
});
