/**
 * MoveItems: moves go through message-store moveMessages (new UID + modSeq in
 * the target), folder ownership is checked for source and destination.
 * Run: node --import tsx --test src/commands/move-items.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags, type WNode } from '../test-support/fake-db.js';

const db = installFakeDb({
  mailbox: [
    { id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 20n },
    { id: 'mb2', userId: 'u2', uidNext: 5, highestModSeq: 7n },
  ],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX' },
    { id: 'archive', mailboxId: 'mb1', name: 'Archive' },
    { id: 'bob-inbox', mailboxId: 'mb2', name: 'INBOX' },
  ],
  message: [
    { id: 'm1', folderId: 'inbox', uid: 3, modSeq: 15n, deletedAt: null },
    { id: 'm2', folderId: 'inbox', uid: 4, modSeq: 16n, deletedAt: null },
    { id: 'gone', folderId: 'inbox', uid: 5, modSeq: 17n, deletedAt: new Date() },
    { id: 'b1', folderId: 'bob-inbox', uid: 1, modSeq: 3n, deletedAt: null },
  ],
});

const { handleMoveItems, MOVE_STATUS } = await import('./move-items.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

const M = (t: number, k?: WNode[] | string): WNode => [5, t, k];
const move = (src: string, from: string, to: string): WNode => M(0x06, [M(0x07, src), M(0x08, from), M(0x09, to)]);
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const responses = (e: E): E[] => (e.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === 'Response');
const row = (id: string) => db.tables['message']!.find((m) => m['id'] === id)!;

test('move into another own folder → Status 3, DstMsgId, new UID + modSeq from the target mailbox', async () => {
  const buf = await handleMoveItems(decodeWbxml(clientWbxml(M(0x05, [move('m1', 'inbox', 'archive')]))), 'u1');
  assert.ok(wbxmlTags(buf).every(([p]) => p === 5));
  const [r] = responses(decodeWbxml(buf));
  assert.equal(kid(r, 'Status')?.text, MOVE_STATUS.SUCCESS);
  assert.equal(kid(r, 'SrcMsgId')?.text, 'm1');
  assert.equal(kid(r, 'DstMsgId')?.text, 'm1');
  const m = row('m1');
  assert.equal(m['folderId'], 'archive');
  assert.equal(m['uid'], 10, 'UID allocated from mailbox.uidNext (never the old UID 3)');
  assert.equal(m['modSeq'], 21n);
  const mb = db.tables['mailbox']![0]!;
  assert.equal(mb['uidNext'], 11);
  assert.equal(mb['highestModSeq'], 21n);
});

test('batch: foreign destination, foreign source, deleted/unknown item, same folder', async () => {
  const req = M(0x05, [
    move('m2', 'inbox', 'bob-inbox'), // destination in another mailbox
    move('b1', 'bob-inbox', 'inbox'), // source in another mailbox
    move('gone', 'inbox', 'archive'), // deleted
    move('m2', 'archive', 'inbox'), // item not in the given source folder
    move('m2', 'inbox', 'inbox'),
  ]);
  const rs = responses(decodeWbxml(await handleMoveItems(decodeWbxml(clientWbxml(req)), 'u1')));
  assert.deepEqual(rs.map((r) => kid(r, 'Status')?.text), [
    MOVE_STATUS.INVALID_DESTINATION, MOVE_STATUS.INVALID_SOURCE, MOVE_STATUS.INVALID_SOURCE,
    MOVE_STATUS.INVALID_SOURCE, MOVE_STATUS.SAME_FOLDER,
  ]);
  assert.ok(rs.every((r) => !kid(r, 'DstMsgId')));
  assert.equal(row('m2')['folderId'], 'inbox');
  assert.equal(row('b1')['folderId'], 'bob-inbox');
  assert.equal(db.tables['mailbox']![1]!['highestModSeq'], 7n, "Bob's mailbox untouched");
});
