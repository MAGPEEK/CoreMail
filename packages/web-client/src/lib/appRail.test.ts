import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RAIL_ITEMS, activeAppForPath } from './appRail.ts';
import { RAIL_BOTTOM, latestReleasedVersion, profileMenuItems } from './shellMenus.ts';
import { translations } from '../i18n/translations.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('rail: five apps, no settings app entry (settings = the gear at the rail bottom), unique ids and paths', () => {
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
  assert.equal(activeAppForPath('/settings'), null, 'not an app: no app entry is current');
  assert.equal(activeAppForPath('/shared-mailbox/abc'), 'mail', 'old shared-mailbox links redirect to mail');
  assert.equal(activeAppForPath('/'), 'mail');
  assert.equal(activeAppForPath('/mailbox'), 'mail', 'prefix of /mail is not a match, falls back');
});

test('10.7 layout: no top bar — the rail holds brand, apps and at its bottom bell, gear and avatar; bottom bar below md', () => {
  const app = read('App.tsx');
  assert.match(app, /<AppRail\b/);
  assert.doesNotMatch(app, /TopBar|<header\b/, 'the top bar is gone');
  const rail = read('components/AppRail.tsx');
  assert.match(rail, /aria-current/);
  assert.match(rail, /md:flex-col/, 'vertical from md (768 px) up');
  assert.match(rail, /<nav\b[\s\S]*aria-label=\{t\('rail_nav_label'\)\}/, 'the rail is a labelled nav landmark');
  assert.match(rail, /<BrandLogo\b/, 'brand logo mark at the top');
  assert.match(rail, /to="\/settings"/, 'settings: the gear at the bottom of the rail');
  assert.match(rail, /<NotificationsPanel\b/, 'the bell opens the notifications panel');
  assert.match(rail, /<ProfileMenu\b/);
  assert.deepEqual([...RAIL_BOTTOM], ['notifications', 'settings', 'profile']);
  assert.match(read('components/MessageList.tsx'), /id=\{GLOBAL_SEARCH_INPUT_ID\}/, '`/` focuses the search of the list card');
});

test('10.7 profile menu: identity, other mailbox, shortcuts, about, sign out; bell + gear join it on the bottom bar', () => {
  assert.deepEqual(profileMenuItems(false), ['openMailbox', 'shortcuts', 'about', 'signOut']);
  assert.deepEqual(profileMenuItems(true), ['notifications', 'settings', 'openMailbox', 'shortcuts', 'about', 'signOut']);
  const menu = read('components/ProfileMenu.tsx');
  assert.match(menu, /logoutWithDraftFlush/, 'sign out saves open drafts first');
  assert.match(menu, /setShortcutHelpOpen\(true\)/);
  assert.match(menu, /<OpenSharedMailboxModal\b/);
  assert.equal(latestReleasedVersion([{ version: 'Unreleased' }, { version: '10.1.0' }, { version: '10.0.0' }]), '10.1.0');
  assert.equal(latestReleasedVersion([{ version: 'Unreleased' }]), null);
  assert.equal(latestReleasedVersion(undefined), null);
});
