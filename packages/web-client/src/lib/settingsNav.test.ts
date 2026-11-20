import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settingsNavClass, settingsNavIconSize } from './settingsNav.ts';
import { translations } from '../i18n/translations.ts';

test('a sub-entry is indented; active and inactive entries keep the same left border', () => {
  const top = settingsNavClass({ active: false });
  const sub = settingsNavClass({ active: false, indent: true });
  assert.match(top, /\bpx-4\b/);
  assert.match(sub, /\bpl-9\b/);
  assert.doesNotMatch(sub, /\bpx-4\b/);
  for (const active of [true, false]) for (const indent of [true, false]) assert.match(settingsNavClass({ active, indent }), /\bborder-l-2\b/);
  assert.match(settingsNavClass({ active: true, indent: true }), /\bborder-accent\b/);
  assert.ok(settingsNavIconSize(true) < settingsNavIconSize(false));
});

test('"Gelöschte Elemente" sits right below "Speicher" aligned like the other entries, with its own short label', () => {
  const src = readFileSync(new URL('../pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const storage = src.indexOf("{ id: 'storage',");
  const recover = src.indexOf("{ id: 'recover',");
  assert.ok(storage > 0 && recover > storage);
  const between = src.slice(storage, recover).split('\n').filter((l) => l.trim().startsWith('{ id:'));
  assert.equal(between.length, 1, 'nothing between Speicher and Gelöschte Elemente');
  const line = src.slice(recover, src.indexOf('\n', recover));
  assert.match(line, /label: 'settings_nav_recover'/);
  assert.doesNotMatch(line, /indent: true/);
  assert.deepEqual(
    [translations.de.settings_nav_recover, translations.en.settings_nav_recover, translations.es.settings_nav_recover, translations.it.settings_nav_recover],
    ['Gelöschte Elemente', 'Deleted items', 'Elementos eliminados', 'Elementi eliminati'],
  );
  assert.equal(translations.de.recover_title, 'Gelöschte Elemente wiederherstellen', 'section heading unchanged');
});
