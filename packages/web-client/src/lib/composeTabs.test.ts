import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_COMPOSE, activateTab, activeTab, closeTab, minimiseTabs, onMessageSelected, openTab, tabTitle, updateTab,
  type ComposeTabsState,
} from './composeTabs.ts';

type Ctx = { mode: string; draftId?: string };
const start = NO_COMPOSE as ComposeTabsState<Ctx>;

test('open: a new draft gets a tab and is shown; a second one minimises the first', () => {
  let s = openTab(start, 'k1', { mode: 'new' }, '');
  assert.equal(s.activeKey, 'k1');
  assert.deepEqual(s.tabs.map((t) => t.key), ['k1']);
  s = openTab(s, 'k2', { mode: 'reply' }, 'Re: x');
  assert.equal(s.activeKey, 'k2');
  assert.deepEqual(s.tabs.map((t) => [t.key, t.subject]), [['k1', ''], ['k2', 'Re: x']]);
  assert.equal(activeTab(s)?.key, 'k2');
});

test('open in the background (undo send while writing): tab added, the shown draft stays', () => {
  const s = openTab(openTab(start, 'k1', { mode: 'new' }, ''), 'k2', { mode: 'new', draftId: 'd2' }, 'x', { background: true });
  assert.equal(s.activeKey, 'k1');
  assert.equal(s.tabs.length, 2);
  assert.equal(s.tabs[1]!.draftId, 'd2');
});

test('a server draft that already has a tab is not opened twice — its tab is shown', () => {
  let s = openTab(start, 'k1', { mode: 'new', draftId: 'd1' }, 'a');
  s = minimiseTabs(s);
  const again = openTab(s, 'k9', { mode: 'new', draftId: 'd1' }, 'a');
  assert.equal(again.tabs.length, 1);
  assert.equal(again.activeKey, 'k1');
  // the tab follows the draft's newest version id
  s = updateTab(s, 'k1', { draftId: 'd1-v2' });
  assert.equal(openTab(s, 'k9', { mode: 'new', draftId: 'd1-v2' }, 'a').tabs.length, 1);
  assert.equal(openTab(s, 'k9', { mode: 'new', draftId: 'd1-v2' }, 'a', { background: true }), s, 'background: nothing changes');
});

test('switch / minimise / close', () => {
  let s = openTab(openTab(start, 'k1', { mode: 'new' }, ''), 'k2', { mode: 'new' }, '');
  s = activateTab(s, 'k1');
  assert.equal(s.activeKey, 'k1');
  assert.equal(activateTab(s, 'nope'), s, 'unknown tab');
  assert.equal(activateTab(s, 'k1'), s, 'already shown');
  s = minimiseTabs(s);
  assert.equal(s.activeKey, null);
  assert.equal(activeTab(s), undefined);
  assert.equal(minimiseTabs(s), s);
  s = activateTab(s, 'k2');
  s = closeTab(s, 'k1');                  // closing a tab in the strip keeps the shown one
  assert.deepEqual([s.activeKey, s.tabs.map((t) => t.key)], ['k2', ['k2']]);
  s = closeTab(s, 'k2');                  // closing the shown one shows the reader
  assert.deepEqual([s.activeKey, s.tabs.length], [null, 0]);
  assert.equal(closeTab(s, 'k2'), s);
});

test('update: subject / draft id / context of one tab; unknown tab unchanged', () => {
  const s = openTab(start, 'k1', { mode: 'new' }, '');
  const u = updateTab(s, 'k1', { subject: 'Hallo', draftId: 'd7', ctx: { mode: 'new', draftId: 'd7' } });
  assert.deepEqual(u.tabs[0], { key: 'k1', ctx: { mode: 'new', draftId: 'd7' }, draftId: 'd7', subject: 'Hallo' });
  assert.equal(updateTab(s, 'x', { subject: 'y' }), s);
});

test('opening another mail in the list minimises the shown draft (same mail: no change)', () => {
  const s = openTab(start, 'k1', { mode: 'reply' }, '');
  assert.equal(onMessageSelected(s, 'm1', 'm2').activeKey, null);
  assert.equal(onMessageSelected(s, 'm1', 'm1'), s);
  assert.equal(onMessageSelected(s, 'm1', null), s, 'deselect (folder switch) keeps the draft');
});

test('tab title falls back when the subject is empty', () => {
  assert.equal(tabTitle('  ', '(Kein Betreff)'), '(Kein Betreff)');
  assert.equal(tabTitle('Angebot', '(Kein Betreff)'), 'Angebot');
});
