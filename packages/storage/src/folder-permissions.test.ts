/**
 * w3 folder permissions — the rights model (roles, inheritance, combination with
 * mailbox-level grants, operations).
 * Run: node --import tsx --test src/folder-permissions.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_FOLDER_RIGHTS, DEFAULT_GRANTEE_KEY, FolderRight, READ_ONLY_FLOOR, ROLE_RIGHTS,
  applicableGrant, canAdministerFolder, canCreateItems, canCreateSubfolder, canDeleteItem, canEditItem,
  canManageFolder, canReadFolder, canSeeFolder, computeFolderRights, descendantFolderIds, folderParents, folderPath, granteeUserId,
  hasAnyWriteRight, indexGrants, normalizeRights, reparentedFolders, roleOfRights, userGranteeKey, type FolderGrantRow,
} from './folder-permissions.js';

const R = FolderRight;

test('roles carry the member-rights values of the public specification', () => {
  assert.equal(ROLE_RIGHTS.owner, ALL_FOLDER_RIGHTS);
  assert.equal(ROLE_RIGHTS.owner, R.ReadAny | R.Create | R.EditOwned | R.DeleteOwned | R.EditAny | R.DeleteAny
    | R.CreateSubfolder | R.FolderOwner | R.FolderContact | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.publishingEditor, ALL_FOLDER_RIGHTS & ~(R.FolderOwner | R.FolderContact));
  assert.equal(ROLE_RIGHTS.editor, ROLE_RIGHTS.publishingEditor & ~R.CreateSubfolder);
  assert.equal(ROLE_RIGHTS.publishingAuthor, R.ReadAny | R.Create | R.EditOwned | R.DeleteOwned | R.CreateSubfolder | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.author, R.ReadAny | R.Create | R.EditOwned | R.DeleteOwned | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.nonEditingAuthor, R.ReadAny | R.Create | R.DeleteOwned | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.reviewer, R.ReadAny | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.contributor, R.Create | R.FolderVisible);
  assert.equal(ROLE_RIGHTS.none, 0, '"None" grants nothing — not even visibility');
});

test('roleOfRights recognises every role and reports anything else as custom', () => {
  for (const [role, rights] of Object.entries(ROLE_RIGHTS)) assert.equal(roleOfRights(rights), role);
  assert.equal(roleOfRights(R.ReadAny), 'custom', 'read without visibility');
  assert.equal(roleOfRights(R.FolderVisible), 'custom');
  assert.equal(roleOfRights(0x1000 | ROLE_RIGHTS.reviewer), 'reviewer', 'unknown bits (free/busy) are dropped');
});

test('normalizeRights: unknown bits dropped, "all" implies "own", invalid → 0', () => {
  assert.equal(normalizeRights(R.EditAny), R.EditAny | R.EditOwned);
  assert.equal(normalizeRights(R.DeleteAny), R.DeleteAny | R.DeleteOwned);
  assert.equal(normalizeRights(0x800 | 0x1000 | R.ReadAny), R.ReadAny);
  assert.equal(normalizeRights(-1), 0);
  assert.equal(normalizeRights(1.5), 0);
});

test('grantee keys', () => {
  assert.equal(userGranteeKey('u1'), 'user:u1');
  assert.equal(granteeUserId('user:u1'), 'u1');
  assert.equal(granteeUserId(DEFAULT_GRANTEE_KEY), null);
});

const folders = [
  { id: 'inbox', name: 'INBOX', parentId: null },
  { id: 'proj', name: 'Projects', parentId: null },
  { id: 'proj-a', name: 'A', parentId: 'proj' },
  { id: 'proj-a-x', name: 'X', parentId: 'proj-a' },
  { id: 'imap-parent', name: 'Archive', parentId: null },
  { id: 'imap-child', name: 'Archive.2025', parentId: null },
  { id: 'loose', name: 'Loose', parentId: null },
];

test('folderParents: parentId first, else the "." name prefix; root folders (also custom ones) have none', () => {
  const p = folderParents(folders);
  assert.equal(p.get('proj-a'), 'proj');
  assert.equal(p.get('imap-child'), 'imap-parent');
  assert.equal(p.get('loose'), null, 'a parentless webmail folder is not a subfolder of INBOX');
  assert.equal(p.get('inbox'), null);
  assert.deepEqual(folderPath('proj-a-x', p), ['proj-a-x', 'proj-a', 'proj']);
});

test('w3 review: descendantFolderIds follows parentId and the "." name prefix', () => {
  assert.deepEqual(descendantFolderIds(folders, 'proj').sort(), ['proj-a', 'proj-a-x']);
  assert.deepEqual(descendantFolderIds(folders, 'imap-parent'), ['imap-child']);
  assert.deepEqual(descendantFolderIds(folders, 'loose'), []);
});

test('w3 review: reparentedFolders — a new or renamed folder must not adopt unrelated folders by name', () => {
  const tree = [
    { id: 'x', name: 'Shared', parentId: null },
    { id: 'mr', name: 'Mr. Smith', parentId: null }, // a top-level webmail folder whose name contains "."
    { id: 'y', name: 'Old', parentId: null },
    { id: 'y-sub', name: 'Old.sub', parentId: null }, // IMAP child of "Old"
  ];
  // a grantee creates "Mr" below its shared folder: "Mr. Smith" would move below it
  assert.deepEqual(reparentedFolders(tree, [...tree, { id: 'new', name: 'Mr', parentId: 'x' }]), ['mr']);
  assert.deepEqual(reparentedFolders(tree, [...tree, { id: 'new', name: 'Other', parentId: 'x' }]), []);
  // renaming "Shared" to "Mr" adopts it as well; the renamed folder itself is exempt
  const renamed = tree.map((f) => (f.id === 'x' ? { ...f, name: 'Mr' } : f));
  assert.deepEqual(reparentedFolders(tree, renamed, new Set(['x'])), ['mr']);
  // deleting "Old" leaves its IMAP child without a parent
  assert.deepEqual(reparentedFolders(tree, tree.filter((f) => f.id !== 'y')), ['y-sub']);
});

test('folderPath is cycle-safe', () => {
  const p = folderParents([{ id: 'a', name: 'a', parentId: 'b' }, { id: 'b', name: 'b', parentId: 'a' }]);
  assert.deepEqual(folderPath('a', p), ['a', 'b']);
});

const g = (folderId: string, granteeKey: string, rights: number, applyToSubfolders = false): FolderGrantRow =>
  ({ folderId, granteeKey, rights, applyToSubfolders });

test('applicableGrant: own entry, else the nearest ancestor entry with "apply to subfolders"', () => {
  const p = folderParents(folders);
  const idx = indexGrants([
    g('proj', 'user:b', ROLE_RIGHTS.editor, true),
    g('proj-a', 'user:b', ROLE_RIGHTS.reviewer, false),
  ]);
  assert.deepEqual(applicableGrant('proj', 'user:b', p, idx), { rights: ROLE_RIGHTS.editor, applyToSubfolders: true, fromFolderId: 'proj', inherited: false });
  assert.equal(applicableGrant('proj-a', 'user:b', p, idx)?.rights, ROLE_RIGHTS.reviewer, 'the own entry wins');
  // proj-a's entry does not reach its subfolders → the next inheriting ancestor (proj) applies
  assert.deepEqual(applicableGrant('proj-a-x', 'user:b', p, idx), { rights: ROLE_RIGHTS.editor, applyToSubfolders: true, fromFolderId: 'proj', inherited: true });
  assert.equal(applicableGrant('inbox', 'user:b', p, idx), null);
  assert.equal(applicableGrant('proj', 'user:c', p, idx), null, 'other grantees have nothing');
});

test('computeFolderRights — table: user beats Default, floor adds, explicit None overrides Default, inheritance', () => {
  const rows = [
    g('inbox', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.reviewer),
    g('inbox', 'user:x', ROLE_RIGHTS.none), // X is excluded from Default
    g('proj', 'user:b', ROLE_RIGHTS.author, true),
    g('proj-a', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.editor),
    g('loose', 'user:b', ROLE_RIGHTS.contributor),
  ];
  const cases: Array<[user: string, floor: number, folder: string, expected: number]> = [
    ['b', 0, 'inbox', ROLE_RIGHTS.reviewer],                        // Default
    ['x', 0, 'inbox', 0],                                          // explicit None beats Default
    ['x', READ_ONLY_FLOOR, 'inbox', READ_ONLY_FLOOR],              // the mailbox READ_ONLY floor stays
    ['b', 0, 'proj', ROLE_RIGHTS.author],
    ['b', 0, 'proj-a', ROLE_RIGHTS.author],                        // inherited user grant beats Default's own entry
    ['c', 0, 'proj-a', ROLE_RIGHTS.editor],                        // Default only
    ['b', 0, 'proj-a-x', ROLE_RIGHTS.author],                      // inherited two levels
    ['c', 0, 'proj-a-x', 0],                                       // Default on proj-a does not inherit
    ['b', 0, 'loose', ROLE_RIGHTS.contributor],
    ['b', READ_ONLY_FLOOR, 'loose', ROLE_RIGHTS.contributor | R.ReadAny],
    ['c', 0, 'imap-child', 0],
  ];
  for (const [user, floor, folder, expected] of cases) {
    assert.equal(computeFolderRights(folders, rows, user, floor).get(folder), normalizeRights(expected), `${user}/${floor}/${folder}`);
  }
});

test('operations: owner and full access may do everything, full access does not administer permissions', () => {
  for (const level of ['owner', 'full'] as const) {
    const a = { level, rights: 0 };
    for (const can of [canSeeFolder, canReadFolder, canCreateItems, canCreateSubfolder, canManageFolder, hasAnyWriteRight]) assert.equal(can(a), true, `${level} ${can.name}`);
    assert.equal(canEditItem(a, false), true);
    assert.equal(canDeleteItem(a, false), true);
  }
  assert.equal(canAdministerFolder({ level: 'owner', rights: 0 }), true);
  assert.equal(canAdministerFolder({ level: 'full', rights: ALL_FOLDER_RIGHTS }), false);
});

test('operations from folder grants', () => {
  const as = (rights: number) => ({ level: 'grants' as const, rights: normalizeRights(rights) });
  const reviewer = as(ROLE_RIGHTS.reviewer);
  assert.equal(canReadFolder(reviewer), true);
  assert.equal(canEditItem(reviewer, true), false);
  assert.equal(canDeleteItem(reviewer, true), false);
  assert.equal(canCreateItems(reviewer), false);
  assert.equal(hasAnyWriteRight(reviewer), false);
  const author = as(ROLE_RIGHTS.author);
  assert.equal(canEditItem(author, true), true, 'own items');
  assert.equal(canEditItem(author, false), false, 'not the items of others');
  assert.equal(canDeleteItem(author, false), false);
  const nonEditing = as(ROLE_RIGHTS.nonEditingAuthor);
  assert.equal(canEditItem(nonEditing, true), false);
  assert.equal(canDeleteItem(nonEditing, true), true);
  const contributor = as(ROLE_RIGHTS.contributor);
  assert.equal(canReadFolder(contributor), false);
  assert.equal(canCreateItems(contributor), true);
  const owner = as(ROLE_RIGHTS.owner);
  assert.equal(canManageFolder(owner), true);
  assert.equal(canAdministerFolder(owner), true, 'the Owner role administers the folder');
  assert.equal(canAdministerFolder(as(ROLE_RIGHTS.publishingEditor)), false);
  assert.equal(canCreateSubfolder(as(ROLE_RIGHTS.publishingAuthor)), true);
  assert.equal(canCreateSubfolder(as(ROLE_RIGHTS.editor)), false);
  assert.equal(canSeeFolder(as(R.ReadAny)), false, 'read without "folder visible" is not listed');
});
