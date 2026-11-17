/**
 * Folder delete with subfolders (lib/folder-delete.ts), the same rule on all three
 * routes — own mailbox DELETE /mail/folders/:id, shared/delegated
 * DELETE /mail/{shared,delegated}-mailboxes/:id/folders/:fid and the pre-9.3
 * compat DELETE /user/shared-mailboxes/:id/folders/:fid:
 *  - subfolders without ?recursive=true → 409 FOLDER_HAS_SUBFOLDERS with
 *    { subfolders, count } and nothing changed (no parentId → null orphans);
 *  - with ?recursive=true the messages of every folder of the subtree (depth 3
 *    here) go to Trash through the message store (live stays live, tombstones
 *    stay recoverable, inside Trash live mail is expunged first), then the folders
 *    are deleted deepest first;
 *  - a system folder inside the subtree is never deleted (409 PROTECTED_SUBFOLDER).
 * Fixture: test-support/foreign-mailbox-fixture.ts.
 * Run: node --import tsx --test src/routes/folder-delete-recursive.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addFolder, addMessage, msg, folderById, deletedFolderIds, writes, auditRows,
  tok, call, flush, S, D, OLD, type Row,
} from '../test-support/foreign-mailbox-fixture.js';
import { decideFolderDelete } from '../lib/folder-delete.js';

/** root > a > b > c with one live message per level and a tombstone in c. */
function nestedTree(mailboxId: string, prefix: string, rootParent: string | null = null): string[] {
  const ids = [`${prefix}-root`, `${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
  ids.forEach((id, i) => addFolder(id, mailboxId, `Ebene${i}`, i === 0 ? rootParent : ids[i - 1]!));
  ids.forEach((id) => addMessage(`m-${id}`, id));
  addMessage(`m-${prefix}-c-dead`, `${prefix}-c`, { deletedAt: new Date(1_000) });
  return ids;
}

function assertTreeIntact(ids: string[]): void {
  ids.forEach((id, i) => {
    const f = folderById(id);
    assert.ok(f, `${id} still exists`);
    if (i > 0) assert.equal(f!['parentId'], ids[i - 1], `${id} keeps its parent`);
  });
  assert.ok(!writes.includes('folder.delete') && !writes.includes('message.update'));
}

function assertTreeMovedToTrash(ids: string[], trashId: string, prefix: string): void {
  for (const id of ids) {
    assert.equal(folderById(id), undefined, `${id} deleted`);
    assert.equal(msg(`m-${id}`)['folderId'], trashId);
    assert.equal(msg(`m-${id}`)['deletedAt'], null, 'live mail stays live');
  }
  assert.equal(msg(`m-${prefix}-c-dead`)['folderId'], trashId);
  assert.ok(msg(`m-${prefix}-c-dead`)['deletedAt'] instanceof Date, 'tombstone stays recoverable');
  assert.deepEqual(deletedFolderIds, [...ids].reverse(), 'folders deleted deepest first');
  assert.ok(writes.lastIndexOf('message.update') < writes.indexOf('folder.delete'), 'mail moved before any folder row goes');
  assert.ok(writes.includes('mailbox.update'), 'message store allocated UIDs / modSeq');
}

test('decideFolderDelete: protected subfolder, then subfolders, then live mail', () => {
  const sum = (subfolders: number, count: number, protectedInside: string | null = null) => ({ subfolders, count, protectedInside });
  const code = (s: ReturnType<typeof sum>, recursive: boolean, force: boolean) => decideFolderDelete(s, { recursive, force })?.code ?? null;
  assert.equal(code(sum(0, 0), false, false), null);
  assert.equal(code(sum(0, 2), false, false), 'FOLDER_NOT_EMPTY');
  assert.equal(code(sum(0, 2), false, true), null);
  assert.equal(code(sum(3, 0), false, true), 'FOLDER_HAS_SUBFOLDERS');
  assert.equal(code(sum(3, 0), true, false), null);
  assert.equal(code(sum(3, 5), true, false), 'FOLDER_NOT_EMPTY');
  assert.equal(code(sum(3, 5), true, true), null);
  assert.equal(code(sum(3, 5, 'INBOX'), true, true), 'PROTECTED_SUBFOLDER');
  assert.deepEqual(decideFolderDelete(sum(3, 5), { recursive: false, force: true }), {
    error: 'Ordner hat Unterordner', code: 'FOLDER_HAS_SUBFOLDERS', subfolders: 3, count: 5,
  });
});

test('own mailbox: depth 3 needs ?recursive=true (409 with counts), then everything goes to Trash', async () => {
  const t = tok('alice');
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  const ids = nestedTree('mb-alice', 'f-al');
  const url = `/api/v1/mail/folders/${ids[0]}`;

  const refused = await call('DELETE', `${url}?force=true`, t);
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.json['code'], refused.json['subfolders'], refused.json['count']], ['FOLDER_HAS_SUBFOLDERS', 3, 4]);
  assertTreeIntact(ids);

  const noForce = await call('DELETE', `${url}?recursive=true`, t);
  assert.deepEqual([noForce.status, noForce.json['code'], noForce.json['count']], [409, 'FOLDER_NOT_EMPTY', 4]);
  assertTreeIntact(ids);

  const r = await call('DELETE', `${url}?recursive=true&force=true`, t);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json['folders'], r.json['movedToTrash']], [4, 5]);
  assertTreeMovedToTrash(ids, 'f-alice-trash', 'f-al');
});

test('own mailbox: deleting a middle folder keeps the parent, removes only its subtree', async () => {
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  const ids = nestedTree('mb-alice', 'f-mid');
  const r = await call('DELETE', `/api/v1/mail/folders/${ids[1]}?recursive=true&force=true`, tok('alice'));
  assert.equal(r.status, 200);
  assert.ok(folderById(ids[0]!), 'parent stays');
  assert.equal(msg(`m-${ids[0]}`)['folderId'], ids[0]);
  assert.deepEqual(deletedFolderIds, [ids[3], ids[2], ids[1]]);
});

test('own mailbox: an empty subtree is deleted without a Trash folder', async () => {
  addFolder('f-e-root', 'mb-alice', 'Leer');
  addFolder('f-e-a', 'mb-alice', 'Leer2', 'f-e-root');
  addFolder('f-e-b', 'mb-alice', 'Leer3', 'f-e-a');
  const t = tok('alice');
  const refused = await call('DELETE', '/api/v1/mail/folders/f-e-root', t);
  assert.deepEqual([refused.status, refused.json['subfolders'], refused.json['count']], [409, 2, 0]);
  const r = await call('DELETE', '/api/v1/mail/folders/f-e-root?recursive=true', t);
  assert.equal(r.status, 200);
  assert.deepEqual(deletedFolderIds, ['f-e-b', 'f-e-a', 'f-e-root']);
});

test('a system folder inside the subtree is never deleted (409 PROTECTED_SUBFOLDER)', async () => {
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  addFolder('f-p-root', 'mb-alice', 'Ablage');
  addFolder('f-p-archive', 'mb-alice', 'Archive', 'f-p-root');
  const r = await call('DELETE', '/api/v1/mail/folders/f-p-root?recursive=true&force=true', tok('alice'));
  assert.deepEqual([r.status, r.json['code']], [409, 'PROTECTED_SUBFOLDER']);
  assert.ok(folderById('f-p-root') && folderById('f-p-archive'));
  // shared mailbox: its Trash moved below a user folder
  const s = await call('DELETE', `${S('sm1')}/folders/f-sm1-proj?recursive=true&force=true`, tok('alice'));
  assert.equal(s.status, 200, 'sanity: no protected folder below Projekte');
  addFolder('f-sm1-x', 'mb-sm1', 'X');
  folderById('f-sm1-trash')!['parentId'] = 'f-sm1-x';
  const t2 = await call('DELETE', `${S('sm1')}/folders/f-sm1-x?recursive=true&force=true`, tok('alice'));
  assert.deepEqual([t2.status, t2.json['code']], [409, 'PROTECTED_SUBFOLDER']);
  assert.ok(folderById('f-sm1-trash'));
});

test('shared mailbox: depth 3 recursive delete, audited with the folder count', async () => {
  const t = tok('alice');
  const ids = nestedTree('mb-sm1', 'f-s');
  const refused = await call('DELETE', `${S('sm1')}/folders/${ids[0]}?force=true`, t);
  assert.deepEqual([refused.status, refused.json['code'], refused.json['subfolders'], refused.json['count']], [409, 'FOLDER_HAS_SUBFOLDERS', 3, 4]);
  assertTreeIntact(ids);

  const r = await call('DELETE', `${S('sm1')}/folders/${ids[0]}?recursive=true&force=true`, t);
  assert.equal(r.status, 200);
  assertTreeMovedToTrash(ids, 'f-sm1-trash', 'f-s');
  await flush();
  const a = auditRows.find((x) => x['action'] === 'mailbox.foreign.folder.delete')!;
  assert.deepEqual([(a['changes'] as Row)['folders'], (a['changes'] as Row)['movedToTrash']], [4, 5]);
});

test('shared mailbox: a subtree inside Trash — live mail is expunged (tombstone) and kept in Trash', async () => {
  const ids = nestedTree('mb-sm1', 'f-t', 'f-sm1-trash');
  const r = await call('DELETE', `${S('sm1')}/folders/${ids[0]}?recursive=true&force=true`, tok('alice'));
  assert.equal(r.status, 200);
  for (const id of ids) {
    assert.equal(folderById(id), undefined);
    assert.equal(msg(`m-${id}`)['folderId'], 'f-sm1-trash');
    assert.ok(msg(`m-${id}`)['deletedAt'] instanceof Date, 'expunged → recoverable tombstone');
  }
});

test('delegated mailbox: same rule (409 without recursive, then deleted)', async () => {
  const ids = nestedTree('mb-erin', 'f-d');
  const t = tok('dave');
  assert.equal((await call('DELETE', `${D('mb-erin')}/folders/${ids[0]}?force=true`, t)).status, 409);
  assertTreeIntact(ids);
  const r = await call('DELETE', `${D('mb-erin')}/folders/${ids[0]}?recursive=true&force=true`, t);
  assert.equal(r.status, 200);
  assertTreeMovedToTrash(ids, 'f-erin-trash', 'f-d');
});

test('compat route: children → 409 with counts, ?recursive=true → 204 and the subtree is gone', async () => {
  const t = tok('alice');
  const ids = nestedTree('mb-sm1', 'f-c');
  const refused = await call('DELETE', `${OLD('sm1')}/folders/${ids[0]}`, t);
  assert.deepEqual([refused.status, refused.json['code'], refused.json['subfolders']], [409, 'FOLDER_HAS_SUBFOLDERS', 3]);
  assertTreeIntact(ids);
  const r = await call('DELETE', `${OLD('sm1')}/folders/${ids[0]}?recursive=true`, t);
  assert.equal(r.status, 204);
  assertTreeMovedToTrash(ids, 'f-sm1-trash', 'f-c');
});
