import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutModeForWidth, visibleMailPanes, backTarget, type MailPaneState } from './layoutMode.ts';

const base: MailPaneState = {
  mode: 'three', hasFolder: true, hasMessage: false, composeOpen: false, foldersShown: false, readingPane: 'right',
};

test('breakpoints: 320, 767 single; 768, 1099 two; 1100 three', () => {
  assert.equal(layoutModeForWidth(320), 'single');
  assert.equal(layoutModeForWidth(767), 'single');
  assert.equal(layoutModeForWidth(768), 'two');
  assert.equal(layoutModeForWidth(1099), 'two');
  assert.equal(layoutModeForWidth(1100), 'three');
});

test('three panes keep the reading pane preference', () => {
  assert.deepEqual(visibleMailPanes(base), ['folders', 'list', 'reader']);
  assert.deepEqual(visibleMailPanes({ ...base, readingPane: 'off' }), ['folders', 'list']);
  assert.deepEqual(visibleMailPanes({ ...base, composeOpen: true }), ['folders', 'list', 'compose']);
  assert.deepEqual(visibleMailPanes({ ...base, hasFolder: false }), ['folders']);
});

test('two panes: list + reader, folders are a drawer', () => {
  const s = { ...base, mode: 'two' as const };
  assert.deepEqual(visibleMailPanes(s), ['list', 'reader']);
  assert.deepEqual(visibleMailPanes({ ...s, readingPane: 'off' }), ['list']);
  assert.deepEqual(visibleMailPanes({ ...s, composeOpen: true }), ['list', 'compose']);
});

test('single pane: folders -> list -> reader, compose wins', () => {
  const s = { ...base, mode: 'single' as const };
  assert.deepEqual(visibleMailPanes(s), ['list']);
  assert.deepEqual(visibleMailPanes({ ...s, foldersShown: true }), ['folders']);
  assert.deepEqual(visibleMailPanes({ ...s, hasFolder: false }), ['folders']);
  assert.deepEqual(visibleMailPanes({ ...s, hasMessage: true }), ['reader']);
  assert.deepEqual(visibleMailPanes({ ...s, hasMessage: true, readingPane: 'off' }), ['reader']);
  assert.deepEqual(visibleMailPanes({ ...s, hasMessage: true, composeOpen: true }), ['compose']);
});

test('backTarget steps one level up and stops at the folders', () => {
  assert.equal(backTarget('reader'), 'list');
  assert.equal(backTarget('list'), 'folders');
  assert.equal(backTarget('folders'), null);
  assert.equal(backTarget('compose'), null);
});
