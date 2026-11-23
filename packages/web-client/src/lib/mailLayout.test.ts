/**
 * 9.3 regression: the shared-mailbox view rendered only 637 px wide at 1440 px because
 * its root sat in the horizontal flex <main> without `flex-1 min-w-0`. Shared and
 * delegated mailboxes are now shown by the mail page itself, whose root must keep
 * the layout contract; the separate page must not come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DRAFT_STRIP_CLASS, MAIL_VIEW_COLUMN_CLASS, MAIL_VIEW_ROOT_CLASS, draftStripPlace, fillsFlexRow } from './mailLayout.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('mail view root fills the horizontal <main> and may shrink', () => {
  assert.ok(fillsFlexRow(MAIL_VIEW_ROOT_CLASS));
  assert.ok(fillsFlexRow(MAIL_VIEW_COLUMN_CLASS), '9.4: the column holding the mail view');
  assert.match(read('pages/MailPage.tsx'), /className=\{MAIL_VIEW_COLUMN_CLASS\}/);
  assert.equal(fillsFlexRow('h-full flex flex-col bg-surface-2'), false, 'the 9.2 shared-mailbox root');
  assert.equal(fillsFlexRow('flex-1 overflow-hidden'), false, 'flex-1 alone keeps min-width:auto');
  // <main> is a horizontal flex row (App.tsx)
  assert.match(read('App.tsx'), /<main[^>]*className="[^"]*\bflex\b(?![-\w])[^"]*"/);
  // MailPage renders its root with the contract class
  const page = read('pages/MailPage.tsx');
  assert.match(page, /className=\{MAIL_VIEW_ROOT_CLASS\}/);
});

test('10.7: the draft tabs sit at the top of the content card, else above the list, never without drafts', () => {
  assert.equal(draftStripPlace(0, ['folders', 'list', 'reader']), 'none');
  assert.equal(draftStripPlace(2, ['folders', 'list', 'reader']), 'content');
  assert.equal(draftStripPlace(1, ['folders', 'list', 'compose']), 'content');
  assert.equal(draftStripPlace(1, ['compose']), 'content', 'single pane: the shown draft');
  assert.equal(draftStripPlace(1, ['folders', 'list']), 'list', 'reading pane off');
  assert.equal(draftStripPlace(1, ['list']), 'list', 'single pane: the list');
  assert.equal(draftStripPlace(1, ['folders']), 'list');
  const page = read('pages/MailPage.tsx');
  assert.match(page, /const contentStrip = stripPlace === 'content' \? <DraftTabStrip \/> : null;/);
  assert.match(page, /\{stripPlace === 'list' && <DraftTabStrip \/>\}/);
  assert.match(DRAFT_STRIP_CLASS, /\bborder-b\b/, 'a tab row at the top of the card');
});

test('10.7: three cards with labelled regions; the folder card is a card like the others', () => {
  const page = read('pages/MailPage.tsx');
  assert.match(page, /<section aria-label=\{t\('mail_region_list'\)\}/);
  assert.match(page, /<section key=\{selectedMessageId\} aria-label=\{t\('mail_region_content'\)\}/);
  assert.match(page, /className=\{`h-full \$\{FOLDER_PANE_CLASS\}`\}/);
});

test('shared / delegated mailboxes open in the mail view (no separate page)', () => {
  assert.equal(existsSync(join(src, 'pages/SharedMailboxPage.tsx')), false);
  const app = read('App.tsx');
  assert.doesNotMatch(app, /SharedMailboxPage/);
  assert.match(app, /path="\/shared-mailbox\/:id"/, 'old links keep working (redirect)');
});
