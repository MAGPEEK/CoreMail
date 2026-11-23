import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PAGE_SHELL_CLASS, PAGE_BODY_CLASS } from './pageShell.ts';
import { fillsFlexRow } from './mailLayout.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('page shell fills the horizontal <main> and its body may shrink', () => {
  assert.ok(fillsFlexRow(PAGE_SHELL_CLASS));
  assert.match(PAGE_BODY_CLASS, /\bmin-h-0\b/, 'scrolling panes need min-h-0 inside the column');
});

test('every app page uses the shared page shell; mail, calendar and contacts have no header row (10.7)', () => {
  for (const page of ['MailPage', 'CalendarPage', 'ContactsPage', 'TasksPage', 'NotesPage']) {
    assert.match(read(`pages/${page}.tsx`), /<PageShell\b/, page);
  }
  for (const page of ['MailPage', 'CalendarPage', 'ContactsPage']) {
    assert.match(read(`pages/${page}.tsx`), /<PageShell[^>]*header=\{false\}/, `${page}: no header row`);
    assert.doesNotMatch(read(`pages/${page}.tsx`), /<\w*Ribbon\b|Ribbon\.js|\bribbon(=|\s*$)/m, `${page}: no ribbon`);
  }
  assert.match(read('components/PageShell.tsx'), /<h1 className="sr-only">\{title\}<\/h1>/, 'the heading stays for screen readers');
});

test('the mail commands share one command bar component (no own bulk toolbars)', () => {
  assert.match(read('components/MailCommands.tsx'), /<CommandBar\b/);
  assert.match(read('components/MessageReader.tsx'), /<CommandBar\b/);
  assert.match(read('components/CalendarToolbar.tsx'), /<CommandBar\b/);
  assert.match(read('components/contacts/ContactsCommands.tsx'), /<CommandBar\b/);
  assert.doesNotMatch(read('pages/MailPage.tsx'), /BulkToolbar/, 'multi-select actions live in the selection bar');
  const bar = read('components/CommandBar.tsx');
  assert.match(bar, /role="toolbar"/);
  assert.match(bar, /nextRovingIndex/, 'arrow-key roving focus');
});

test('"Neue E-Mail" has one entry: the split button at the top of the folder card (+ the n / c shortcut)', () => {
  const page = read('pages/MailPage.tsx');
  assert.match(page, /<FolderTree top=\{<NewMailButton onNewFromTemplate=\{templates\.open\} \/>\} \/>/);
  assert.equal((page.match(/<NewMailButton\b/g) ?? []).length, 1, 'one place in the mail view');
  const cmds = read('components/MailCommands.tsx');
  assert.match(cmds, /keyshortcuts=\{ariaKeys\('compose\.new'\)\}/);
  assert.match(cmds, /onClick=\{\(\) => openCompose\(\)\}/);
  assert.match(cmds, /menu=\{\(\) => newMenuItems\(/);
});

test('calendar filter popover: a labelled dialog that takes focus, closes on Escape, returns focus', () => {
  const src = read('components/CalendarToolbar.tsx');
  assert.match(src, /role="dialog"\s+aria-label="Filter"/);
  assert.match(src, /e\.key === 'Escape'[^\n]*closeFilter\(\)/);
  assert.match(src, /trigger\.focus\(\)/);
  assert.match(src, /dialogOpen: popoverOpen/, 'button exposes aria-haspopup="dialog" + aria-expanded');
  assert.match(src, /toItem\(c, dispatch, filterIsOpen\)/);
});

test('mail, calendar and contacts share one pane surface; "Über CoreMail" lives in the profile menu', () => {
  for (const page of ['pages/CalendarPage.tsx', 'pages/ContactsPage.tsx']) {
    assert.match(read(page), /<PaneCard\b/, page);
    assert.doesNotMatch(read(page), /CardSurface/, `${page}: no local card wrapper`);
    assert.doesNotMatch(read(page), /AboutDialog/, `${page}: the about dialog is in the profile menu`);
  }
  assert.match(read('components/ProfileMenu.tsx'), /import \{ AboutDialog \} from '\.\/AboutDialog\.js'/);
  for (const gone of ['components/calendar/ribbonAdapter.tsx', 'components/calendar/CardSurface.tsx', 'components/contacts/CardSurface.tsx',
    'components/contacts/AboutDialog.tsx', 'components/contacts/ContactsCommandBar.tsx', 'components/MailCommandBar.tsx']) {
    assert.equal(existsSync(join(src, gone)), false, `${gone} is gone`);
  }
});
