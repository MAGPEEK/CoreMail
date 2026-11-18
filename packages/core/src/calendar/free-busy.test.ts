/**
 * 9.4: free/busy merge and meeting-time suggestions.
 * Run: node --import tsx --test src/calendar/free-busy.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyKindOf, mergeBusy, suggestSlots, type BusyInterval } from './free-busy.js';

const d = (iso: string): Date => new Date(iso);
const iv = (s: string, e: string, kind: BusyInterval['kind'] = 'busy'): BusyInterval => ({ start: d(s), end: d(e), kind });
const view = (xs: BusyInterval[]) => xs.map((x) => `${x.start.toISOString().slice(11, 16)}-${x.end.toISOString().slice(11, 16)} ${x.kind}`);

test('busyKindOf: show-as and status table', () => {
  const table: Array<[string | null, string | null, ReturnType<typeof busyKindOf>]> = [
    ['BUSY', 'CONFIRMED', 'busy'],
    [null, null, 'busy'],
    ['FREE', 'CONFIRMED', null],
    ['BUSY', 'CANCELLED', null],
    ['TENTATIVE', null, 'tentative'],
    ['BUSY', 'TENTATIVE', 'tentative'],
    ['OOF', 'TENTATIVE', 'oof'],
  ];
  for (const [showAs, status, expected] of table) assert.equal(busyKindOf(showAs, status), expected, `${showAs}/${status}`);
});

test('mergeBusy: overlaps joined, strongest kind wins, adjacent same kind joined', () => {
  const merged = mergeBusy([
    iv('2026-01-05T09:00:00Z', '2026-01-05T10:00:00Z'),
    iv('2026-01-05T09:30:00Z', '2026-01-05T11:00:00Z'),
    iv('2026-01-05T11:00:00Z', '2026-01-05T11:30:00Z'),
    iv('2026-01-05T13:00:00Z', '2026-01-05T15:00:00Z', 'tentative'),
    iv('2026-01-05T14:00:00Z', '2026-01-05T14:30:00Z', 'oof'),
    iv('2026-01-05T16:00:00Z', '2026-01-05T16:00:00Z'), // zero length: ignored
  ]);
  assert.deepEqual(view(merged), [
    '09:00-11:30 busy',
    '13:00-14:00 tentative',
    '14:00-14:30 oof',
    '14:30-15:00 tentative',
  ]);
});

test('suggestSlots: free slots first, inside working hours of the organizer zone', () => {
  const alice = mergeBusy([iv('2026-01-05T08:00:00Z', '2026-01-05T10:00:00Z')]); // 09–11 Berlin
  const bob = mergeBusy([iv('2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z', 'tentative')]); // 11–12 Berlin
  const slots = suggestSlots({
    busy: [alice, bob],
    windowStart: d('2026-01-05T00:00:00Z'),
    windowEnd: d('2026-01-06T00:00:00Z'),
    durationMs: 60 * 60_000,
    workingHours: { days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 17 * 60, timeZone: 'Europe/Berlin' },
    max: 3,
  });
  // 08:00 Berlin (07:00Z) is free for both, 11:00 Berlin only tentative for Bob
  assert.deepEqual(slots.map((s) => [s.start.toISOString(), s.conflicts, s.tentative]), [
    ['2026-01-05T07:00:00.000Z', 0, 0],
    ['2026-01-05T11:00:00.000Z', 0, 0],
    ['2026-01-05T11:30:00.000Z', 0, 0],
  ]);
  for (const s of slots) assert.equal(s.end.getTime() - s.start.getTime(), 3_600_000);
});

test('suggestSlots: weekend excluded, notBefore respected, fewest conflicts when nobody is free', () => {
  const allDayBusy = mergeBusy([iv('2026-01-10T00:00:00Z', '2026-01-12T23:59:00Z')]);
  const slots = suggestSlots({
    busy: [allDayBusy, []],
    windowStart: d('2026-01-10T00:00:00Z'), // Saturday
    windowEnd: d('2026-01-13T00:00:00Z'),
    durationMs: 30 * 60_000,
    notBefore: d('2026-01-12T09:10:00Z'),
    workingHours: { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 10 * 60, timeZone: '' },
  });
  assert.ok(slots.length > 0);
  assert.equal(slots[0]!.start.toISOString(), '2026-01-12T09:30:00.000Z');
  assert.ok(slots.every((s) => s.conflicts === 1));
});
