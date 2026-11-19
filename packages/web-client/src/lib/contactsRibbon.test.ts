import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_MENU, RIBBON_COMMANDS, RIBBON_TABS, commandById, commandsOf, selectionFacts,
} from './contactsRibbon.ts';

const contact = selectionFacts({ kind: 'contact', hasRecipients: true, phone: '+49 30 123', categoriesAvailable: true });

test('tabs are Start / Ansicht / Hilfe and every group command exists once', () => {
  assert.deepEqual(RIBBON_TABS.map((t) => t.label), ['Start', 'Ansicht', 'Hilfe']);
  const ids = RIBBON_TABS.flatMap((t) => t.groups.flatMap((g) => g.commandIds));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), RIBBON_COMMANDS.map((c) => c.id).sort());
  for (const t of RIBBON_TABS) for (const g of t.groups) for (const c of commandsOf(g)) assert.equal(c.group, g.id);
});

test('start tab offers exactly the existing functions', () => {
  const start = RIBBON_TABS[0]!;
  assert.deepEqual(start.groups.flatMap((g) => commandsOf(g)).map((c) => c.action),
    ['newContact', 'edit', 'delete', 'mail', 'call', 'categorize']);
  assert.deepEqual(NEW_MENU.map((m) => m.action), ['newContact', 'newGroup']);
});

test('without selection only item-less commands are enabled', () => {
  const none = selectionFacts({ categoriesAvailable: true });
  for (const id of ['edit', 'delete', 'mail', 'call', 'categorize']) assert.equal(commandById(id).enabled(none).enabled, false, id);
  assert.equal(commandById('new').enabled(none).enabled, true);
});

test('a contact enables edit, delete, mail, call, categorize', () => {
  for (const id of ['edit', 'delete', 'mail', 'call', 'categorize']) assert.equal(commandById(id).enabled(contact).enabled, true, id);
});

test('call is disabled with a reason when there is no number', () => {
  const r = commandById('call').enabled({ ...contact, phone: null });
  assert.deepEqual(r, { enabled: false, reason: 'Keine Telefonnummer hinterlegt' });
});

test('mail needs an address; a list with members can be mailed, one without cannot', () => {
  assert.equal(commandById('mail').enabled({ ...contact, hasRecipients: false }).enabled, false);
  assert.equal(commandById('mail').enabled(selectionFacts({ kind: 'group', hasRecipients: true })).enabled, true);
  assert.equal(commandById('mail').enabled(selectionFacts({ kind: 'group' })).enabled, false);
});

test('lists can be edited and deleted but not categorised or called', () => {
  const group = selectionFacts({ kind: 'group', hasRecipients: true, categoriesAvailable: true });
  assert.equal(commandById('edit').enabled(group).enabled, true);
  assert.equal(commandById('delete').enabled(group).enabled, true);
  assert.equal(commandById('categorize').enabled(group).enabled, false);
  assert.equal(commandById('call').enabled(group).enabled, false);
});

test('global address book entries are read-only but can be mailed', () => {
  const dir = selectionFacts({ kind: 'directory', hasRecipients: true, categoriesAvailable: true });
  assert.equal(commandById('mail').enabled(dir).enabled, true);
  for (const id of ['edit', 'delete', 'categorize', 'call']) assert.equal(commandById(id).enabled(dir).enabled, false, id);
});

test('an open editor pauses the item commands', () => {
  const editing = { ...contact, editing: true };
  for (const id of ['edit', 'delete', 'mail', 'call', 'categorize']) assert.equal(commandById(id).enabled(editing).enabled, false, id);
});

test('categorize is disabled when the category module is off', () => {
  const r = commandById('categorize').enabled({ ...contact, categoriesAvailable: false });
  assert.equal(r.enabled, false);
});

test('unknown command id throws', () => {
  assert.throws(() => commandById('nope'));
});
