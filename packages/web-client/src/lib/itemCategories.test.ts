import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoriesAfterToggle, categoryOptions, toggleCategory } from './itemCategories.ts';

test('toggleCategory adds and removes case-insensitively, order kept', () => {
  assert.deepEqual(toggleCategory(['Rot'], ' Blau '), ['Rot', 'Blau']);
  assert.deepEqual(toggleCategory(['Rot', 'Blau'], 'rot'), ['Blau']);
});

test('fast successive toggles merge on the newest list (the menu was drawn before the first save)', () => {
  const drawn: string[] = [];
  const afterFirst = categoriesAfterToggle(undefined, drawn, 'Rot');
  assert.deepEqual(afterFirst, ['Rot']);
  // the second toggle reads the list the first one produced, not the stale drawn one
  assert.deepEqual(categoriesAfterToggle(afterFirst, drawn, 'Blau'), ['Rot', 'Blau']);
  assert.deepEqual(toggleCategory(drawn, 'Blau'), ['Blau'], 'the stale list would have lost "Rot"');
});

test('categoryOptions keeps names an item carries that are not in the list', () => {
  assert.deepEqual(categoryOptions([{ name: 'Rot', color: '#f00' }], ['Rot', 'Fremd']).map((o) => o.name), ['Rot', 'Fremd']);
});
