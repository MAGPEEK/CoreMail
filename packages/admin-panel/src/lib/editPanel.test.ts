import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabForKey, rememberTab, initialTab, withDirty, needsDiscardConfirm, type TabMemory } from './editPanel.ts';

const ids = ['general', 'limits', 'flow'];

test('arrow keys move between tabs and wrap', () => {
  assert.equal(tabForKey(ids, 'general', 'ArrowRight'), 'limits');
  assert.equal(tabForKey(ids, 'flow', 'ArrowRight'), 'general');
  assert.equal(tabForKey(ids, 'general', 'ArrowLeft'), 'flow');
  assert.equal(tabForKey(ids, 'limits', 'Home'), 'general');
  assert.equal(tabForKey(ids, 'limits', 'End'), 'flow');
});

test('other keys and an empty tab list are not handled', () => {
  assert.equal(tabForKey(ids, 'general', 'Enter'), null);
  assert.equal(tabForKey([], 'general', 'ArrowRight'), null);
});

test('an unknown current tab behaves like the first', () => {
  assert.equal(tabForKey(ids, 'gone', 'ArrowRight'), 'limits');
});

test('the last tab is remembered per panel kind and validated', () => {
  const memory: TabMemory = new Map();
  assert.equal(initialTab(memory, 'mailbox', ids), 'general');
  rememberTab(memory, 'mailbox', 'flow');
  assert.equal(initialTab(memory, 'mailbox', ids), 'flow');
  assert.equal(initialTab(memory, 'domain', ids), 'general');
  assert.equal(initialTab(memory, 'mailbox', ['general', 'limits']), 'general');
  assert.equal(initialTab(memory, 'mailbox', []), '');
});

test('dirty tabs are tracked immutably and guard closing', () => {
  const clean = new Set<string>();
  assert.equal(needsDiscardConfirm(clean), false);
  const dirty = withDirty(clean, 'flow', true);
  assert.notEqual(dirty, clean);
  assert.equal(clean.size, 0);
  assert.equal(needsDiscardConfirm(dirty), true);
  assert.equal(withDirty(dirty, 'flow', true), dirty);
  assert.equal(needsDiscardConfirm(withDirty(dirty, 'flow', false)), false);
  assert.equal(withDirty(clean, 'flow', false), clean);
});
