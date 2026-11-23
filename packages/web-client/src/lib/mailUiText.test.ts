import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { translations, type TranslationKey } from '../i18n/translations.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

/** String literals and JSX text of a source file (comments stripped). */
function visibleTexts(code: string): string[] {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const literals = [...noComments.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  const jsxText = [...noComments.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!.trim()).filter(Boolean);
  return [...literals, ...jsxText];
}

/** German UI words and umlauts — a hard-coded German label or tooltip in a component. */
const GERMAN = /[äöüÄÖÜß]|\b(Antworten|Weiterleiten|Löschen|Archivieren|Verschieben|Kennzeichnen|Gelesen|Ungelesen|Ansicht|Rückgängig|Weitere|Optionen|ausgewählt|Auswahl|Lesebereich|Dichte|Kalender|Kontakte|Aufgaben|Notizen|Einstellungen|Drucken|Quelltext|Schlummern|Stunde|Morgen|Kein Spam|Als Junk|Nachrichtenaktionen|Befehle|Kategori\w*|Neue E-Mail|Postfach)\b/;

for (const file of [
  'components/AppRail.tsx', 'components/CommandBar.tsx', 'components/MailCommands.tsx', 'components/ProfileMenu.tsx',
  'components/NotificationsPanel.tsx', 'components/SplitButton.tsx', 'lib/mailCommands.ts', 'lib/appRail.ts', 'lib/shellMenus.ts',
  'lib/mailList.ts', 'lib/notifications.ts',
]) {
  test(`i18n: no hard-coded German label or tooltip in ${file}`, () => {
    const hits = visibleTexts(read(file)).filter((s) => GERMAN.test(s));
    assert.deepEqual(hits, []);
  });
}

test('i18n: reading-pane action bar texts come from the translation table', () => {
  const reader = read('components/MessageReader.tsx');
  for (const german of ['Nachrichtenaktionen', 'In 1 Stunde', 'In 3 Stunden', 'Nächsten Montag', "label: 'Antworten'", '/> Kein Spam', '/> Als Junk', 'Bayes-Lernen']) {
    assert.ok(!reader.includes(german), `hard-coded: ${german}`);
  }
  assert.match(reader, /t\('reader_actions_label'\)/);
});

/** 10.7: keys of the three-column shell — translated into all four languages. */
const SHELL_KEYS = new Set<string>([
  'rail_settings', 'rail_profile', 'rail_brand', 'mail_region_folders', 'mail_region_list', 'mail_region_content',
]);

test('i18n: every key of the mail block has a German and an English text; Spanish/Italian fall back to English', () => {
  const keys = Object.keys(translations.de).filter((k) => /^(rail|cmdbar|mail|reader)_/.test(k) && !SHELL_KEYS.has(k)) as TranslationKey[];
  assert.ok(keys.length > 50);
  for (const k of keys) {
    assert.ok(translations.de[k].length > 0 && translations.en[k].length > 0, k);
    assert.equal(translations.es[k], translations.en[k], k);
    assert.equal(translations.it[k], translations.en[k], k);
  }
  assert.equal(translations.en.cmdbar_more, 'More commands');
});

test('i18n 10.7: every new shell string exists in German, English, Spanish and Italian', () => {
  const shell = Object.keys(translations.de).filter((k) => SHELL_KEYS.has(k)
    || /^(notifications|profile|list|folder_more|cal_new_event|cal_toolbar|contacts_(new|sort|detail))/.test(k)) as TranslationKey[];
  assert.ok(shell.length >= 40, `${shell.length} keys`);
  for (const k of shell) {
    for (const lang of ['de', 'en', 'es', 'it'] as const) assert.ok(translations[lang][k]?.length > 0, `${lang} ${k}`);
    assert.notEqual(translations.es[k], undefined, k);
  }
  assert.equal(translations.es.notifications_empty, 'No hay notificaciones nuevas');
  assert.equal(translations.it.profile_sign_out, 'Esci');
});

test('search: one operator help — in the search row of the list card (the top bar is gone)', () => {
  const list = read('components/MessageList.tsx');
  assert.match(list, /<SearchOperatorsHelp\b/);
  assert.match(list, /<SearchSuggestList\b/);
  assert.match(list, /<SearchChips\b/);
  assert.match(list, /aria-keyshortcuts="\/"/);
  assert.match(list, /searchParams\.get\('q'\)/, '/mail?q= still runs a mailbox-wide search');
});
