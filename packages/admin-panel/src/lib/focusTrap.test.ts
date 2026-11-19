import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapTab } from './focusTrap.ts';

const items = ['a', 'b', 'c'];

test('Tab wraps from the last to the first element and Shift+Tab from the first to the last', () => {
  assert.deepEqual(trapTab(items, 'c', false), { kind: 'focus', target: 'a' });
  assert.deepEqual(trapTab(items, 'a', true), { kind: 'focus', target: 'c' });
});

test('Tab inside the list keeps the browser order', () => {
  assert.deepEqual(trapTab(items, 'b', false), { kind: 'default' });
  assert.deepEqual(trapTab(items, 'b', true), { kind: 'default' });
  assert.deepEqual(trapTab(items, 'a', false), { kind: 'default' });
  assert.deepEqual(trapTab(items, 'c', true), { kind: 'default' });
});

test('focus outside the dialog is pulled back in', () => {
  assert.deepEqual(trapTab(items, null, false), { kind: 'focus', target: 'a' });
  assert.deepEqual(trapTab(items, null, true), { kind: 'focus', target: 'c' });
  assert.deepEqual(trapTab(items, 'outside', false), { kind: 'focus', target: 'a' });
});

test('a dialog without tabbable elements blocks Tab', () => {
  assert.deepEqual(trapTab([], null, false), { kind: 'block' });
});
