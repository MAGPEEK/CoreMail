import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FOLDER_HITS, hasExplicitGrants, foldersWithGrants, folderChoices, searchFolders, moveHighlight,
} from './folderPicker.ts';
import type { FolderPermissionsOverview, PermissionEntry } from './folderPermissions.ts';

const entry = (over: Partial<PermissionEntry>): PermissionEntry => ({
  granteeKey: 'default', user: null, rights: 0, role: 'none', applyToSubfolders: false, ...over,
});
const defaults = (): PermissionEntry[] => [entry({}), entry({ granteeKey: 'anonymous', fixed: true })];
const withUser = (): PermissionEntry[] => [...defaults(), entry({ granteeKey: 'user:u1', rights: 0x401, role: 'reviewer' })];
const folder = (id: string, name: string, parentId: string | null, entries = defaults()): FolderPermissionsOverview =>
  ({ id, name, parentId, entries });

test('only user grants or a non-empty Default count as explicit', () => {
  assert.equal(hasExplicitGrants(defaults()), false);
  assert.equal(hasExplicitGrants(withUser()), true);
  assert.equal(hasExplicitGrants([entry({ rights: 0x401, role: 'reviewer' }), entry({ granteeKey: 'anonymous' })]), true);
  assert.equal(hasExplicitGrants([]), false);
});

test('foldersWithGrants keeps only folders with explicit grants', () => {
  const list = [folder('a', 'INBOX', null, withUser()), folder('b', 'Drafts', null)];
  assert.deepEqual(foldersWithGrants(list).map((f) => f.id), ['a']);
});

test('folderChoices builds German paths through the parents', () => {
  const list = [folder('1', 'INBOX', null), folder('2', 'Projekte', '1'), folder('3', '2026', '2')];
  assert.deepEqual(folderChoices(list).map((c) => c.path), ['Posteingang', 'Posteingang / Projekte', 'Posteingang / Projekte / 2026']);
  assert.equal(folderChoices(list)[2]!.label, '2026');
});

test('folderChoices survives a missing parent and a parent cycle', () => {
  const list = [folder('1', 'A', 'missing'), folder('2', 'B', '3'), folder('3', 'C', '2')];
  assert.deepEqual(folderChoices(list).map((c) => c.path), ['A', 'C / B', 'B / C']);
});

test('searchFolders matches every word case-insensitively and sorts by path', () => {
  const choices = folderChoices([
    folder('1', 'INBOX', null), folder('2', 'Rechnungen', '1'), folder('3', 'Rechnungen 2025', null), folder('4', 'Müller', '1'),
  ]);
  assert.deepEqual(searchFolders(choices, 'RECHN').map((c) => c.id), ['2', '3']);
  assert.deepEqual(searchFolders(choices, 'posteingang rechn').map((c) => c.id), ['2']);
  assert.deepEqual(searchFolders(choices, 'müller').map((c) => c.id), ['4']);
  assert.deepEqual(searchFolders(choices, 'zzz'), []);
  assert.equal(searchFolders(choices, '  ').length, 4);
});

test('searchFolders caps the hits', () => {
  const many = Array.from({ length: 120 }, (_, i) => folder(`f${i}`, `Ordner ${i}`, null));
  assert.equal(searchFolders(folderChoices(many), '').length, MAX_FOLDER_HITS);
});

test('moveHighlight wraps and handles an empty list', () => {
  assert.equal(moveHighlight(-1, 3, 1), 0);
  assert.equal(moveHighlight(-1, 3, -1), 2);
  assert.equal(moveHighlight(2, 3, 1), 0);
  assert.equal(moveHighlight(0, 3, -1), 2);
  assert.equal(moveHighlight(0, 0, 1), -1);
});
