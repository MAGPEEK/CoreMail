/**
 * 9.4: follow-up flag rules (pure) — keyword mapping, normalisation, legacy rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flagsForFollowUp, followUpAfterKeywords, followUpForNewRow, followUpOf, normalizeFollowUp,
} from './follow-up.js';

const d = (iso: string): Date => new Date(iso);
const now = d('2026-03-02T10:00:00Z');

test('followUpOf: stored status wins, legacy \\Flagged rows count as flagged', () => {
  assert.equal(followUpOf({ flags: [] }).status, 'none');
  assert.equal(followUpOf({ flags: ['\\Flagged'] }).status, 'flagged');
  assert.equal(followUpOf({ flags: ['\\Flagged'], flagStatus: 'none' }).status, 'flagged');
  const complete = followUpOf({ flags: [], flagStatus: 'complete', flagCompletedAt: now, flagReminderAt: now, flagDueAt: now });
  assert.deepEqual(complete, { status: 'complete', startAt: null, dueAt: now, reminderAt: null, completedAt: now });
});

test('normalizeFollowUp: none drops dates, complete gets a completion time, start never after due', () => {
  assert.deepEqual(normalizeFollowUp({ status: 'none', dueAt: now }, now), { status: 'none', startAt: null, dueAt: null, reminderAt: null, completedAt: null });
  assert.deepEqual(normalizeFollowUp({ status: 'complete', reminderAt: now }, now).completedAt, now);
  assert.equal(normalizeFollowUp({ status: 'complete', reminderAt: now }, now).reminderAt, null);
  const f = normalizeFollowUp({ status: 'flagged', startAt: d('2026-03-05T00:00:00Z'), dueAt: d('2026-03-04T00:00:00Z'), completedAt: now }, now);
  assert.equal(f.startAt!.toISOString(), '2026-03-04T00:00:00.000Z');
  assert.equal(f.completedAt, null);
});

test('flagsForFollowUp: \\Flagged exactly when flagged; other keywords kept', () => {
  assert.deepEqual(flagsForFollowUp(['\\Seen'], 'flagged'), ['\\Seen', '\\Flagged']);
  assert.deepEqual(flagsForFollowUp(['\\Seen', '\\Flagged'], 'flagged'), ['\\Seen', '\\Flagged']);
  assert.deepEqual(flagsForFollowUp(['\\Flagged', '\\Seen'], 'complete'), ['\\Seen']);
  assert.deepEqual(flagsForFollowUp(['\\Flagged'], 'none'), []);
});

test('followUpAfterKeywords: keyword transitions table', () => {
  const table: Array<[string, Parameters<typeof followUpAfterKeywords>[0], string[], unknown]> = [
    ['set on none', { flags: [], flagStatus: 'none' }, ['\\Flagged'], { flagStatus: 'flagged', flagCompletedAt: null }],
    ['set on complete re-flags', { flags: [], flagStatus: 'complete' }, ['\\Flagged'], { flagStatus: 'flagged', flagCompletedAt: null }],
    ['set on flagged: nothing', { flags: ['\\Flagged'], flagStatus: 'flagged' }, ['\\Flagged', '\\Seen'], null],
    ['clear on flagged clears', { flags: ['\\Flagged'], flagStatus: 'flagged' }, [], { flagStatus: 'none', flagStartAt: null, flagDueAt: null, flagReminderAt: null, flagCompletedAt: null }],
    ['clear on complete keeps complete', { flags: [], flagStatus: 'complete' }, ['\\Seen'], null],
    ['legacy row unflagged: nothing to store', { flags: ['\\Flagged'], flagStatus: 'none' }, [], null],
    ['legacy row stays flagged: status stored', { flags: ['\\Flagged'], flagStatus: 'none' }, ['\\Flagged'], { flagStatus: 'flagged', flagCompletedAt: null }],
  ];
  for (const [name, row, next, expected] of table) assert.deepEqual(followUpAfterKeywords(row, next), expected, name);
});

test('followUpForNewRow: delivered with \\Flagged (mail rules) → flagged; explicit status wins', () => {
  assert.deepEqual(followUpForNewRow({ flags: ['\\Flagged'] }), { flagStatus: 'flagged' });
  assert.deepEqual(followUpForNewRow({ flags: ['\\Seen'] }), {});
  assert.deepEqual(followUpForNewRow({ flags: ['\\Flagged'], flagStatus: 'complete' }), {});
});
