import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_COMMAND_ORDER, READER_ICONS, READER_PRIMARY, SELECTION_BAR, SELECTION_BAR_MENUS, categoryCoverage, commandTargets,
  extraMailStates, mailCommandStates, newMenuItems, nextCategoryIds, readToggle, readerIconStates, readerOverflowActions,
  summarizeSelection, type ExtraMailContext, type MailCommandContext,
} from './mailCommands.ts';
import { OWN_ONLY_HINT, READ_ONLY_HINT } from './mailboxContext.ts';
import { translations, type TranslationKey } from '../i18n/translations.ts';

const t = (k: TranslationKey) => translations.de[k];
const NO_SELECTION_HINT = t('mail_hint_no_selection');

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
  const s = mailCommandStates(ctx({}, 0), t);
  for (const id of WRITE) {
    assert.equal(s[id].enabled, false, id);
    assert.equal(s[id].tooltip, NO_SELECTION_HINT, id);
  }
  for (const id of ['new', 'undo', 'view'] as const) assert.equal(s[id].enabled, true, id);
});

test('single and multi selection in the own mailbox: everything enabled', () => {
  for (const count of [1, 5]) {
    const s = mailCommandStates(ctx({}, count), t);
    for (const id of MAIL_COMMAND_ORDER) assert.equal(s[id].enabled, true, `${id} (${count})`);
  }
});

test('read-only shared mailbox: every write command disabled with the read-only reason', () => {
  for (const count of [0, 1, 3]) {
    const s = mailCommandStates(ctx({ readOnly: true, foreign: true }, count), t);
    for (const id of WRITE) {
      assert.equal(s[id].enabled, false, id);
      assert.equal(s[id].tooltip, READ_ONLY_HINT, `${id}: the read-only reason wins over "no selection"`);
    }
    assert.equal(s.new.enabled, true, 'composing (from the own address) stays possible');
    assert.equal(s.view.enabled, true);
  }
});

test('writable shared mailbox: writes allowed, personal categories are own-only', () => {
  const s = mailCommandStates(ctx({ foreign: true }), t);
  for (const id of WRITE) assert.equal(s[id].enabled, true, id);
  assert.equal(s.categorize.enabled, false);
  assert.equal(s.categorize.tooltip, OWN_ONLY_HINT);
});

test('labels follow the selection state', () => {
  const unreadFlagged = mailCommandStates({ ...ctx(), selection: { count: 1, anyUnread: true, allFlagged: true, allPinned: true } }, t);
  assert.equal(unreadFlagged.read.label, 'Gelesen');
  assert.equal(unreadFlagged.flag.label, 'Kennzeichnung aufheben');
  assert.equal(unreadFlagged.pin.label, 'Lösen');
  const readPlain = mailCommandStates(ctx(), t);
  assert.equal(readPlain.read.label, 'Ungelesen');
  assert.equal(readPlain.flag.label, 'Kennzeichnen');
  assert.equal(readPlain.pin.label, 'Anheften');
  assert.equal(mailCommandStates(ctx({ isJunkFolder: true }), t).junk.label, 'Kein Junk');
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

test('10.7 reading pane: Antworten / Allen antworten / Weiterleiten, icons, then the "…" menu in the documented order', () => {
  assert.deepEqual([...READER_PRIMARY], ['reply', 'replyAll', 'forward']);
  assert.deepEqual([...READER_ICONS], ['archive', 'move', 'categorize', 'flag', 'delete']);
  const items = readerOverflowActions({ readOnly: false, foreign: false, isJunkFolder: false, isRead: true, isFlagged: false, isPinned: false }, t);
  assert.deepEqual(items.map((i) => i.id), ['read', 'pin', 'snooze', 'junk', 'print', 'source', 'eml', 'rule', 'undo']);
  assert.ok(items.every((i) => i.enabled));
  assert.equal(items.find((i) => i.id === 'read')!.label, 'Als ungelesen markieren');
  assert.deepEqual(items.filter((i) => i.groupStart).map((i) => i.id), ['print', 'undo']);
});

test('reading pane "…" menu and icons: read-only foreign mailbox', () => {
  const rctx = { readOnly: true, foreign: true, isJunkFolder: true, isRead: false, isFlagged: true, isPinned: true };
  const items = readerOverflowActions(rctx, t);
  const ids = items.map((i) => i.id);
  assert.ok(!ids.includes('rule') && !ids.includes('snooze'), 'own-only entries left out');
  for (const id of ['print', 'source', 'eml', 'undo']) assert.equal(items.find((i) => i.id === id)!.enabled, true, id);
  for (const id of ['read', 'pin', 'junk']) {
    const it = items.find((i) => i.id === id)!;
    assert.equal(it.enabled, false, id);
    assert.equal(it.tooltip, READ_ONLY_HINT, id);
  }
  assert.equal(items.find((i) => i.id === 'junk')!.label, 'Kein Junk');
  const icons = readerIconStates(rctx, t);
  for (const id of ['archive', 'move', 'flag', 'delete'] as const) {
    assert.equal(icons[id].enabled, false, id);
    assert.equal(icons[id].tooltip, READ_ONLY_HINT, id);
  }
  assert.equal(icons.flag.label, 'Kennzeichnung aufheben');
  assert.equal(icons.categorize.tooltip, OWN_ONLY_HINT);
});

test('selection bar, reader icons and reader menu use one wording per action', () => {
  const bar = mailCommandStates(ctx({}, 1), t); // one read, unflagged, unpinned message
  const rctx = { readOnly: false, foreign: false, isJunkFolder: false, isRead: true, isFlagged: false, isPinned: false };
  const menu = readerOverflowActions(rctx, t);
  const icons = readerIconStates(rctx, t);
  const label = (id: string) => menu.find((i) => i.id === id)!.label;
  assert.equal(icons.archive.label, bar.archive.label);
  assert.equal(icons.delete.label, bar.delete.label);
  assert.equal(icons.flag.label, bar.flag.label);
  assert.equal(icons.move.label, bar.move.label);
  assert.equal(icons.categorize.label, bar.categorize.label);
  assert.equal(label('pin'), bar.pin.label);
  assert.equal(label('junk'), bar.junk.tooltip);
  assert.equal(label('read'), bar.read.tooltip);
  assert.equal(label('snooze'), bar.snooze.label);
  assert.equal(label('undo'), bar.undo.label);
  const junkFolder = readerOverflowActions({ ...rctx, isJunkFolder: true }, t);
  const barJunk = mailCommandStates(ctx({ isJunkFolder: true }, 1), t);
  assert.equal(junkFolder.find((i) => i.id === 'junk')!.label, barJunk.junk.label);
});

test('10.7 selection bar: every command in order, snooze is own-mailbox only', () => {
  assert.deepEqual([...SELECTION_BAR], ['delete', 'archive', 'move', 'junk', 'read', 'flag', 'categorize', 'pin', 'snooze', 'undo']);
  assert.deepEqual(SELECTION_BAR_MENUS.delete, ['deletePermanent']);
  for (const id of SELECTION_BAR) assert.ok((MAIL_COMMAND_ORDER as readonly string[]).includes(id), id);
  const foreign = mailCommandStates(ctx({ foreign: true }), t);
  assert.equal(foreign.snooze.enabled, false);
  assert.equal(foreign.snooze.tooltip, OWN_ONLY_HINT);
});

test('"Neue E-Mail" menu: E-Mail, E-Mail aus Vorlage (only with a template source), Ereignis', () => {
  assert.deepEqual(newMenuItems(true), ['mail', 'template', 'event']);
  assert.deepEqual(newMenuItems(false), ['mail', 'event']);
  // the own-mailbox mail is a fourth, last entry — only while a shared / delegated mailbox is open
  assert.deepEqual(newMenuItems(true, true), ['mail', 'template', 'event', 'ownMail']);
  assert.deepEqual(newMenuItems(true, false), ['mail', 'template', 'event']);
});

const extraCtx = (over: Partial<ExtraMailContext> = {}): ExtraMailContext => ({
  selection: { count: 1, anyUnread: false, allFlagged: false, allPinned: false },
  readOnly: false, foreign: false, isJunkFolder: false, hasFolder: true, folderUnread: 3, hasOpenMessage: true, ...over,
});

test('further commands: reply needs one message, print an open one, mark-all-read unread mail and write access', () => {
  const s = extraMailStates(extraCtx(), t);
  for (const id of ['reply', 'replyAll', 'forward', 'deletePermanent', 'markAllRead', 'print'] as const) assert.equal(s[id].enabled, true, id);
  assert.equal(s.markAllRead.label, 'Alle als gelesen markieren');
  const many = extraMailStates(extraCtx({ selection: { count: 3, anyUnread: true, allFlagged: false, allPinned: false } }), t);
  assert.equal(many.reply.enabled, false);
  assert.equal(many.reply.tooltip, 'Genau eine Nachricht auswählen');
  assert.equal(many.deletePermanent.enabled, true);
  const none = extraMailStates(extraCtx({ selection: { count: 0, anyUnread: false, allFlagged: false, allPinned: false }, hasOpenMessage: false, folderUnread: 0 }), t);
  assert.equal(none.deletePermanent.enabled, false);
  assert.equal(none.print.tooltip, 'Zuerst eine Nachricht öffnen');
  assert.equal(none.markAllRead.tooltip, 'Keine ungelesenen Nachrichten in diesem Ordner');
  const ro = extraMailStates(extraCtx({ readOnly: true }), t);
  assert.equal(ro.markAllRead.enabled, false);
  assert.equal(ro.deletePermanent.enabled, false);
  assert.equal(ro.reply.enabled, true, 'replying needs no write access to the shown mailbox');
  assert.equal(extraMailStates(extraCtx({ hasFolder: false }), t).markAllRead.enabled, false);
});

test('i18n: English texts with the English translate function, German hints match the shared constants', () => {
  const en = (k: TranslationKey) => translations.en[k];
  const s = mailCommandStates(ctx({}, 0), en);
  assert.equal(s.new.label, 'New mail');
  assert.equal(s.delete.tooltip, 'No message selected');
  assert.equal(mailCommandStates(ctx({ readOnly: true, foreign: true }), en).archive.tooltip, translations.en.mail_hint_read_only);
  const menu = readerOverflowActions({ readOnly: false, foreign: false, isJunkFolder: false, isRead: false, isFlagged: false, isPinned: false }, en);
  assert.deepEqual(menu.slice(4, 7).map((i) => i.label), ['Print', 'View source', 'Download as EML']);
  // Components outside the command bar still use the German constants — one wording
  assert.equal(translations.de.mail_hint_read_only, READ_ONLY_HINT);
  assert.equal(translations.de.mail_hint_own_only, OWN_ONLY_HINT);
  // Spanish / Italian fall back to the English texts of the new block
  assert.equal(translations.es.mail_cmd_new, translations.en.mail_cmd_new);
  assert.equal(translations.it.reader_print, translations.en.reader_print);
});
