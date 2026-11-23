/**
 * 10.7 hard rule of the three-column redesign: no user-facing function may
 * disappear. Every command of the removed ribbons (mail Start / Ansicht / Hilfe,
 * the narrow mail command bar, the compose ribbon tabs, calendar, contacts) and
 * of the removed top bar must be reachable from a command group of the new layout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMMAND_GROUPS, LEGACY_COMMANDS, RETIRED_CHROME, missingPlacements, type Place } from './commandPlacement.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('every former ribbon / top-bar command has a place in the new layout', () => {
  assert.deepEqual(missingPlacements(), []);
  for (const c of LEGACY_COMMANDS) assert.ok(c.places.length > 0, `${c.source} ${c.id}`);
});

test('the inventory covers every removed surface', () => {
  const sources = new Set(LEGACY_COMMANDS.map((c) => c.source));
  for (const s of [
    'MailRibbon: Start', 'MailRibbon: Ansicht', 'MailRibbon: Hilfe', 'MailCommandBar (narrow)',
    'composeRibbonTabs: Nachricht', 'composeRibbonTabs: Einfügen', 'composeRibbonTabs: Text formatieren', 'composeRibbonTabs: Optionen',
    'calendarRibbon', 'contactsRibbon', 'TopBar',
  ]) assert.ok(sources.has(s), s);
  const ids = (source: string) => LEGACY_COMMANDS.filter((c) => c.source === source).map((c) => c.id);
  // spot checks of the snapshot (10.6 ribbons)
  assert.deepEqual(ids('MailRibbon: Hilfe'), ['shortcuts', 'about']);
  assert.deepEqual(ids('MailRibbon: Ansicht'), ['view-settings', 'conversations', 'sort', 'reading-pane', 'density', 'sync']);
  for (const id of ['new', 'delete', 'archive', 'move', 'junk', 'flag', 'read', 'categorize', 'pin', 'undo', 'view']) {
    assert.ok(ids('MailCommandBar (narrow)').includes(id), `narrow ${id}`);
  }
  for (const id of ['importance', 'receipt', 'options', 'show-from', 'check-names', 'a11y', 'format']) {
    assert.ok(ids('composeRibbonTabs: Optionen').includes(id), `compose options ${id}`);
  }
  assert.deepEqual(ids('calendarRibbon').sort(), ['about', 'agenda', 'calendar-settings', 'filter', 'new', 'print', 'share', 'shortcuts',
    'time-scale', 'today', 'view-dayGridMonth', 'view-timeGridDay', 'view-timeGridWeek', 'view-workWeek']);
  assert.deepEqual(ids('contactsRibbon').sort(), ['about', 'call', 'categorize', 'delete', 'edit', 'mail', 'new', 'new:contact', 'new:group',
    'shortcuts', 'sort-family', 'sort-given']);
});

test('only ribbon chrome is retired (collapse, tab row) — no command', () => {
  assert.deepEqual(RETIRED_CHROME.map((r) => r.id), ['collapse', 'tabs']);
});

test('every new place has commands', () => {
  for (const [place, ids] of Object.entries(COMMAND_GROUPS) as [Place, readonly string[]][]) {
    assert.ok(ids.length > 0, place);
  }
});

test('the components render from the same command lists', () => {
  const uses = (file: string, ...names: string[]) => {
    const s = read(file);
    for (const n of names) assert.match(s, new RegExp(`\\b${n}\\b`), `${file} uses ${n}`);
  };
  uses('components/MailCommands.tsx', 'SELECTION_BAR', 'newMenuItems');
  uses('components/MessageReader.tsx', 'READER_PRIMARY', 'READER_ICONS', 'readerOverflowActions');
  uses('components/MessageList.tsx', 'VIEW_MENU', 'SearchOperatorsHelp', 'SelectionBar');
  uses('components/AppRail.tsx', 'RAIL_BOTTOM');
  uses('components/ProfileMenu.tsx', 'profileMenuItems');
  uses('components/CalendarToolbar.tsx', 'resolveToolbar');
  uses('components/CalendarSidebar.tsx', 'onNewEvent');
  uses('components/contacts/ContactsCommands.tsx', 'commandsIn', 'NEW_MENU');
  uses('components/compose/ComposeCommandRow.tsx', 'SEND_MENU', 'moreMenuCommands', 'headerCommands');
});

test('the ribbons and the top bar are gone', () => {
  for (const gone of [
    'components/Ribbon.tsx', 'components/MailRibbon.tsx', 'components/TopBar.tsx', 'components/contacts/ContactsRibbon.tsx',
    'components/compose/composeRibbonTabs.tsx', 'store/composeRibbon.ts', 'lib/ribbon.ts', 'lib/calendarRibbon.ts', 'lib/contactsRibbon.ts',
  ]) assert.equal(existsSync(join(src, gone)), false, `${gone} is gone`);
  assert.doesNotMatch(read('App.tsx'), /TopBar/);
});
