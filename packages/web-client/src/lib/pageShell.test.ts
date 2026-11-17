import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('every app page uses the shared page shell', () => {
  for (const page of ['MailPage', 'CalendarPage', 'ContactsPage', 'TasksPage', 'NotesPage']) {
    assert.match(read(`pages/${page}.tsx`), /<PageShell\b/, page);
  }
});

test('mail and calendar share one command bar component (no own ribbon/bulk toolbars)', () => {
  assert.match(read('components/CalendarToolbar.tsx'), /<CommandBar\b/);
  assert.match(read('components/MailCommandBar.tsx'), /<CommandBar\b/);
  assert.match(read('components/MessageReader.tsx'), /<CommandBar\b/);
  assert.doesNotMatch(read('pages/MailPage.tsx'), /BulkToolbar/, 'multi-select actions live in the command bar');
  const bar = read('components/CommandBar.tsx');
  assert.match(bar, /role="toolbar"/);
  assert.match(bar, /nextRovingIndex/, 'arrow-key roving focus');
});
