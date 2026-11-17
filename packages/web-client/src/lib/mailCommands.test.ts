import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_COMMAND_ORDER, NO_SELECTION_HINT, categoryCoverage, commandTargets, mailCommandStates,
  nextCategoryIds, readToggle, readerOverflowActions, summarizeSelection, type MailCommandContext,
} from './mailCommands.ts';
import { OWN_ONLY_HINT, READ_ONLY_HINT } from './mailboxContext.ts';

const ctx = (over: Partial<MailCommandContext> = {}, count = 1): MailCommandContext => ({
  selection: summarizeSelection(count, count ? [{ flags: ['\\Seen'] }] : []),
  readOnly: false,
  foreign: false,
  isJunkFolder: false,
  ...over,
});

const WRITE = ['delete', 'archive', 'move', 'junk', 'flag', 'read', 'pin'] as const;

test('targets: checked messages win over the open one', () => {
  assert.deepEqual(commandTargets(new Set(['a', 'b']), 'c'), ['a', 'b']);
  assert.deepEqual(commandTargets(new Set(), 'c'), ['c']);
  assert.deepEqual(commandTargets(new Set(), null), []);
});

test('selection facts: unread / flagged / pinned', () => {
  const s = summarizeSelection(2, [
    { flags: ['\\Seen', '\\Flagged'], pinnedAt: '2026-01-01' },
    { flags: ['\\Flagged'], pinnedAt: null },
  ]);
  assert.deepEqual(s, { count: 2, anyUnread: true, allFlagged: true, allPinned: false });
  // a target that is not loaded never counts as flagged
  assert.equal(summarizeSelection(2, [{ flags: ['\\Flagged'] }]).allFlagged, false);
  assert.equal(summarizeSelection(0, []).allFlagged, false);
});

test('no selection: write commands disabled with a reason; new / undo / view stay enabled', () => {
  const s = mailCommandStates(ctx({}, 0));
  for (const id of WRITE) {
    assert.equal(s[id].enabled, false, id);
    assert.equal(s[id].tooltip, NO_SELECTION_HINT, id);
  }
  for (const id of ['new', 'undo', 'view'] as const) assert.equal(s[id].enabled, true, id);
});

test('single and multi selection in the own mailbox: everything enabled', () => {
  for (const count of [1, 5]) {
    const s = mailCommandStates(ctx({}, count));
    for (const id of MAIL_COMMAND_ORDER) assert.equal(s[id].enabled, true, `${id} (${count})`);
  }
});

test('read-only shared mailbox: every write command disabled with the read-only reason', () => {
  for (const count of [0, 1, 3]) {
    const s = mailCommandStates(ctx({ readOnly: true, foreign: true }, count));
    for (const id of WRITE) {
      assert.equal(s[id].enabled, false, id);
      assert.equal(s[id].tooltip, READ_ONLY_HINT, `${id}: the read-only reason wins over "no selection"`);
    }
    assert.equal(s.new.enabled, true, 'composing (from the own address) stays possible');
    assert.equal(s.view.enabled, true);
  }
});

test('writable shared mailbox: writes allowed, personal categories are own-only', () => {
  const s = mailCommandStates(ctx({ foreign: true }));
  for (const id of WRITE) assert.equal(s[id].enabled, true, id);
  assert.equal(s.categorize.enabled, false);
  assert.equal(s.categorize.tooltip, OWN_ONLY_HINT);
});

test('labels follow the selection state', () => {
  const unreadFlagged = mailCommandStates({ ...ctx(), selection: { count: 1, anyUnread: true, allFlagged: true, allPinned: true } });
  assert.equal(unreadFlagged.read.label, 'Gelesen');
  assert.equal(unreadFlagged.flag.label, 'Kennzeichnung aufheben');
  assert.equal(unreadFlagged.pin.label, 'Lösen');
  const readPlain = mailCommandStates(ctx());
  assert.equal(readPlain.read.label, 'Ungelesen');
  assert.equal(readPlain.flag.label, 'Kennzeichnen');
  assert.equal(readPlain.pin.label, 'Anheften');
  assert.equal(mailCommandStates(ctx({ isJunkFolder: true })).junk.label, 'Kein Junk');
  assert.equal(readPlain.junk.label, 'Junk');
});

test('read toggle: marks read while anything is unread, else unread', () => {
  assert.equal(readToggle(summarizeSelection(2, [{ flags: [] }, { flags: ['\\Seen'] }])), 'read');
  assert.equal(readToggle(summarizeSelection(1, [{ flags: ['\\Seen'] }])), 'unread');
  assert.equal(readToggle(summarizeSelection(0, [])), 'read');
});

test('categories: toggle for a multi-selection', () => {
  assert.equal(categoryCoverage([['a'], ['a', 'b']], 'a'), 'all');
  assert.equal(categoryCoverage([['a'], ['b']], 'a'), 'some');
  assert.equal(categoryCoverage([[], ['b']], 'a'), 'none');
  assert.deepEqual(nextCategoryIds(['a', 'b'], 'a', true), ['b'], 'all had it → removed');
  assert.deepEqual(nextCategoryIds(['b'], 'a', false), ['b', 'a'], 'added');
  assert.deepEqual(nextCategoryIds(['a'], 'a', false), ['a'], 'no duplicate');
});

test('reading pane "…" menu: own mailbox has every entry in the documented order', () => {
  const items = readerOverflowActions({ readOnly: false, foreign: false, isJunkFolder: false, isRead: true, isFlagged: false, isPinned: false });
  assert.deepEqual(items.map((i) => i.id), ['print', 'source', 'eml', 'rule', 'read', 'flag', 'pin', 'snooze', 'move', 'archive', 'junk', 'delete']);
  assert.ok(items.every((i) => i.enabled));
  assert.equal(items.find((i) => i.id === 'read')!.label, 'Als ungelesen markieren');
  assert.equal(items.find((i) => i.id === 'delete')!.danger, true);
});

test('reading pane "…" menu: read-only foreign mailbox', () => {
  const items = readerOverflowActions({ readOnly: true, foreign: true, isJunkFolder: true, isRead: false, isFlagged: true, isPinned: true });
  const ids = items.map((i) => i.id);
  assert.ok(!ids.includes('rule') && !ids.includes('snooze'), 'own-only entries left out');
  for (const id of ['print', 'source', 'eml']) assert.equal(items.find((i) => i.id === id)!.enabled, true, id);
  for (const id of ['read', 'flag', 'pin', 'move', 'archive', 'junk', 'delete']) {
    const it = items.find((i) => i.id === id)!;
    assert.equal(it.enabled, false, id);
    assert.equal(it.tooltip, READ_ONLY_HINT, id);
  }
  assert.equal(items.find((i) => i.id === 'junk')!.label, 'Kein Junk');
  assert.equal(items.find((i) => i.id === 'flag')!.label, 'Kennzeichnung aufheben');
});

test('command bar and reading-pane menu use one wording per action', () => {
  const bar = mailCommandStates(ctx({}, 1)); // one read, unflagged, unpinned message
  const menu = readerOverflowActions({ readOnly: false, foreign: false, isJunkFolder: false, isRead: true, isFlagged: false, isPinned: false });
  const label = (id: string) => menu.find((i) => i.id === id)!.label;
  assert.equal(label('archive'), bar.archive.label);
  assert.equal(label('delete'), bar.delete.label);
  assert.equal(label('flag'), bar.flag.label);
  assert.equal(label('pin'), bar.pin.label);
  assert.equal(label('junk'), bar.junk.tooltip);
  assert.equal(label('read'), bar.read.tooltip);
  const junkFolder = readerOverflowActions({ readOnly: false, foreign: false, isJunkFolder: true, isRead: true, isFlagged: true, isPinned: true });
  const barJunk = mailCommandStates(ctx({ isJunkFolder: true }, 1));
  assert.equal(junkFolder.find((i) => i.id === 'junk')!.label, barJunk.junk.label);
});
