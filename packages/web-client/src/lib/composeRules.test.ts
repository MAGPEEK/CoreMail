import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENTS, MAX_INLINE_IMAGE_BYTES, MIN_SCHEDULE_LEAD_MS, addAttachments, composeFieldVisibility,
  defaultCustomSchedule, dragHasFiles, draftStatusText, formatSize, hasPendingChanges, initialFocus,
  inlineImageProblem, insertCommands, ribbonTabs, schedulePresets, scheduleProblem, visibleRibbonTab,
} from './composeRules.ts';
import {
  COMPOSE_EMOJI, EMOJI_COLUMNS, HIGHLIGHT_COLORS, TEXT_COLORS, dateTimeInsertOptions, gridMove,
} from './composeFormat.ts';
import { createRuntimeRegistry } from './composeRuntime.ts';
import { toLocalInput } from './datetime.ts';

test('fields: Von only with a choice; Cc/Bcc when asked for or filled; toggles only for hidden rows', () => {
  const base = { senderCount: 1, showCc: false, showBcc: false, ccCount: 0, bccCount: 0 };
  assert.deepEqual(composeFieldVisibility(base), { from: false, cc: false, bcc: false, ccToggle: true, bccToggle: true });
  assert.equal(composeFieldVisibility({ ...base, senderCount: 2 }).from, true);
  assert.deepEqual(composeFieldVisibility({ ...base, ccCount: 1 }), { from: false, cc: true, bcc: false, ccToggle: false, bccToggle: true });
  assert.deepEqual(composeFieldVisibility({ ...base, showBcc: true }), { from: false, cc: false, bcc: true, ccToggle: true, bccToggle: false });
  assert.equal(composeFieldVisibility({ ...base, bccCount: 2 }).bcc, true, 'a reopened draft with Bcc shows the row');
});

test('focus on open: An for a new mail / forward without recipients, else the body; replies the body', () => {
  assert.equal(initialFocus('new', 0), 'to');
  assert.equal(initialFocus('forward', 0), 'to');
  assert.equal(initialFocus('new', 1), 'body');
  assert.equal(initialFocus('reply', 0), 'body');
  assert.equal(initialFocus('replyAll', 3), 'body');
});

test('attachments: up to the server limit, the rest is reported', () => {
  assert.equal(MAX_ATTACHMENTS, 10);
  assert.deepEqual(addAttachments([1, 2], [3, 4]), { list: [1, 2, 3, 4], rejected: 0 });
  assert.deepEqual(addAttachments([1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12]), { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], rejected: 2 });
  assert.deepEqual(addAttachments([1], [2], 1), { list: [1], rejected: 1 });
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSize(3.5 * 1024 * 1024), '3.5 MB');
});

test('inline images: raster types only (no SVG), max 500 KB', () => {
  assert.equal(inlineImageProblem({ type: 'image/png', size: 1000 }), null);
  assert.equal(inlineImageProblem({ type: 'image/jpg', size: 1000 }), null);
  assert.equal(inlineImageProblem({ type: 'image/svg+xml', size: 10 }), 'type');
  assert.equal(inlineImageProblem({ type: 'text/html', size: 10 }), 'type');
  assert.equal(inlineImageProblem({ type: 'image/png', size: MAX_INLINE_IMAGE_BYTES + 1 }), 'size');
});

test('drag & drop reacts to files only (not to mails dragged from the list or text)', () => {
  assert.ok(dragHasFiles(['Files', 'text/plain']));
  assert.equal(dragHasFiles(['text/plain']), false);
  assert.equal(dragHasFiles(undefined), false);
});

test('schedule presets: tomorrow 8:00 / 13:00, next Monday 8:00 (a Monday goes to the next one)', () => {
  const wed = new Date(2026, 10, 18, 15, 30);           // Wednesday
  const [a, b, c] = schedulePresets(wed);
  assert.deepEqual([a!.id, a!.date.getDate(), a!.date.getHours()], ['tomorrowMorning', 19, 8]);
  assert.deepEqual([b!.id, b!.date.getDate(), b!.date.getHours()], ['tomorrowAfternoon', 19, 13]);
  assert.deepEqual([c!.id, c!.date.getDay(), c!.date.getDate(), c!.date.getHours()], ['nextMonday', 1, 23, 8]);
  const mon = new Date(2026, 10, 23, 7, 0);
  assert.equal(schedulePresets(mon)[2]!.date.getDate(), 30);
  const sat = new Date(2026, 10, 28, 23, 0);
  assert.equal(schedulePresets(sat)[0]!.date.getMonth(), 10, 'month rollover handled by Date');
  assert.deepEqual([schedulePresets(sat)[0]!.date.getDate(), schedulePresets(sat)[2]!.date.getDate()], [29, 30]);
});

test('custom schedule: in an hour on the full hour; at least 30 s ahead; invalid values refused', () => {
  const now = new Date(2026, 10, 18, 10, 17, 45);
  const d = defaultCustomSchedule(now);
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds()], [11, 0, 0]);
  assert.equal(scheduleProblem(toLocalInput(d), now), null);
  assert.equal(scheduleProblem('', now), 'invalid');
  assert.equal(scheduleProblem('morgen', now), 'invalid');
  assert.equal(scheduleProblem(toLocalInput(new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS - 60_000)), now), 'tooSoon');
  assert.equal(scheduleProblem(toLocalInput(new Date(now.getTime() - 3_600_000)), now), 'tooSoon');
});

test('ribbon: three tabs for HTML, only Einfügen (file, emoji, signature, date) for plain text', () => {
  assert.deepEqual(ribbonTabs(false), ['message', 'insert', 'format']);
  assert.deepEqual(ribbonTabs(true), ['insert']);
  assert.deepEqual(insertCommands(false, true), ['file', 'image', 'table', 'link', 'emoji', 'signature', 'datetime', 'rule']);
  assert.deepEqual(insertCommands(true, true), ['file', 'emoji', 'signature', 'datetime']);
  assert.deepEqual(insertCommands(true, false), ['file', 'emoji', 'datetime'], 'no signatures: no picker');
  assert.equal(visibleRibbonTab('format', true), 'insert', 'switching to plain text leaves Format');
  assert.equal(visibleRibbonTab('format', false), 'format');
});

test('status line: loading, saving, failed, locked, saved at …', () => {
  assert.deepEqual(draftStatusText('idle', undefined, true), { kind: 'loading' });
  assert.deepEqual(draftStatusText('saving', '2026-11-18T10:00:00Z', false), { kind: 'saving' });
  assert.deepEqual(draftStatusText('error', undefined, false), { kind: 'failed' });
  assert.deepEqual(draftStatusText('locked', undefined, false), { kind: 'locked' });
  assert.deepEqual(draftStatusText('saved', '2026-11-18T10:00:00Z', false), { kind: 'savedAt', at: new Date('2026-11-18T10:00:00Z') });
  assert.deepEqual(draftStatusText('dirty', '2026-11-18T10:00:00Z', false).kind, 'savedAt', 'typing after a save still shows the last save');
  assert.deepEqual(draftStatusText('idle', undefined, false), { kind: 'none' });
  assert.deepEqual(draftStatusText('idle', '2026-11-18T10:00:00Z', false).kind, 'savedAt', 'reopened / shown again');
  assert.ok(hasPendingChanges('dirty') && hasPendingChanges('saving') && hasPendingChanges('error'));
  assert.ok(!hasPendingChanges('saved') && !hasPendingChanges('idle') && !hasPendingChanges('locked'));
});

test('format choices: colour ids unique, emoji grid navigation', () => {
  for (const list of [TEXT_COLORS, HIGHLIGHT_COLORS]) {
    assert.equal(new Set(list.map((c) => c.id)).size, list.length);
    for (const c of list) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  }
  const n = COMPOSE_EMOJI.length;
  assert.equal(gridMove(0, 'ArrowRight', n, EMOJI_COLUMNS), 1);
  assert.equal(gridMove(0, 'ArrowLeft', n, EMOJI_COLUMNS), 0);
  assert.equal(gridMove(3, 'ArrowDown', n, EMOJI_COLUMNS), 13);
  assert.equal(gridMove(13, 'ArrowUp', n, EMOJI_COLUMNS), 3);
  assert.equal(gridMove(n - 2, 'ArrowDown', n, EMOJI_COLUMNS), n - 2, 'last row: stays');
  assert.equal(gridMove(5, 'End', n, EMOJI_COLUMNS), n - 1);
  assert.equal(gridMove(5, 'Home', n, EMOJI_COLUMNS), 0);
  assert.equal(gridMove(5, 'a', n, EMOJI_COLUMNS), null);
});

test('date/time insert uses the regional settings', () => {
  const now = new Date(Date.UTC(2026, 10, 18, 9, 5));
  const opts = dateTimeInsertOptions(now, { language: 'de', timeZone: 'UTC', dateFormat: 'dd.MM.yyyy', timeFormat: '24h' });
  assert.deepEqual(opts.map((o) => o.id), ['date', 'longDate', 'time', 'dateTime']);
  assert.equal(opts[0]!.text, '18.11.2026');
  assert.match(opts[1]!.text, /Mittwoch/);
  assert.equal(opts[2]!.text, '09:05');
  assert.equal(opts[3]!.text, '18.11.2026 09:05');
  const us = dateTimeInsertOptions(now, { language: 'en', timeZone: 'UTC', dateFormat: 'MM/dd/yyyy', timeFormat: '12h' });
  assert.equal(us[3]!.text, '11/18/2026 9:05 AM');
});

test('runtime registry: one entry per draft tab, release runs the hook once', () => {
  const released: string[] = [];
  const reg = createRuntimeRegistry<{ n: number }>((_e, key) => released.push(key));
  let made = 0;
  const a = reg.ensure('k1', () => ({ n: ++made }));
  assert.equal(reg.ensure('k1', () => ({ n: ++made })), a, 'reused across mounts');
  assert.equal(made, 1);
  reg.ensure('k2', () => ({ n: ++made }));
  assert.deepEqual(reg.keys(), ['k1', 'k2']);
  assert.equal(reg.release('k1'), a);
  assert.equal(reg.release('k1'), undefined);
  assert.deepEqual(released, ['k1']);
  assert.equal(reg.get('k1'), undefined);
});
