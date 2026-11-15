import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKey, isEditableTarget, createShortcutMatcher, keysFor, ariaKeyShortcuts,
  displayKeys, SHORTCUT_SETS, ACTION_GROUP, type KeyLike, type MatchResult,
} from './shortcuts.ts';

const action = (r: MatchResult) => (r && r.kind === 'action' ? r.action : r?.kind ?? null);
const input = { tagName: 'INPUT', type: 'text' };
const div = { tagName: 'DIV', isContentEditable: false, closest: () => null };

test('normalizeKey: letters, shift, ctrl/meta, symbols, named keys', () => {
  assert.equal(normalizeKey({ key: 'r' }), 'r');
  assert.equal(normalizeKey({ key: 'I', shiftKey: true }), 'shift+i');
  assert.equal(normalizeKey({ key: 'R', ctrlKey: true, shiftKey: true }), 'ctrl+shift+r');
  assert.equal(normalizeKey({ key: 'n', metaKey: true }), 'ctrl+n');
  // symbols are matched by the produced character, shift ignored
  assert.equal(normalizeKey({ key: '#', shiftKey: true }), '#');
  assert.equal(normalizeKey({ key: '?', shiftKey: true }), '?');
  assert.equal(normalizeKey({ key: 'Delete', shiftKey: true }), 'shift+delete');
  assert.equal(normalizeKey({ key: 'Enter', ctrlKey: true }), 'ctrl+enter');
  assert.equal(normalizeKey({ key: 'Shift', shiftKey: true }), null);
  assert.equal(normalizeKey({ key: 'Control', ctrlKey: true }), null);
});

test('isEditableTarget: inputs, textareas, selects, contenteditable; not checkboxes/buttons', () => {
  assert.equal(isEditableTarget(input), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'P', closest: (s: string) => (s.includes('contenteditable') ? {} : null) }), true);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget(div), false);
  assert.equal(isEditableTarget(null), false);
});

test('matcher ignores keys typed into inputs and editors — except Ctrl+Enter', () => {
  const m = createShortcutMatcher();
  const o = { set: 'coremail' as const, context: 'mail' as const };
  for (const target of [input, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(m.match({ key: 'r', target }, o), null);
    assert.equal(m.match({ key: '#', target }, o), null);
    assert.equal(m.match({ key: 'Delete', target }, o), null);
    assert.equal(m.match({ key: 'g', target }, o), null, 'no sequence starts while typing');
    assert.equal(action(m.match({ key: 'Enter', ctrlKey: true, target }, o)), 'compose.send');
  }
  assert.equal(action(m.match({ key: 'r', target: div }, o)), 'mail.reply');
  assert.equal(m.match({ key: 'x', isComposing: true, target: div }, o), null, 'IME composition');
});

test('g-sequences: g then key within the timeout; timeout and unknown second keys cancel', () => {
  let t = 1000;
  const m = createShortcutMatcher({ timeoutMs: 1500, now: () => t });
  const o = { set: 'gmail' as const, context: 'mail' as const };
  const press = (key: string, extra: Partial<KeyLike> = {}) => m.match({ key, target: div, ...extra }, o);

  assert.deepEqual(press('g'), { kind: 'pending', prefix: 'g' });
  assert.equal(m.pendingPrefix, 'g');
  t += 500;
  assert.equal(action(press('i')), 'go.inbox');
  assert.equal(m.pendingPrefix, null);

  for (const [k, a] of [['s', 'go.flagged'], ['t', 'go.sent'], ['d', 'go.drafts'], ['a', 'go.all'], ['c', 'go.contacts']] as const) {
    press('g');
    assert.equal(action(press(k)), a);
  }

  // timeout: "i" alone afterwards is not go.inbox (and i has no single binding)
  press('g');
  t += 2000;
  assert.equal(m.pendingPrefix, null);
  assert.equal(press('i'), null);

  // an unknown second key cancels the sequence and is swallowed
  press('g');
  assert.equal(press('q'), null);
  assert.equal(action(press('r')), 'mail.reply', 'next key is matched normally again');

  // typing into an input aborts a pending sequence
  press('g');
  assert.equal(m.match({ key: 'i', target: input }, o), null);
  assert.equal(press('i'), null);
});

test('sets: Gmail keys in both; Outlook extras only in the CoreMail default', () => {
  const gm = createShortcutMatcher();
  const cm = createShortcutMatcher();
  const mail = (set: 'gmail' | 'coremail') => ({ set, context: 'mail' as const });
  const ev = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, target: div, ...extra });

  for (const [k, a] of [['c', 'compose.new'], ['e', 'mail.archive'], ['#', 'mail.delete'], ['!', 'mail.spam'],
    ['s', 'mail.flag'], ['v', 'mail.move'], ['z', 'undo'], ['j', 'mail.next'], ['k', 'mail.prev'],
    ['o', 'mail.open'], ['u', 'mail.back'], ['x', 'mail.select'], ['n', 'mail.nextInConversation'],
    ['p', 'mail.prevInConversation'], ['/', 'search'], ['?', 'help'], ['Delete', 'mail.delete']] as const) {
    assert.equal(action(gm.match(ev(k), mail('gmail'))), a, `gmail ${k}`);
    assert.equal(action(cm.match(ev(k), mail('coremail'))), a, `coremail ${k}`);
  }
  assert.equal(action(gm.match(ev('I', { shiftKey: true }), mail('gmail'))), 'mail.markRead');
  assert.equal(action(gm.match(ev('U', { shiftKey: true }), mail('gmail'))), 'mail.markUnread');
  assert.equal(action(gm.match(ev('Delete', { shiftKey: true }), mail('gmail'))), 'mail.deletePermanent');

  assert.equal(action(cm.match(ev('n', { ctrlKey: true }), mail('coremail'))), 'compose.new');
  assert.equal(action(cm.match(ev('r', { ctrlKey: true }), mail('coremail'))), 'mail.reply');
  assert.equal(action(cm.match(ev('R', { ctrlKey: true, shiftKey: true }), mail('coremail'))), 'mail.replyAll');
  assert.equal(action(cm.match(ev('f', { ctrlKey: true }), mail('coremail'))), 'mail.forward');
  assert.equal(gm.match(ev('r', { ctrlKey: true }), mail('gmail')), null, 'Ctrl+R stays browser reload in the Gmail set');
  // Ctrl+R / Ctrl+F only hijacked inside mail
  assert.equal(cm.match(ev('r', { ctrlKey: true }), { set: 'coremail', context: 'other' }), null);
});

test('contexts: calendar keys win in the calendar, mail keys are inactive elsewhere', () => {
  const m = createShortcutMatcher();
  const cal = { set: 'coremail' as const, context: 'calendar' as const };
  const ev = (key: string): KeyLike => ({ key, target: div });
  assert.equal(action(m.match(ev('c'), cal)), 'calendar.new');
  assert.equal(action(m.match(ev('t'), cal)), 'calendar.today');
  assert.equal(action(m.match(ev('d'), cal)), 'calendar.day');
  assert.equal(action(m.match(ev('w'), cal)), 'calendar.week');
  assert.equal(action(m.match(ev('m'), cal)), 'calendar.month');
  assert.equal(m.match(ev('r'), cal), null);
  assert.equal(action(m.match(ev('z'), cal)), 'undo');
  assert.equal(action(m.match(ev('c'), { set: 'coremail', context: 'other' })), 'compose.new');
});

test('Enter on a focused button keeps its native meaning', () => {
  const m = createShortcutMatcher();
  const o = { set: 'gmail' as const, context: 'mail' as const };
  assert.equal(m.match({ key: 'Enter', target: { tagName: 'BUTTON' } }, o), null);
  assert.equal(m.match({ key: 'Enter', target: { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'button' : null) } }, o), null);
  assert.equal(action(m.match({ key: 'Enter', target: div }, o)), 'mail.open');
});

test('help/aria helpers', () => {
  assert.deepEqual(keysFor('coremail', 'mail.reply'), ['r', 'ctrl+r']);
  assert.equal(ariaKeyShortcuts('coremail', 'mail.replyAll'), 'A Control+Shift+R');
  assert.equal(ariaKeyShortcuts('gmail', 'go.inbox'), undefined, 'sequences are not expressible');
  assert.deepEqual(displayKeys('g i'), [['G'], ['I']]);
  assert.deepEqual(displayKeys('ctrl+shift+r'), [['Ctrl', 'Shift', 'R']]);
  assert.deepEqual(displayKeys('ctrl+enter', true), [['⌘', 'Enter']]);
  // every bound action has a help group; no duplicate key in the same context
  for (const set of ['gmail', 'coremail'] as const) {
    const seen = new Set<string>();
    for (const b of SHORTCUT_SETS[set]) {
      assert.ok(ACTION_GROUP[b.action], b.action);
      const k = `${b.keys}|${(b.contexts ?? ['*']).join(',')}`;
      assert.ok(!seen.has(k), `duplicate ${k} in ${set}`);
      seen.add(k);
    }
  }
});
