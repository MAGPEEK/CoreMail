import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addFavorite, favoriteEntryOf, favoriteFolders, isFavorite, pruneFavorites, pushRecentFolder, removeFavorite, MAX_FAVORITES,
} from './folderLists.ts';
import { DEFAULT_PREFERENCES } from './preferences.ts';

const F = [
  { id: 'f-inbox', name: 'INBOX', isSystem: true },
  { id: 'f-sent', name: 'Sent', isSystem: true },
  { id: 'f-drafts', name: 'Drafts', isSystem: true },
  { id: 'f-trash', name: 'Trash', isSystem: true },
  { id: 'f-junk', name: 'Junk', isSystem: true },
  { id: 'f-proj', name: 'Projekte', isSystem: false },
  { id: 'f-old', name: 'Alt', isSystem: false, isFavorite: true },
  // a user folder that happens to be called "Sent" is not the default folder
  { id: 'f-fake', name: 'Sent', isSystem: false },
];

test('default favourites: Posteingang, Gesendete Elemente, Entwürfe, Gelöschte Elemente (+ pre-10.1 flags)', () => {
  const favs = favoriteFolders(DEFAULT_PREFERENCES.folders.favorites, F);
  assert.deepEqual(favs.map((f) => f.id), ['f-inbox', 'f-sent', 'f-drafts', 'f-trash', 'f-old']);
});

test('add / remove keep order, refer to default folders by name and other folders by id', () => {
  let list = addFavorite(['INBOX'], F[5]!);
  assert.deepEqual(list, ['INBOX', 'f-proj']);
  list = addFavorite(list, F[4]!);
  assert.deepEqual(list, ['INBOX', 'f-proj', 'Junk']);
  assert.deepEqual(addFavorite(list, F[5]!), list, 'no duplicates');
  assert.deepEqual(removeFavorite(list, F[0]!), ['f-proj', 'Junk']);
  assert.equal(favoriteEntryOf(F[7]!), 'f-fake');
  assert.equal(isFavorite(['Sent'], F[7]!), false, 'the name only matches the default folder');
  assert.equal(isFavorite(['Sent'], F[1]!), true);
  assert.equal(isFavorite([], F[6]!), true, 'legacy flag');
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => `x${i}`);
  assert.equal(addFavorite(full, F[5]!).length, MAX_FAVORITES);
});

test('entries of deleted folders are skipped and pruned; default names stay', () => {
  assert.deepEqual(favoriteFolders(['gone', 'INBOX'], F).map((f) => f.id), ['f-inbox', 'f-old']);
  assert.deepEqual(pruneFavorites(['gone', 'INBOX', 'f-proj', 'Archive'], F), ['INBOX', 'f-proj', 'Archive']);
});

test('recent move targets: newest first, unique, at most five', () => {
  let r: string[] = [];
  for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) r = pushRecentFolder(r, id);
  assert.deepEqual(r, ['f', 'e', 'd', 'a', 'c']);
});
