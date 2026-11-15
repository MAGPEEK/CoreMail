/**
 * Review 7.1.0 (HIGH): Sync only ever sent `Add` — a moved message reappeared as a duplicate
 * Add in the destination, flag changes (incl. the device's own) came back as Add, server-side
 * deletes/moves never reached the device, a client Delete expunged instead of moving to Deleted
 * Items, FilterType was ignored and an empty Sync got HTTP 400.
 * Per-device item state (ActiveSyncItem): Add / Change / Delete, no echo, retry-safe SyncKeys.
 * Run: node --import tsx --test src/commands/sync-state.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const day = 86_400_000;
const row = (id: string, folderId: string, modSeq: bigint, uid: number, over: Record<string, unknown> = {}) => ({
  id, folderId, uid, modSeq, flags: [] as string[], subject: `S ${id}`, fromAddr: 'a@ext.test', fromName: 'A',
  toAddrs: ['bob@example.com'], ccAddrs: [], replyTo: null, messageId: null, inReplyTo: null, threadId: null,
  date: new Date(NOW.getTime() - day), bodyText: `body ${id}`, bodyHtml: '', storagePath: null, smimeMeta: null,
  deletedAt: null, ...over,
});

const db = installFakeDb({
  user: [{ id: 'u1', email: 'bob@example.com', active: true }],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 5n }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX' },
    { id: 'archive', mailboxId: 'mb1', name: 'Archive' },
    { id: 'trash', mailboxId: 'mb1', name: 'Trash' },
    { id: 'news', mailboxId: 'mb1', name: 'News' },
  ],
  message: [
    row('m1', 'inbox', 3n, 1),
    row('m2', 'inbox', 4n, 2),
    row('m3', 'inbox', 5n, 3),
  ],
  activeSyncDevice: [{ id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', syncKeys: {} }],
  activeSyncItem: [],
});

const { handleSync, emptySyncResponse } = await import('./sync.js');
const { handleMoveItems } = await import('./move-items.js');
const { decodeWbxml } = await import('../wbxml.js');
const storage = await import('@coremail/storage');
type E = import('../wbxml.js').WbxmlElement;

const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const kids = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);
const change = (id: string, read: string): WNode => A(0x08, [A(0x0d, id), A(0x1d, [[2, 0x15, read]])]);
const del = (id: string): WNode => A(0x09, [A(0x0d, id)]);

async function sync(collectionId: string, key: string, extra: WNode[] = [], commands: WNode[] = []) {
  const col: WNode[] = [A(0x0b, key), A(0x12, collectionId), ...extra, ...(commands.length ? [A(0x16, commands)] : [])];
  const tree = decodeWbxml(await handleSync(decodeWbxml(clientWbxml(A(0x05, [A(0x1c, [A(0x0f, col)])]))), 'u1', 'dev1', { now: () => NOW }));
  const c = kid(kid(tree, 'Collections'), 'Collection')!;
  const cmds = kid(c, 'Commands');
  return {
    key: kid(c, 'SyncKey')!.text!,
    status: kid(c, 'Status')!.text!,
    adds: kids(cmds, 'Add').map((a) => kid(a, 'ServerId')!.text!),
    changes: kids(cmds, 'Change').map((a) => `${kid(a, 'ServerId')!.text!}:${kid(kid(a, 'ApplicationData'), 'Read')?.text}`),
    deletes: kids(cmds, 'Delete').map((a) => kid(a, 'ServerId')!.text!),
  };
}
const msg = (id: string) => db.tables['message']!.find((m) => m['id'] === id)!;
const mailbox = () => db.tables['mailbox']![0]!;
/** A message delivered by another writer (SMTP) — through the message store's counters. */
function deliver(id: string, folderId: string, over: Record<string, unknown> = {}) {
  const mb = mailbox();
  mb['highestModSeq'] = (mb['highestModSeq'] as bigint) + 1n;
  mb['uidNext'] = (mb['uidNext'] as number) + 1;
  db.tables['message']!.push(row(id, folderId, mb['highestModSeq'] as bigint, (mb['uidNext'] as number) - 1, over));
}
const tx = <T>(fn: (t: never) => Promise<T>) => fn(db as never);

let inboxKey = '';
test('priming, initial Adds, and a retried Sync (lost response) gets the same Adds again', async () => {
  const p = await sync('inbox', '0');
  assert.deepEqual([p.key, p.status, p.adds], ['1', '1', []]);
  const first = await sync('inbox', '1');
  assert.deepEqual(first.adds.sort(), ['m1', 'm2', 'm3']);
  const retry = await sync('inbox', '1');
  assert.deepEqual(retry.adds.sort(), ['m1', 'm2', 'm3'], 'unacknowledged changes are resent');
  assert.equal(retry.key, first.key);
  const ack = await sync('inbox', first.key);
  assert.deepEqual([ack.adds, ack.changes, ack.deletes], [[], [], []], 'acknowledged: nothing sent twice');
  inboxKey = ack.key;
});

test("the device's own Read change is applied and not echoed back; a server-side flag change is a Change, not an Add", async () => {
  const own = await sync('inbox', inboxKey, [], [change('m1', '1')]);
  assert.ok((msg('m1')['flags'] as string[]).includes('\\Seen'));
  assert.deepEqual([own.adds, own.changes], [[], []], 'no echo of the client change');
  inboxKey = (await sync('inbox', own.key)).key;

  await tx((t) => storage.setFlags(t, [{ id: 'm2', flags: ['\\Seen'] }], { mailboxId: 'mb1' })); // IMAP client
  const s = await sync('inbox', inboxKey);
  assert.deepEqual([s.adds, s.changes], [[], ['m2:1']]);
  inboxKey = (await sync('inbox', s.key)).key;
});

test('a key that is neither the issued nor the acknowledged one → Status 3, commands not applied', async () => {
  for (const bad of ['2', '999999', 'abc']) {
    const r = await sync('inbox', bad, [], [change('m3', '1')]);
    assert.equal(r.status, '3', bad);
  }
  assert.ok(!(msg('m3')['flags'] as string[]).includes('\\Seen'));
});

let archiveKey = '';
test('MoveItems: no duplicate Add in the destination, no Delete in the source', async () => {
  await sync('archive', '0');
  archiveKey = (await sync('archive', '1')).key;
  archiveKey = (await sync('archive', archiveKey)).key;

  const M = (t: number, k?: WNode[] | string): WNode => [5, t, k];
  const moved = decodeWbxml(await handleMoveItems(decodeWbxml(clientWbxml(M(0x05, [M(0x06, [M(0x07, 'm1'), M(0x08, 'inbox'), M(0x09, 'archive')])]))), 'u1', 'dev1'));
  assert.equal(kid(kid(moved, 'Response'), 'DstMsgId')?.text, 'm1');

  const dst = await sync('archive', archiveKey);
  assert.deepEqual([dst.adds, dst.changes, dst.deletes], [[], [], []], 'm1 is not added again in the destination');
  archiveKey = (await sync('archive', dst.key)).key;
  const src = await sync('inbox', inboxKey);
  assert.deepEqual([src.adds, src.changes, src.deletes], [[], [], []], 'the device moved it itself — no Delete');
  inboxKey = (await sync('inbox', src.key)).key;

  // a later change of the moved item reaches the device as a Change in the destination
  await tx((t) => storage.setFlags(t, [{ id: 'm1', flags: [] }], { mailboxId: 'mb1' }));
  const later = await sync('archive', archiveKey);
  assert.deepEqual([later.adds, later.changes], [[], ['m1:0']]);
  archiveKey = (await sync('archive', later.key)).key;
});

test('server-side move and expunge reach the device as Delete (and Add in the destination)', async () => {
  await tx((t) => storage.moveMessages(t, ['m2'], 'archive', { targetMailboxId: 'mb1', sourceMailboxId: 'mb1' })); // JMAP/IMAP move
  await tx((t) => storage.expunge(t, ['m3'], { mailboxId: 'mb1' }));
  const src = await sync('inbox', inboxKey);
  assert.deepEqual([src.adds, src.changes, src.deletes.sort()], [[], [], ['m2', 'm3']]);
  inboxKey = (await sync('inbox', src.key)).key;
  const again = await sync('inbox', inboxKey);
  assert.deepEqual(again.deletes, [], 'a Delete is sent once');
  const dst = await sync('archive', archiveKey);
  assert.deepEqual(dst.adds, ['m2']);
  archiveKey = (await sync('archive', dst.key)).key;
});

test('client Delete: DeletesAsMoves absent → Deleted Items (recoverable), DeletesAsMoves 0 → expunged; no echo', async () => {
  deliver('m4', 'inbox');
  deliver('m5', 'inbox');
  const got = await sync('inbox', inboxKey);
  assert.deepEqual(got.adds.sort(), ['m4', 'm5']);
  const d1 = await sync('inbox', got.key, [], [del('m4')]);
  assert.equal(msg('m4')['folderId'], 'trash');
  assert.equal(msg('m4')['deletedAt'], null, 'moved to Deleted Items, not expunged');
  assert.deepEqual(d1.deletes, [], 'no Delete echoed for the client delete');
  const d2 = await sync('inbox', (await sync('inbox', d1.key)).key, [A(0x1e, '0')], [del('m5')]);
  assert.ok(msg('m5')['deletedAt'] instanceof Date);
  assert.equal(msg('m5')['folderId'], 'inbox');
  assert.deepEqual(d2.deletes, []);
});

test('FilterType limits Adds to the age window; a changed FilterType → Status 3', async () => {
  deliver('old', 'news', { date: new Date(NOW.getTime() - 30 * day) });
  deliver('new', 'news', { date: new Date(NOW.getTime() - 2 * day) });
  const options: WNode = A(0x17, [A(0x18, '3')]); // 1 week
  await sync('news', '0', [options]);
  const s = await sync('news', '1'); // options are sticky
  assert.deepEqual(s.adds, ['new']);
  const changed = await sync('news', s.key, [A(0x17, [A(0x18, '5')])]);
  assert.equal(changed.status, '3');
  await sync('news', '0', [A(0x17, [A(0x18, '5')])]);
  assert.deepEqual((await sync('news', '1')).adds.sort(), ['new', 'old'], '1 month');
});

test('a Sync without body is answered with Status 13 (the client resends the full request)', () => {
  assert.deepEqual([...emptySyncResponse()], [0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x45, 0x4e, 0x03, 0x31, 0x33, 0x00, 0x01, 0x01]);
});

test('devices synced before v7.1 (no acknowledged key): state rebuilt from the folder, no duplicate Adds', async () => {
  const dev = db.tables['activeSyncDevice']![0]!;
  dev['syncKeys'] = { archive: archiveKey }; // pre-7.1 shape: only the issued key
  db.tables['activeSyncItem'] = [];
  deliver('m6', 'archive');
  const s = await sync('archive', archiveKey);
  assert.deepEqual(s.adds, ['m6'], 'only the new message');
  assert.equal(s.status, '1');
});

test('8.0.0: overlapping requests of one device do not write back stale syncKeys (no Status 3 loop)', async () => {
  const dev = db.tables['activeSyncDevice']![0]!;
  db.tables['activeSyncItem'] = [];
  dev['syncKeys'] = {};
  // Prime both folders and acknowledge their first keys.
  await sync('inbox', '0'); const i1 = await sync('inbox', '1');
  await sync('news', '0'); const n1 = await sync('news', '1');
  const iKey = (await sync('inbox', i1.key)).key;

  // A Sync of "news" reads the device row; while it runs, a parallel Sync of "inbox"
  // and a Ping store their keys. The news Sync must not put back the old inbox key.
  const deviceModel = (db as unknown as Record<string, Record<string, (...a: never[]) => Promise<unknown>>>)['activeSyncDevice']!;
  const realFind = deviceModel['findUnique']!;
  let interleaved = false;
  deviceModel['findUnique'] = (async (...args: never[]) => {
    const snapshot = structuredClone(await realFind(...args)) as Record<string, unknown>;
    if (!interleaved) {
      interleaved = true;
      deliver('m9', 'inbox');
      const parallel = await sync('inbox', iKey); // runs to completion "in between"
      assert.deepEqual([parallel.status, parallel.adds], ['1', ['m9']]);
      dev['syncKeys'] = { ...(dev['syncKeys'] as Record<string, string>), ping: '{"heartbeat":300,"folders":["inbox"]}' };
    }
    return snapshot;
  }) as never;
  try {
    const n2 = await sync('news', n1.key);
    assert.equal(n2.status, '1');
  } finally {
    deviceModel['findUnique'] = realFind;
  }
  const keys = dev['syncKeys'] as Record<string, string>;
  assert.equal(keys['ping'], '{"heartbeat":300,"folders":["inbox"]}', 'Ping key survives');
  assert.notEqual(keys['inbox'], iKey, 'the parallel inbox Sync issued a new key …');
  const next = await sync('inbox', keys['inbox']!);
  assert.equal(next.status, '1', '… and it is still valid (was Status 3 before 8.0.0)');
});

test('8.0.0: GetItemEstimate counts what the next Sync sends (held items and FilterType respected)', async () => {
  const { handleGetItemEstimate } = await import('./get-item-estimate.js');
  const dev = db.tables['activeSyncDevice']![0]!;
  db.tables['activeSyncItem'] = [];
  dev['syncKeys'] = {};
  await sync('inbox', '0');
  const first = await sync('inbox', '1');
  const held = (await sync('inbox', first.key)).key; // device holds every inbox item
  const estimate = async (key: string, filterType = '0') => {
    const req = decodeWbxml(clientWbxml([6, 0x05, [[6, 0x07, [[6, 0x08, [[0, 0x0b, key], [6, 0x0a, 'inbox'], [0, 0x17, [[0, 0x18, filterType]]]]]]]]]));
    const tree = decodeWbxml(await handleGetItemEstimate(req, 'u1', 'dev1', () => NOW));
    const walk = (e: E): string | undefined => e.name === 'Estimate' ? e.text : (e.children ?? []).filter((c): c is E => typeof c !== 'string').map(walk).find((x) => x !== undefined);
    return walk(tree);
  };
  assert.equal(await estimate(held), '0', 'nothing pending — the raw modSeq window is not empty');

  deliver('e1', 'inbox');                                                        // Add
  deliver('e2', 'inbox', { date: new Date(NOW.getTime() - 30 * day) });          // Add, older than 1 week
  msg(first.adds[0]!)['flags'] = ['\\Seen'];                                     // Change
  const mb = mailbox(); mb['highestModSeq'] = (mb['highestModSeq'] as bigint) + 1n;
  msg(first.adds[0]!)['modSeq'] = mb['highestModSeq'];
  assert.equal(await estimate(held), '3');
  assert.equal(await estimate(held, '3'), '2', 'FilterType 3 (1 week) leaves out the old message');
  const s = await sync('inbox', held, [A(0x17, [A(0x18, '3')])]);
  assert.equal(s.adds.length + s.changes.length + s.deletes.length, 2, 'Sync sends exactly the estimate');
});

test('review fix: an item hard-deleted by the deleted-items purge reaches the device as Delete once', async () => {
  const dev = db.tables['activeSyncDevice']![0]!;
  db.tables['activeSyncItem'] = [];
  dev['syncKeys'] = {};
  deliver('p1', 'inbox');
  await sync('inbox', '0');
  const first = await sync('inbox', '1');
  assert.ok(first.adds.includes('p1'));
  let key = (await sync('inbox', first.key)).key;
  // the purge job removes the tombstone row — no modSeq records it
  await tx((t) => storage.expunge(t, ['p1'], { mailboxId: 'mb1' }));
  key = (await sync('inbox', (await sync('inbox', key)).key)).key; // soft delete reaches the device …
  // … a device that missed it (state from before the expunge) still gets the purge
  db.tables['activeSyncItem']!.push({ deviceRowId: dev['id'], collectionId: 'inbox', serverId: 'ghost', pendingKey: '', modSeq: 1n });
  db.tables['message'] = db.tables['message']!.filter((m) => m['id'] !== 'p1');
  const s = await sync('inbox', key);
  assert.deepEqual(s.deletes, ['ghost']);
  const after = await sync('inbox', s.key);
  assert.deepEqual(after.deletes, [], 'sent once; the item-state row is removed');
  assert.equal(db.tables['activeSyncItem']!.filter((r) => r['serverId'] === 'ghost').length, 0);
});
