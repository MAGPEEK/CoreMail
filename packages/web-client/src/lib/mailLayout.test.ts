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
import { MAIL_VIEW_ROOT_CLASS, fillsFlexRow } from './mailLayout.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('mail view root fills the horizontal <main> and may shrink', () => {
  assert.ok(fillsFlexRow(MAIL_VIEW_ROOT_CLASS));
  assert.equal(fillsFlexRow('h-full flex flex-col bg-surface-2'), false, 'the 9.2 shared-mailbox root');
  assert.equal(fillsFlexRow('flex-1 overflow-hidden'), false, 'flex-1 alone keeps min-width:auto');
  // <main> is a horizontal flex row (App.tsx)
  assert.match(read('App.tsx'), /<main[^>]*className="[^"]*\bflex\b(?![-\w])[^"]*"/);
  // MailPage renders its root with the contract class
  const page = read('pages/MailPage.tsx');
  assert.match(page, /className=\{MAIL_VIEW_ROOT_CLASS\}/);
});

test('shared / delegated mailboxes open in the mail view (no separate page)', () => {
  assert.equal(existsSync(join(src, 'pages/SharedMailboxPage.tsx')), false);
  const app = read('App.tsx');
  assert.doesNotMatch(app, /SharedMailboxPage/);
  assert.match(app, /path="\/shared-mailbox\/:id"/, 'old links keep working (redirect)');
});
