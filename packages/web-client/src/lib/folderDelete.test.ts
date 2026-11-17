import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFolderSubtree, folderDeleteQuery, folderDeleteConfirmKey, isStaleSubfolderRefusal } from './folderDelete.ts';

const tree = [
  { id: 'inbox', parentId: null, totalCount: 9 },
  { id: 'root', parentId: null, totalCount: 1 },
  { id: 'a', parentId: 'root', totalCount: 2 },
  { id: 'b', parentId: 'a', totalCount: 3 },
  { id: 'c', parentId: 'b', totalCount: 4 },
  { id: 'a2', parentId: 'root' },
  { id: 'other', parentId: 'inbox', totalCount: 50 },
];

test('summarizeFolderSubtree: subfolders at any depth (depth 3) and all their messages', () => {
  assert.deepEqual(summarizeFolderSubtree('root', tree), { subfolders: 4, count: 10 });
  assert.deepEqual(summarizeFolderSubtree('b', tree), { subfolders: 1, count: 7 });
  assert.deepEqual(summarizeFolderSubtree('c', tree), { subfolders: 0, count: 4 });
  assert.deepEqual(summarizeFolderSubtree('missing', tree), { subfolders: 0, count: 0 });
});

test('summarizeFolderSubtree: a parent cycle does not loop', () => {
  const cyc = [{ id: 'x', parentId: 'y', totalCount: 1 }, { id: 'y', parentId: 'x', totalCount: 1 }];
  assert.deepEqual(summarizeFolderSubtree('x', cyc), { subfolders: 1, count: 2 });
});

test('folderDeleteQuery: recursive only when the user saw subfolders', () => {
  assert.equal(folderDeleteQuery({ subfolders: 0, count: 3 }), '?force=true');
  assert.equal(folderDeleteQuery({ subfolders: 2, count: 0 }), '?force=true&recursive=true');
});

test('folderDeleteConfirmKey: tree, mail, empty', () => {
  assert.equal(folderDeleteConfirmKey({ subfolders: 1, count: 0 }), 'folder_delete_confirm_tree');
  assert.equal(folderDeleteConfirmKey({ subfolders: 0, count: 1 }), 'folder_delete_confirm_mail');
  assert.equal(folderDeleteConfirmKey({ subfolders: 0, count: 0 }), 'folder_delete_confirm');
});

test('isStaleSubfolderRefusal', () => {
  assert.equal(isStaleSubfolderRefusal({ code: 'FOLDER_HAS_SUBFOLDERS' }), true);
  assert.equal(isStaleSubfolderRefusal({ code: 'FOLDER_NOT_EMPTY' }), false);
  assert.equal(isStaleSubfolderRefusal(null), false);
});
