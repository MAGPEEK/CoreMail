/**
 * Folder delete with subfolders (lib/folder-delete.ts + storage folder-delete.ts)
 * on the three routes — own mailbox DELETE /mail/folders/:id, shared/delegated
 * DELETE /mail/{shared,delegated}-mailboxes/:id/folders/:fid and the pre-9.3
 * compat DELETE /user/shared-mailboxes/:id/folders/:fid:
 *  - without ?recursive=true, own mailbox and compat route (9.3 contract: 200 /
 *    204): only the folder goes (its mail to Trash), its direct subfolders move up
 *    to its parent — never orphaned at the top level;
 *  - without ?recursive=true, shared/delegated routes (9.3 contract): 409
 *    FOLDER_HAS_SUBFOLDERS with { subfolders, count } and nothing changed;
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

test('decideFolderDelete: recursive (protected, then mail of the subtree) / non-recursive (policy, then own mail)', () => {
  const sum = (subfolders: number, count: number, ownCount = count, protectedInside: string | null = null) =>
    ({ subfolders, count, ownCount, protectedInside });
  type Sum = ReturnType<typeof sum>;
  const code = (s: Sum, recursive: boolean, force: boolean, policy: 'reparent' | 'refuse' = 'refuse') =>
    decideFolderDelete(s, { recursive, force }, policy)?.code ?? null;
  assert.equal(code(sum(0, 0), false, false), null);
  assert.equal(code(sum(0, 2), false, false), 'FOLDER_NOT_EMPTY');
  assert.equal(code(sum(0, 2), false, true), null);
  assert.equal(code(sum(3, 0), false, true), 'FOLDER_HAS_SUBFOLDERS');
  assert.equal(code(sum(3, 0), false, true, 'reparent'), null);
  assert.equal(code(sum(3, 5, 0), false, false, 'reparent'), null, 'only the own mail counts without recursive');
  assert.equal(code(sum(3, 5, 1), false, false, 'reparent'), 'FOLDER_NOT_EMPTY');
  assert.equal(code(sum(3, 5, 0, 'INBOX'), false, false, 'reparent'), null, 'a protected subfolder is kept, not deleted');
  assert.equal(code(sum(3, 0), true, false), null);
  assert.equal(code(sum(3, 5), true, false), 'FOLDER_NOT_EMPTY');
  assert.equal(code(sum(3, 5), true, true), null);
  assert.equal(code(sum(3, 5, 5, 'INBOX'), true, true), 'PROTECTED_SUBFOLDER');
  assert.equal(code(sum(3, 5, 5, 'INBOX'), true, true, 'reparent'), 'PROTECTED_SUBFOLDER');
  assert.deepEqual(decideFolderDelete(sum(3, 5), { recursive: false, force: true }, 'refuse'), {
    error: 'Ordner hat Unterordner', code: 'FOLDER_HAS_SUBFOLDERS', subfolders: 3, count: 5,
  });
  assert.deepEqual(decideFolderDelete(sum(3, 5, 2), { recursive: false, force: false }, 'reparent'), {
    error: 'Ordner nicht leer', code: 'FOLDER_NOT_EMPTY', subfolders: 3, count: 2,
  });
});

test('own mailbox without ?recursive=true (9.3: 200): the folder goes, its direct subfolders move up to its parent', async () => {
  const t = tok('alice');
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  addFolder('f-alice-top', 'mb-alice', 'Oben');
  const ids = nestedTree('mb-alice', 'f-rp', 'f-alice-top');
  const url = `/api/v1/mail/folders/${ids[1]}`;

  const refused = await call('DELETE', url, t);
  assert.deepEqual([refused.status, refused.json['code'], refused.json['count']], [409, 'FOLDER_NOT_EMPTY', 1], 'own mail only');
  assertTreeIntact(ids);

  const r = await call('DELETE', `${url}?force=true`, t);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json['folders'], r.json['movedToTrash'], r.json['reparented']], [1, 1, 1]);
  assert.equal(folderById(ids[1]!), undefined);
  assert.deepEqual(deletedFolderIds, [ids[1]]);
  assert.equal(folderById(ids[2]!)!['parentId'], ids[0], 'direct subfolder moved up to the parent — not to the top level');
  assert.equal(folderById(ids[3]!)!['parentId'], ids[2], 'deeper levels unchanged');
  assert.equal(folderById(ids[0]!)!['parentId'], 'f-alice-top');
  assert.equal(msg(`m-${ids[1]}`)['folderId'], 'f-alice-trash');
  for (const id of [ids[0], ids[2], ids[3]]) assert.equal(msg(`m-${id}`)['folderId'], id, 'mail of the kept folders stays');
  assert.ok(writes.indexOf('message.update') < writes.indexOf('folder.updateMany'));
  assert.ok(writes.indexOf('folder.updateMany') < writes.indexOf('folder.delete'), 'subfolders re-parented before the row goes');
});

test('own mailbox: a top-level folder without ?recursive=true — its subfolders become top-level, an empty one needs no Trash', async () => {
  addFolder('f-e-root', 'mb-alice', 'Leer');
  addFolder('f-e-a', 'mb-alice', 'Leer2', 'f-e-root');
  addFolder('f-e-b', 'mb-alice', 'Leer3', 'f-e-root');
  const r = await call('DELETE', '/api/v1/mail/folders/f-e-root', tok('alice'));
  assert.deepEqual([r.status, r.json['reparented']], [200, 2]);
  assert.equal(folderById('f-e-a')!['parentId'], null);
  assert.equal(folderById('f-e-b')!['parentId'], null);
});

test('own mailbox: depth 3 with ?recursive=true, then everything goes to Trash', async () => {
  const t = tok('alice');
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  const ids = nestedTree('mb-alice', 'f-al');
  const url = `/api/v1/mail/folders/${ids[0]}`;

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
  const r = await call('DELETE', '/api/v1/mail/folders/f-e-root?recursive=true', tok('alice'));
  assert.deepEqual([r.status, r.json['folders'], r.json['reparented']], [200, 3, 0]);
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

test('compat route without ?recursive=true: 204, the folder goes, its direct subfolder moves up (force implied)', async () => {
  addFolder('f-c-top', 'mb-sm1', 'Ablage');
  const ids = nestedTree('mb-sm1', 'f-cr', 'f-c-top');
  const r = await call('DELETE', `${OLD('sm1')}/folders/${ids[0]}`, tok('alice'));
  assert.equal(r.status, 204);
  assert.deepEqual(deletedFolderIds, [ids[0]]);
  assert.equal(folderById(ids[1]!)!['parentId'], 'f-c-top');
  assert.equal(msg(`m-${ids[0]}`)['folderId'], 'f-sm1-trash');
  assert.equal(msg(`m-${ids[1]}`)['folderId'], ids[1]);
  await flush();
  const a = auditRows.find((x) => x['action'] === 'mailbox.foreign.folder.delete')!;
  assert.deepEqual([(a['changes'] as Row)['folders'], (a['changes'] as Row)['reparented']], [1, 1]);
});

test('compat route: ?recursive=true → 204 and the subtree is gone', async () => {
  const t = tok('alice');
  const ids = nestedTree('mb-sm1', 'f-c');
  const r = await call('DELETE', `${OLD('sm1')}/folders/${ids[0]}?recursive=true`, t);
  assert.equal(r.status, 204);
  assertTreeMovedToTrash(ids, 'f-sm1-trash', 'f-c');
});
