import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from './changelog.js';

test('parseChangelog: version, date, title, sections; Unreleased has no date', () => {
  const v = parseChangelog([
    '# Changelog', '', '## [Unreleased]', '### Fixed', '- a', '',
    '## [9.1.0] — 2026-11-15 — Shared mailboxes over IMAP', '', 'Intro.', '### Added', '- one', '  continued', '* two',
    '## [9.0.0] - 2026-11-14', '### Security', '- x',
  ].join('\r\n'));
  assert.deepEqual(v.map((x) => [x.version, x.date, x.title]), [
    ['Unreleased', '', ''], ['9.1.0', '2026-11-15', 'Shared mailboxes over IMAP'], ['9.0.0', '2026-11-14', ''],
  ]);
  assert.deepEqual(v[1]!.sections, { Added: ['one', 'two'] });
});

test('parseChangelog: the repository CHANGELOG.md parses with dated, titled releases', () => {
  const raw = readFileSync(fileURLToPath(new URL('../../../../CHANGELOG.md', import.meta.url)), 'utf8');
  const released = parseChangelog(raw).filter((v) => /^\d+\.\d+\.\d+$/.test(v.version));
  assert.ok(released.length > 10);
  assert.match(released[0]!.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(released[0]!.title.length > 0);
});
