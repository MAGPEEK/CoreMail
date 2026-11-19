import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTarget, treeTarget, tabStopIndex, type TreeItemInfo } from './rovingFocus.ts';

test('listTarget moves and clamps at both ends', () => {
  assert.equal(listTarget('ArrowDown', 0, 3), 1);
  assert.equal(listTarget('ArrowDown', 2, 3), 2);
  assert.equal(listTarget('ArrowUp', 0, 3), 0);
  assert.equal(listTarget('Home', 2, 5), 0);
  assert.equal(listTarget('End', 0, 5), 4);
  assert.equal(listTarget('PageDown', 0, 25), 10);
  assert.equal(listTarget('PageUp', 3, 25), 0);
});

test('listTarget ignores other keys and empty lists', () => {
  assert.equal(listTarget('a', 0, 3), null);
  assert.equal(listTarget('ArrowDown', 0, 0), null);
});

const TREE: TreeItemInfo[] = [
  { level: 1, expandable: false, expanded: false }, // 0 Posteingang
  { level: 1, expandable: true, expanded: true },   // 1 Projekte
  { level: 2, expandable: false, expanded: false }, // 2 Alpha
  { level: 2, expandable: true, expanded: false },  // 3 Beta
  { level: 1, expandable: false, expanded: false }, // 4 Archiv
];

test('treeTarget: Down/Up/Home/End focus neighbours', () => {
  assert.deepEqual(treeTarget('ArrowDown', TREE, 0), { kind: 'focus', index: 1 });
  assert.deepEqual(treeTarget('ArrowUp', TREE, 2), { kind: 'focus', index: 1 });
  assert.deepEqual(treeTarget('Home', TREE, 3), { kind: 'focus', index: 0 });
  assert.deepEqual(treeTarget('End', TREE, 0), { kind: 'focus', index: 4 });
  assert.equal(treeTarget('ArrowUp', TREE, 0), null);
});

test('treeTarget: Right expands a closed node, then steps into the first child', () => {
  assert.deepEqual(treeTarget('ArrowRight', TREE, 3), { kind: 'expand' });
  assert.deepEqual(treeTarget('ArrowRight', TREE, 1), { kind: 'focus', index: 2 });
  assert.equal(treeTarget('ArrowRight', TREE, 0), null);
});

test('treeTarget: Left collapses an open node, else goes to the parent', () => {
  assert.deepEqual(treeTarget('ArrowLeft', TREE, 1), { kind: 'collapse' });
  assert.deepEqual(treeTarget('ArrowLeft', TREE, 3), { kind: 'focus', index: 1 });
  assert.equal(treeTarget('ArrowLeft', TREE, 0), null);
});

test('treeTarget: an index outside the list does nothing', () => {
  assert.equal(treeTarget('ArrowDown', TREE, 9), null);
});

test('tabStopIndex prefers the focused item, then the selected, then the first', () => {
  assert.equal(tabStopIndex(5, 3, 1), 3);
  assert.equal(tabStopIndex(5, -1, 1), 1);
  assert.equal(tabStopIndex(5, -1, -1), 0);
  assert.equal(tabStopIndex(5, 8, 2), 2);
  assert.equal(tabStopIndex(0, 0, 0), -1);
});
