import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RAIL_ITEMS, activeAppForPath } from './appRail.ts';
import { translations } from '../i18n/translations.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('rail: five apps, no settings entry (settings = header gear), unique ids and paths', () => {
  assert.deepEqual(RAIL_ITEMS.map((i) => translations.de[i.labelKey]), ['Mail', 'Kalender', 'Kontakte', 'Aufgaben', 'Notizen']);
  assert.deepEqual(RAIL_ITEMS.map((i) => translations.en[i.labelKey]), ['Mail', 'Calendar', 'Contacts', 'Tasks', 'Notes']);
  assert.ok(!RAIL_ITEMS.some((i) => i.path === '/settings'), 'settings are not on the rail');
  assert.equal(new Set(RAIL_ITEMS.map((i) => i.id)).size, RAIL_ITEMS.length);
  assert.equal(new Set(RAIL_ITEMS.map((i) => i.path)).size, RAIL_ITEMS.length);
});

test('rail: active app (aria-current) from the route path', () => {
  assert.equal(activeAppForPath('/mail'), 'mail');
  assert.equal(activeAppForPath('/calendar'), 'calendar');
  assert.equal(activeAppForPath('/contacts/'), 'contacts');
  assert.equal(activeAppForPath('/tasks'), 'tasks');
  assert.equal(activeAppForPath('/notes'), 'notes');
  assert.equal(activeAppForPath('/settings'), null, 'header page: no rail entry is current');
  assert.equal(activeAppForPath('/shared-mailbox/abc'), 'mail', 'old shared-mailbox links redirect to mail');
  assert.equal(activeAppForPath('/'), 'mail');
  assert.equal(activeAppForPath('/mailbox'), 'mail', 'prefix of /mail is not a match, falls back');
});

test('layout: the rail replaces the top-bar app tabs; bottom bar below md', () => {
  const app = read('App.tsx');
  assert.match(app, /<AppRail\b/);
  const topBar = read('components/TopBar.tsx');
  assert.doesNotMatch(topBar, /Kalender|Kontakte|Aufgaben|Notizen/, 'no horizontal text tabs in the header');
  assert.match(topBar, /bg-header/);
  assert.match(topBar, /GLOBAL_SEARCH_INPUT_ID/, '`/` focuses the header search');
  const rail = read('components/AppRail.tsx');
  assert.match(rail, /aria-current/);
  assert.match(rail, /md:flex-col/, 'vertical from md (768 px) up');
  assert.doesNotMatch(rail, /Settings|Einstellungen/, 'no settings entry on the rail');
  assert.match(topBar, /navigate\('\/settings'\)/, 'settings stay reachable through the header gear');
});
