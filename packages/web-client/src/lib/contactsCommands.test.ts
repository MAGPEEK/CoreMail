import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONTACT_COMMANDS, NEW_MENU, commandById, commandsIn, selectionFacts } from './contactsCommands.ts';

const contact = selectionFacts({ kind: 'contact', hasRecipients: true, phone: '+49 30 123', categoriesAvailable: true });

test('each card shows its commands: "Neu" in the folder card, sort in the list header, the action row in the details', () => {
  assert.deepEqual(commandsIn('sidebar').map((c) => c.action), ['newContact']);
  assert.deepEqual(NEW_MENU.map((m) => m.action), ['newContact', 'newGroup']);
  assert.deepEqual(commandsIn('list').map((c) => c.action), ['sortGiven', 'sortFamily']);
  assert.deepEqual(commandsIn('detail').map((c) => c.label), ['Bearbeiten', 'E-Mail', 'Anrufen', 'Kategorisieren', 'Löschen']);
  const ids = CONTACT_COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
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
  assert.equal(commandById('categorize').enabled({ ...contact, categoriesAvailable: false }).enabled, false);
});

test('unknown command id throws; the contacts ribbon is gone', () => {
  assert.throws(() => commandById('nope'));
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(existsSync(join(src, 'lib/contactsRibbon.ts')), false);
  assert.equal(existsSync(join(src, 'components/contacts/ContactsRibbon.tsx')), false);
});
