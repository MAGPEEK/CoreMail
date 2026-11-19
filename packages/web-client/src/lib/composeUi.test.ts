/**
 * 9.4 compose: source checks of the inline compose (the logic is tested in the
 * lib/compose*.test.ts files) — the floating window is gone, the pieces are
 * wired up as documented in docs/compose.md, texts come from the translation
 * table, components are never defined inside components, ARIA is in place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { translations, type TranslationKey } from '../i18n/translations.ts';
import { COMPOSE_AREA_KEYS, SHORTCUT_SETS, displayKeys } from './shortcuts.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');
const composeFiles = readdirSync(join(src, 'components/compose')).filter((f) => f.endsWith('.tsx')).map((f) => `components/compose/${f}`);
const allComposeSources = [...composeFiles, 'pages/ComposePopoutPage.tsx'];

function visibleTexts(code: string): string[] {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const literals = [...noComments.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  const jsxText = [...noComments.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!.trim()).filter(Boolean);
  return [...literals, ...jsxText];
}

test('the floating compose window is gone; compose lives in the mail view', () => {
  assert.equal(existsSync(join(src, 'components/ComposeWindow.tsx')), false);
  const app = read('App.tsx');
  assert.doesNotMatch(app, /ComposeWindow|composeOpen/);
  assert.match(app, /<Route path=\{POPOUT_ROUTE\} element=\{<AuthGuard><ComposePopoutPage \/><\/AuthGuard>\} \/>/);
  assert.match(app, /useComposeRouting\(\);/);
  assert.match(app, /usePopoutBridge\(\);/);
  const page = read('pages/MailPage.tsx');
  assert.match(page, /<ComposePane key=\{composeKey\} tabKey=\{composeKey\} variant="inline" \/>/);
  assert.match(page, /const readerPanel = composePanel \?\?/, 'the shown draft takes the reading pane');
  for (const f of allComposeSources) assert.doesNotMatch(read(f), /fixed bottom-0 right-4/, f);
  for (const f of ['store/ui.ts', 'components/DelayedSendToast.tsx', 'hooks/useGlobalShortcuts.ts']) {
    assert.doesNotMatch(read(f), /composeOpen|composeCtx|send_compose_busy/, f);
  }
});

test('no component is defined inside another component (module level only)', () => {
  for (const f of [...allComposeSources, 'components/ContextMenu.tsx', 'components/ShortcutHelpDialog.tsx']) {
    const code = read(f);
    const nested = [...code.matchAll(/^[ \t]+(?:function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*\s*=\s*(?:\([^)]*\)|\w+)\s*=>)/gm)].map((m) => m[0].trim());
    assert.deepEqual(nested, [], f);
  }
});

test('i18n: no hard-coded German label or tooltip in the compose components', () => {
  const GERMAN = /[äöüÄÖÜß]|\b(Senden|Verwerfen|Anhängen|Betreff|Schließen|Entwurf|Einfügen|Format|Nachricht|Empfänger|Signatur|Emoji einfügen|Fett|Kursiv|Planen)\b/;
  for (const f of allComposeSources) {
    const hits = visibleTexts(read(f)).filter((s) => GERMAN.test(s));
    assert.deepEqual(hits, [], f);
  }
});

test('i18n: compose texts in German and English; Spanish/Italian fall back to English', () => {
  const keys = Object.keys(translations.de).filter((k) => /^compose_/.test(k)) as TranslationKey[];
  assert.ok(keys.length > 100);
  for (const k of keys) {
    assert.ok(translations.de[k].length > 0 && translations.en[k].length > 0, k);
    assert.equal(translations.es[k], translations.en[k], k);
    assert.equal(translations.it[k], translations.en[k], k);
  }
  for (const f of allComposeSources) {
    for (const m of read(f).matchAll(/t\('((?:compose|draft|sc|cancel)[\w]*)'\)/g)) {
      assert.ok(m[1]! in translations.de, `${f}: unknown key ${m[1]}`);
    }
  }
  assert.equal(translations.de.draft_saved_at, 'Entwurf gespeichert {time}');
});

test('card layout: header row on top, fields, body, the formatting bar at the bottom; no ribbon tabs, no action bar', () => {
  assert.equal(existsSync(join(src, 'components/compose/ComposeRibbon.tsx')), false, 'the ribbon is gone');
  assert.equal(existsSync(join(src, 'components/compose/ComposeActionBar.tsx')), false, 'the bottom action bar is gone');
  const pane = read('components/compose/ComposePane.tsx');
  const order = ['<ComposeCommandRow', '<ComposeFields', '<EditorContent', '<ComposeFormatBar'].map((s) => pane.indexOf(s));
  assert.ok(order.every((i) => i > 0), 'all bars are rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'header → fields → body → formatting');
  assert.doesNotMatch(pane, /ComposeActionBar/);
  assert.match(pane, /\{formatBarShown && \(\s*<ComposeFormatBar/, 'no formatting toolbar in plain text or when switched off');
  assert.match(pane, /formatBarVisible\(plainText, composePrefs\.composeFormatBar\)/, 'the roaming preference decides');
  assert.match(pane, /md:rounded-xl md:border md:border-line md:shadow-md/, 'a raised card inline from 768 px');
  assert.match(pane, /bg-canvas md:p-3/, 'the pane around the card is tinted, 12 px margin');
  assert.match(pane, /window: 'relative flex flex-col flex-1 min-w-0 min-h-0 bg-surface'/, 'the own window has no margin or shadow');
  assert.match(pane, /editor\?\.isEmpty && \(/, 'body placeholder while the body is empty');
  for (const f of ['ComposeCommandRow', 'ComposeFormatBar']) {
    const code = read(`components/compose/${f}.tsx`);
    assert.match(code, /<CommandBar\b/, `${f} uses the shared command bar (roving focus, overflow)`);
    assert.doesNotMatch(code, /role="tab(list|panel)?"/, f);
  }
  assert.match(read('components/compose/ComposeFields.tsx'), /placeholder=\{t\('compose_subject_placeholder'\)\}/);
  const header = read('components/compose/ComposeCommandRow.tsx');
  assert.match(header, /tone: 'primary'/, 'Senden is the accent-filled control');
  assert.equal((header.match(/tone: 'primary'/g) ?? []).length, 1, 'and the only one');
  assert.match(header, /Alt\+ArrowDown/, 'the keyboard shortcut of the Senden menu is announced');
  assert.match(read('components/CommandBar.tsx'), /e\.altKey && e\.key === 'ArrowDown'/, 'Alt+↓ opens a split button menu');
  assert.match(read('hooks/useComposeEditor.ts'), /max-w-\[72ch\] text-\[15px\] leading-\[1\.6\]/, 'the editor line length and type size');
  assert.match(read('hooks/useComposeEditor.ts'), /'aria-placeholder': o\.placeholder/);
  for (const f of ['MessageOptionsDialog', 'AccessibilityDialog']) assert.match(read(`components/compose/${f}.tsx`), /<Modal\b/, `${f} is an accessible modal`);
  assert.match(read('components/MessageReader.tsx'), /<SensitivityBadge value=\{msg\.sensitivity\} \/>/);
});

test('ARIA: recipient combobox + pills, live status, labelled region, drafts strip', () => {
  const field = read('components/compose/RecipientField.tsx');
  assert.match(field, /role="combobox"/);
  assert.match(field, /aria-controls=\{listId\}/);
  assert.match(field, /'aria-activedescendant': optionId\(activeIdx\)/);
  assert.match(field, /role="listbox"/);
  assert.match(field, /role="option"/);
  assert.match(field, /aria-expanded=\{expanded\}/, 'pill shows the full address on click');
  assert.match(field, /aria-label=\{fmt\(t\('compose_remove_recipient'\)/);
  assert.match(field, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\)/, 'Escape closes the suggestions, not the compose');
  assert.match(field, /\{problem && <span className="sr-only">/, 'invalid / unresolved recipients are announced');
  const pane = read('components/compose/ComposePane.tsx');
  assert.match(pane, /<section\s+aria-label=\{fmt\(t\('compose_region'\)/);
  assert.match(pane, /data-shortcut-scope="compose"/);
  assert.match(pane, /role="status" aria-live="polite"/);
  assert.match(pane, /if \(isModalOpen\(\)\) return;/, 'keys of the link dialog never send or close');
  assert.match(pane, /e\.key === 'Escape' && !e\.defaultPrevented && !popover/);
  assert.match(pane, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/);
  assert.match(pane, /max-md:fixed max-md:inset-0/, 'full screen below 768 px');
  assert.match(read('components/compose/ComposeCommandRow.tsx'), /<CommandBar\b/);
  assert.match(read('components/compose/DraftTabStrip.tsx'), /<nav aria-label=\{t\('compose_strip_label'\)\}/);
  assert.match(read('components/compose/AnchoredPopover.tsx'), /role="dialog"/);
  assert.match(read('components/ContextMenu.tsx'), /'menuitemcheckbox'/, 'checkable "…" entries');
});

test('the compose keys are listed in the shortcut help', () => {
  assert.deepEqual(COMPOSE_AREA_KEYS.map((k) => k.keys), ['escape', 'ctrl+b', 'ctrl+i']);
  for (const k of COMPOSE_AREA_KEYS) assert.ok(k.label in translations.de && k.label in translations.en, k.label);
  assert.deepEqual(displayKeys('escape'), [['Esc']]);
  assert.ok(SHORTCUT_SETS.coremail.some((b) => b.keys === 'ctrl+enter' && b.action === 'compose.send'));
  assert.match(read('components/ShortcutHelpDialog.tsx'), /COMPOSE_AREA_KEYS\.map/);
});
