/**
 * Recover deleted items (v8.1): list, restore (message-store invariants: new UID
 * from uidNext, new modSeq = createdModSeq, tombstone cleared), purge and the
 * retention purge job — against the in-memory Prisma fake.
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

const r = await import('./recoverable-items.js');
const { resetMessageStoreCache } = await import('./message-store.js');

const NOW = new Date('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function seed(): void {
  Object.assign(db, emptyDb());
  db.users.push({ id: 'u1', email: 'bob@example.com', quotaBytes: 0n, usedBytes: 0n });
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 20, highestModSeq: 100n });
  db.mailboxes.push({ id: 'mb2', userId: 'u2', sharedBoxId: null, uidNext: 5, highestModSeq: 10n });
  for (const [id, mailboxId, name] of [
    ['inbox', 'mb1', 'INBOX'], ['work', 'mb1', 'Work'], ['trash', 'mb1', 'Trash'],
    ['del', 'mb1', 'Recoverable Items/Deletions'], ['other', 'mb2', 'INBOX'],
  ] as const) db.folders.push({ id, mailboxId, name, displayName: name, totalCount: 0, unreadCount: 0 });
  const msg = (id: string, folderId: string, uid: number, extra: Record<string, unknown>) => db.messages.push({
    id, folderId, uid, modSeq: 50n, createdModSeq: 40n, subject: `S ${id}`, fromAddr: 'a@x.example', fromName: 'A',
    date: ago(30), rawSize: 100, flags: [], deletedAt: null, softDeletedAt: null, createdAt: ago(30), ...extra,
  });
  msg('live', 'inbox', 1, {});
  msg('fromWork', 'work', 2, { deletedAt: ago(1), flags: ['\\Seen'] });   // expunged in Work
  msg('fromTrash', 'trash', 3, { deletedAt: ago(2) });                   // deleted from Trash
  msg('old', 'inbox', 4, { deletedAt: ago(20) });                        // past the 14 days
  msg('mfa', 'del', 5, { softDeletedAt: ago(3) });                       // retention soft delete
  msg('foreign', 'other', 1, { deletedAt: ago(1) });                     // other mailbox
}

beforeEach(() => { seed(); resetMessageStoreCache(); });

test('DELETED_ITEM_RETENTION_DAYS parsing', () => {
  assert.equal(r.deletedItemRetentionDays({}), 14);
  assert.equal(r.deletedItemRetentionDays({ DELETED_ITEM_RETENTION_DAYS: '30' }), 30);
  assert.equal(r.deletedItemRetentionDays({ DELETED_ITEM_RETENTION_DAYS: '0' }), 0);
  assert.equal(r.deletedItemRetentionDays({ DELETED_ITEM_RETENTION_DAYS: 'x' }), 14);
  assert.equal(r.retentionCutoff(NOW, 0), null);
});

test('list: tombstones within the retention + retention deletions, own mailbox only, newest first', async () => {
  const { items, total, retentionDays } = await r.listRecoverableItems('mb1', { now: NOW, days: 14 });
  assert.equal(retentionDays, 14);
  assert.deepEqual(items.map((i) => i.id), ['fromWork', 'fromTrash', 'mfa']);
  assert.equal(total, 3);
  assert.equal(items.find((i) => i.id === 'mfa')!.kind, 'retention');
  assert.equal(items[0]!.expiresAt!.getTime(), ago(1).getTime() + 14 * DAY);
  // days = 0 keeps everything
  assert.equal((await r.listRecoverableItems('mb1', { now: NOW, days: 0 })).total, 4);
  // search
  assert.deepEqual((await r.listRecoverableItems('mb1', { now: NOW, days: 14, search: 'fromtrash' })).items.map((i) => i.id), ['fromTrash']);
});

test('restore: original folder (Trash/retention → INBOX), new UIDs from uidNext, one new modSeq, tombstone cleared', async () => {
  const res = await r.restoreRecoverableItems('mb1', ['fromWork', 'fromTrash', 'mfa', 'live', 'old', 'foreign', 'nope'], { now: NOW, days: 14 });
  assert.deepEqual(res.notFound.sort(), ['foreign', 'live', 'nope', 'old']);
  const byId = Object.fromEntries(db.messages.map((m) => [m['id'], m]));
  assert.equal(byId['fromWork']!['folderId'], 'work');
  assert.equal(byId['fromTrash']!['folderId'], 'inbox');
  assert.equal(byId['mfa']!['folderId'], 'inbox');
  for (const id of ['fromWork', 'fromTrash', 'mfa']) {
    const m = byId[id]!;
    assert.equal(m['deletedAt'], null);
    assert.equal(m['softDeletedAt'], null);
    assert.ok((m['uid'] as number) >= 20, 'UID comes from uidNext, never the old one');
    assert.ok((m['modSeq'] as bigint) > 100n);
    assert.equal(m['createdModSeq'], m['modSeq'], 'appears as created for JMAP /changes');
  }
  const uids = ['fromWork', 'fromTrash', 'mfa'].map((id) => byId[id]!['uid'] as number);
  assert.equal(new Set(uids).size, 3);
  const mbx = db.mailboxes.find((m) => m['id'] === 'mb1')!;
  assert.equal(mbx['uidNext'], 23);
  assert.ok((mbx['highestModSeq'] as bigint) >= (byId['fromWork']!['modSeq'] as bigint));
  assert.equal(res.restored.length, 3);
  // folder counters recomputed from live rows (fromWork is \Seen)
  const work = db.folders.find((f) => f['id'] === 'work')!;
  assert.deepEqual([work['totalCount'], work['unreadCount']], [1, 0]);
  const inbox = db.folders.find((f) => f['id'] === 'inbox')!;
  assert.deepEqual([inbox['totalCount'], inbox['unreadCount']], [3, 3]);
  // restored items are no longer recoverable
  assert.equal((await r.listRecoverableItems('mb1', { now: NOW, days: 14 })).total, 0);
});

test('restore into an explicit folder; Recoverable Items or foreign folders are refused', async () => {
  const res = await r.restoreRecoverableItems('mb1', ['fromTrash'], { targetFolderId: 'work', now: NOW, days: 14 });
  assert.equal(res.restored[0]!.folderId, 'work');
  await assert.rejects(r.restoreRecoverableItems('mb1', ['fromWork'], { targetFolderId: 'del', now: NOW, days: 14 }), RangeError);
  await assert.rejects(r.restoreRecoverableItems('mb1', ['fromWork'], { targetFolderId: 'other', now: NOW, days: 14 }), RangeError);
});

test('purge: removes only recoverable items of the mailbox and bumps the modSeq', async () => {
  const before = db.mailboxes.find((m) => m['id'] === 'mb1')!['highestModSeq'] as bigint;
  const n = await r.purgeRecoverableItems('mb1', ['fromWork', 'mfa', 'live', 'foreign']);
  assert.equal(n, 2);
  const ids = db.messages.map((m) => m['id']);
  assert.ok(!ids.includes('fromWork') && !ids.includes('mfa'));
  assert.ok(ids.includes('live') && ids.includes('foreign'));
  assert.ok((db.mailboxes.find((m) => m['id'] === 'mb1')!['highestModSeq'] as bigint) > before);
  // all
  assert.equal(await r.purgeRecoverableItems('mb1'), 2); // fromTrash + old
  assert.deepEqual(db.messages.map((m) => m['id']).sort(), ['foreign', 'live']);
});

test('retention purge job: removes tombstones past the cutoff only; 0 days disables it; lock runs once', async () => {
  assert.equal(await r.purgeExpiredDeletedItems({ now: NOW, days: 0 }), 0);
  assert.equal(await r.purgeExpiredDeletedItems({ now: NOW, days: 14, batchSize: 1 }), 1);
  assert.ok(!db.messages.some((m) => m['id'] === 'old'));
  assert.ok(db.messages.some((m) => m['id'] === 'fromWork') && db.messages.some((m) => m['id'] === 'mfa'));
  seed();
  const locks = new Set<string>();
  const redis = { set: async (k: string) => (locks.has(k) ? null : (locks.add(k), 'OK' as const)) };
  // cutoff = exactly 1 day ago: fromTrash (2 d) and old (20 d) go, fromWork/foreign (1 d) stay
  assert.equal(await r.runLockedDeletedItemsPurge(redis, { now: NOW, days: 1 }), 2);
  assert.equal(await r.runLockedDeletedItemsPurge(redis, { now: NOW, days: 1 }), null, 'second run in the interval is skipped');
});
