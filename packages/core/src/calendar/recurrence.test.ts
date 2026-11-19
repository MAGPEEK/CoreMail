/**
 * 9.5: a simple DAILY / WEEKLY rule jumps to the window instead of iterating from its
 * start — same occurrences as the full iteration (compared with an equivalent rule that
 * takes the full path: a no-op BYMONTH / BYDAY part), COUNT shrinks with the skipped
 * occurrences, an old series costs no more than a new one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandOccurrences, type ExpandableEvent } from './recurrence.js';

const d = (iso: string): Date => new Date(iso);
const ALL_MONTHS = 'BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12';
const iso = (list: Array<{ start: Date; end: Date; recurrenceId: Date }>): string[][] =>
  list.map((o) => [o.start.toISOString(), o.end.toISOString(), o.recurrenceId.toISOString()]);

function same(ev: ExpandableEvent, fullPathRule: string, ws: Date, we: Date): number {
  const fast = expandOccurrences(ev, ws, we);
  const full = expandOccurrences({ ...ev, rrule: fullPathRule }, ws, we);
  assert.deepEqual(iso(fast), iso(full), `${ev.rrule} ${ev.tzid ?? 'UTC'}`);
  return fast.length;
}

test('simple rules skip to the window: identical occurrences (UTC, TZID across DST, all-day, INTERVAL, COUNT, UNTIL, EXDATE)', () => {
  const ws = d('2026-03-20T00:00:00Z');
  const we = d('2026-04-10T00:00:00Z');
  const utc: ExpandableEvent = { start: d('1990-01-03T09:00:00Z'), end: d('1990-01-03T10:00:00Z'), allDay: false, tzid: null, rrule: 'FREQ=DAILY;INTERVAL=3' };
  assert.ok(same(utc, `FREQ=DAILY;INTERVAL=3;${ALL_MONTHS}`, ws, we) > 0);

  // 10:00 Berlin every second week since 2001 (Wednesday): DST change on 2026-03-29 inside the window
  const berlin: ExpandableEvent = { start: d('2001-01-03T09:00:00Z'), end: d('2001-01-03T10:00:00Z'), allDay: false, tzid: 'Europe/Berlin', rrule: 'FREQ=WEEKLY;INTERVAL=2' };
  assert.ok(same(berlin, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE', ws, we) > 0);
  const local = expandOccurrences(berlin, ws, we).map((o) => o.start.toISOString());
  assert.ok(local.every((s) => s.endsWith('T09:00:00.000Z') || s.endsWith('T08:00:00.000Z')), local.join());
  assert.ok(local.some((s) => s.endsWith('T08:00:00.000Z')), 'summer time: 10:00 local = 08:00Z');

  const allDay: ExpandableEvent = { start: d('2000-02-29T00:00:00Z'), end: d('2000-03-01T00:00:00Z'), allDay: true, tzid: null, rrule: 'FREQ=WEEKLY' };
  assert.ok(same(allDay, 'FREQ=WEEKLY;BYDAY=TU', ws, we) > 0);

  // COUNT reaching into the window, and used up before it
  const counted: ExpandableEvent = { ...utc, rrule: 'FREQ=DAILY;COUNT=13430' };
  assert.ok(same(counted, `FREQ=DAILY;COUNT=13430;${ALL_MONTHS}`, ws, we) > 0);
  assert.deepEqual(expandOccurrences({ ...utc, rrule: 'FREQ=DAILY;COUNT=100' }, ws, we), []);
  assert.equal(same({ ...utc, rrule: 'FREQ=DAILY;COUNT=100' }, `FREQ=DAILY;COUNT=100;${ALL_MONTHS}`, ws, we), 0);

  const until: ExpandableEvent = { ...utc, rrule: 'FREQ=DAILY;UNTIL=20260401T090000Z' };
  assert.ok(same(until, `FREQ=DAILY;UNTIL=20260401T090000Z;${ALL_MONTHS}`, ws, we) > 0);

  const exdated: ExpandableEvent = { ...utc, rrule: 'FREQ=DAILY', exdates: [{ date: d('2026-03-25T09:00:00Z'), dateOnly: false, tzid: null }] };
  const out = expandOccurrences(exdated, ws, we).map((o) => o.start.toISOString());
  assert.ok(!out.includes('2026-03-25T09:00:00.000Z') && out.includes('2026-03-24T09:00:00.000Z'));
});

test('an old daily series is as cheap as a new one (no iteration from 1900)', () => {
  const old: ExpandableEvent = { start: d('1900-01-01T09:00:00Z'), end: d('1900-01-01T10:00:00Z'), allDay: false, tzid: null, rrule: 'FREQ=DAILY' };
  const started = Date.now();
  for (let i = 0; i < 20; i++) assert.equal(expandOccurrences(old, d('2026-11-18T00:00:00Z'), d('2026-11-25T00:00:00Z')).length, 7);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});
