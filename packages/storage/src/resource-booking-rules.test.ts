/**
 * 9.5: resource booking rules shared by the event form and the invitation mail path —
 * horizon, series expansion (EXDATE / overrides, cap), conflicting occurrences and the
 * locked check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVCalendar } from '@coremail/core/calendar';
import {
  bookingHorizon, bookingIntervals, checkResourceBooking, conflictList, conflictingOccurrences, isBookableRecurrence,
  meetingOccurrences,
  MAX_CHECKED_OCCURRENCES, MAX_LISTED_CONFLICTS, type RoomPolicy,
} from './resource-booking-rules.js';

const d = (iso: string): Date => new Date(iso);
const NOW = d('2026-11-18T08:00:00Z');
const ROOM: RoomPolicy = {
  active: true, autoAccept: true, autoDeclineConflict: true, allowRecurring: true,
  maxDurationMinutes: null, bookingWindowDays: 180, requireApproval: false,
};
const series = (uid: string, start: string, rrule: string, extra: { exdates?: string[] } = {}) => {
  let icalData = buildVCalendar({ uid, summary: uid, start: d(start), end: new Date(d(start).getTime() + 3_600_000), rrule });
  for (const x of extra.exdates ?? []) icalData = icalData.replace(`RRULE:${rrule}`, `RRULE:${rrule}\r\nEXDATE:${x}`);
  return { uid, dtStart: d(start), dtEnd: new Date(d(start).getTime() + 3_600_000), allDay: false, rrule: null, icalData };
};

test('bookingHorizon: the booking window, at most a year ahead, never before the meeting end', () => {
  const meeting = { dtStart: d('2026-12-01T09:00:00Z'), dtEnd: d('2026-12-01T10:00:00Z') };
  assert.equal(bookingHorizon(ROOM, meeting, NOW).end.toISOString(), '2027-05-17T08:00:00.000Z');
  assert.equal(bookingHorizon({ bookingWindowDays: 5000 }, meeting, NOW).end.toISOString(), '2027-11-19T08:00:00.000Z');
  assert.equal(bookingHorizon({ bookingWindowDays: 0 }, meeting, NOW).end.toISOString(), '2026-12-01T10:00:00.000Z');
});

test('meetingOccurrences: EXDATE applied, capped', () => {
  const weekly = series('w', '2026-12-01T09:00:00Z', 'FREQ=WEEKLY;COUNT=4', { exdates: ['20261208T090000Z'] });
  const occ = meetingOccurrences(weekly, { start: weekly.dtStart, end: d('2027-01-31T00:00:00Z') });
  assert.deepEqual(occ.map((o) => o.dtStart.toISOString()), ['2026-12-01T09:00:00.000Z', '2026-12-15T09:00:00.000Z', '2026-12-22T09:00:00.000Z']);
  const daily = series('d', '2026-12-01T09:00:00Z', 'FREQ=DAILY');
  assert.equal(meetingOccurrences(daily, { start: daily.dtStart, end: d('2028-12-01T00:00:00Z') }).length, MAX_CHECKED_OCCURRENCES);
});

test('conflictingOccurrences / conflictList', () => {
  const occ = [{ dtStart: d('2026-12-01T09:00:00Z'), dtEnd: d('2026-12-01T10:00:00Z') }, { dtStart: d('2026-12-08T09:00:00Z'), dtEnd: d('2026-12-08T10:00:00Z') }];
  const busy = [{ start: d('2026-12-08T09:30:00Z'), end: d('2026-12-08T11:00:00Z'), kind: 'busy' as const }];
  assert.deepEqual(conflictingOccurrences(occ, busy), [occ[1]]);
  assert.deepEqual(conflictList(conflictingOccurrences(occ, busy)), [{ start: '2026-12-08T09:00:00.000Z', end: '2026-12-08T10:00:00.000Z' }]);
  const many = Array.from({ length: 80 }, (_, i) => ({ dtStart: new Date(i * 3_600_000), dtEnd: new Date(i * 3_600_000 + 1) }));
  assert.equal(conflictList(many).length, MAX_LISTED_CONFLICTS);
});

test('checkResourceBooking: takes the lock first, expands the stored recurring bookings, lists the conflicts', async () => {
  const calls: string[] = [];
  const stored = series('blocker', '2026-12-02T09:00:00Z', 'FREQ=WEEKLY;COUNT=3');
  const tx = {
    resourceCalendar: { update: async () => { calls.push('lock'); return { id: 'rc' }; } },
    resourceBooking: { findMany: async () => { calls.push('read'); return [{ uid: 'blocker', status: 'ACCEPTED', dtStart: stored.dtStart, dtEnd: stored.dtEnd, icalData: stored.icalData }]; } },
  } as unknown as Parameters<typeof checkResourceBooking>[0];
  const meeting = series('m', '2026-12-16T09:30:00Z', 'FREQ=DAILY;COUNT=2');
  const result = await checkResourceBooking(tx, 'rc', ROOM, meeting, NOW);
  assert.deepEqual(calls, ['lock', 'read']);
  assert.deepEqual(result.decision, { status: 'DECLINED', reason: 'conflict' });
  assert.deepEqual(result.conflicts.map((c) => c.dtStart.toISOString()), ['2026-12-16T09:30:00.000Z']);
  const tolerant = await checkResourceBooking(tx, 'rc', { ...ROOM, autoDeclineConflict: false }, meeting, NOW);
  assert.deepEqual(tolerant.decision, { status: 'ACCEPTED' });
  assert.equal(tolerant.conflicts.length, 1);
});

test('isBookableRecurrence: at most daily — HOURLY/MINUTELY/SECONDLY and several times a day are refused (also folded)', () => {
  const ok = (rrule: string): boolean => isBookableRecurrence(series('x', '2026-12-01T09:00:00Z', rrule));
  assert.equal(ok('FREQ=DAILY'), true);
  assert.equal(ok('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=1000000'), true);
  assert.equal(ok('FREQ=DAILY;BYHOUR=9'), true);
  assert.equal(ok('FREQ=MINUTELY'), false);
  assert.equal(ok('FREQ=SECONDLY;BYMONTH=2'), false);
  assert.equal(ok('FREQ=HOURLY;INTERVAL=24'), false);
  assert.equal(ok('FREQ=DAILY;BYHOUR=9,10'), false);
  assert.equal(ok('FREQ=YEARLY;BYMINUTE=0,30'), false);
  const folded = series('y', '2026-12-01T09:00:00Z', 'FREQ=DAILY').icalData.replace('RRULE:FREQ=DAILY', 'RRULE:FREQ=SECO\r\n NDLY');
  assert.equal(isBookableRecurrence({ rrule: null, icalData: folded }), false);
  assert.equal(isBookableRecurrence({ rrule: 'FREQ=MINUTELY', icalData: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }), false);
  assert.equal(isBookableRecurrence({ rrule: null, icalData: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }), true);
});

test('dense series: a request is declined without expansion, a stored one blocks its first slot only (bounded time)', async () => {
  const old = series('dense', '2025-11-18T09:00:00Z', 'FREQ=MINUTELY');
  const started = Date.now();
  const row = { uid: 'dense', status: 'ACCEPTED', dtStart: old.dtStart, dtEnd: old.dtEnd, icalData: old.icalData };
  assert.deepEqual(
    bookingIntervals([row], d('2025-11-18T00:00:00Z'), d('2027-11-18T00:00:00Z')).map((b) => [b.start.toISOString(), b.end.toISOString()]),
    [['2025-11-18T09:00:00.000Z', '2025-11-18T10:00:00.000Z']],
  );
  // a year after its start it blocks nothing (it was expanded minute by minute from the start before)
  assert.deepEqual(bookingIntervals([row], NOW, d('2027-11-18T00:00:00Z')), []);
  const meeting = series('m', '2026-12-01T09:00:00Z', 'FREQ=SECONDLY');
  assert.equal(meetingOccurrences(meeting, { start: meeting.dtStart, end: d('2027-12-01T00:00:00Z') }).length, 1);
  const tx = {
    resourceCalendar: { update: async () => ({ id: 'rc' }) },
    resourceBooking: { findMany: async () => [] },
  } as unknown as Parameters<typeof checkResourceBooking>[0];
  const result = await checkResourceBooking(tx, 'rc', ROOM, meeting, NOW);
  assert.deepEqual(result.decision, { status: 'DECLINED', reason: 'recurring' });
  assert.ok(Date.now() - started < 1000, 'no expansion from the series start');
});
