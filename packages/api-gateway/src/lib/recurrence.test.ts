/**
 * Recurrence expansion for the REST list + free/busy endpoints.
 * Run: node --import tsx --test src/lib/recurrence.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVCalendar } from '@coremail/core/calendar';
import { expandOccurrences, expandStoredEvent, overlaps } from './recurrence.js';

const d = (iso: string): Date => new Date(iso);
const isoList = (xs: Array<{ start: Date }>): string[] => xs.map((x) => x.start.toISOString());

test('overlap semantics at the window edges (half-open intervals)', () => {
  const ws = d('2026-01-10T00:00:00Z');
  const we = d('2026-01-11T00:00:00Z');
  const table: Array<[string, string, boolean]> = [
    ['2026-01-09T23:00:00Z', '2026-01-10T01:00:00Z', true],  // starts before, ends inside
    ['2026-01-10T23:00:00Z', '2026-01-11T01:00:00Z', true],  // starts inside, ends after
    ['2026-01-09T00:00:00Z', '2026-01-12T00:00:00Z', true],  // spans the window
    ['2026-01-09T00:00:00Z', '2026-01-10T00:00:00Z', false], // ends exactly at window start
    ['2026-01-11T00:00:00Z', '2026-01-11T01:00:00Z', false], // starts exactly at window end
    ['2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z', true],  // zero-length at window start
  ];
  for (const [s, e, expected] of table) assert.equal(overlaps(d(s), d(e), ws, we), expected, `${s}–${e}`);
});

test('expansion table: DAILY COUNT, WEEKLY BYDAY, EXDATE, UNTIL, window edges', () => {
  const table: Array<{
    name: string; start: string; end: string; rrule: string; exdates?: string[];
    ws: string; we: string; expected: string[];
  }> = [
    {
      name: 'DAILY;COUNT=3', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=3', ws: '2025-12-01T00:00:00Z', we: '2026-02-01T00:00:00Z',
      expected: ['2026-01-01T10:00:00.000Z', '2026-01-02T10:00:00.000Z', '2026-01-03T10:00:00.000Z'],
    },
    {
      name: 'WEEKLY;BYDAY=MO,WE', start: '2026-01-05T08:00:00Z', end: '2026-01-05T09:00:00Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', ws: '2026-01-05T00:00:00Z', we: '2026-01-15T00:00:00Z',
      expected: ['2026-01-05T08:00:00.000Z', '2026-01-07T08:00:00.000Z', '2026-01-12T08:00:00.000Z', '2026-01-14T08:00:00.000Z'],
    },
    {
      name: 'EXDATE removes one instance', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=4', exdates: ['2026-01-02T10:00:00Z'],
      ws: '2026-01-01T00:00:00Z', we: '2026-01-10T00:00:00Z',
      expected: ['2026-01-01T10:00:00.000Z', '2026-01-03T10:00:00.000Z', '2026-01-04T10:00:00.000Z'],
    },
    {
      name: 'instance overlapping the window start is included, one ending at it is not',
      start: '2026-01-01T22:00:00Z', end: '2026-01-02T02:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=5', ws: '2026-01-03T00:00:00Z', we: '2026-01-04T00:00:00Z',
      expected: ['2026-01-02T22:00:00.000Z', '2026-01-03T22:00:00.000Z'],
    },
    {
      name: 'UNTIL is inclusive', start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:30:00Z',
      rrule: 'FREQ=DAILY;UNTIL=20260103T100000Z', ws: '2026-01-01T00:00:00Z', we: '2026-02-01T00:00:00Z',
      expected: ['2026-01-01T10:00:00.000Z', '2026-01-02T10:00:00.000Z', '2026-01-03T10:00:00.000Z'],
    },
  ];
  for (const c of table) {
    const occ = expandOccurrences(
      {
        start: d(c.start), end: d(c.end), allDay: false, tzid: null, rrule: c.rrule,
        exdates: (c.exdates ?? []).map((x) => ({ date: d(x), dateOnly: false, tzid: null })),
      },
      d(c.ws), d(c.we),
    );
    assert.deepEqual(isoList(occ), c.expected, c.name);
    for (const o of occ) assert.equal(o.end.getTime() - o.start.getTime(), d(c.end).getTime() - d(c.start).getTime());
  }
});

test('DST: a weekly 10:00 Europe/Berlin event stays at 10:00 local across the March change', () => {
  const occ = expandOccurrences(
    { start: d('2026-03-19T09:00:00Z'), end: d('2026-03-19T10:00:00Z'), allDay: false, tzid: 'Europe/Berlin', rrule: 'FREQ=WEEKLY;COUNT=3' },
    d('2026-03-01T00:00:00Z'), d('2026-04-30T00:00:00Z'),
  );
  // DST starts 2026-03-29: 19.3. + 26.3. CET (UTC+1), 2.4. CEST (UTC+2)
  assert.deepEqual(isoList(occ), ['2026-03-19T09:00:00.000Z', '2026-03-26T09:00:00.000Z', '2026-04-02T08:00:00.000Z']);
});

test('all-day recurrence is expanded on dates with exclusive ends; EXDATE by date', () => {
  const occ = expandOccurrences(
    {
      start: d('2026-01-01T00:00:00Z'), end: d('2026-01-02T00:00:00Z'), allDay: true, tzid: null,
      rrule: 'FREQ=WEEKLY;COUNT=3', exdates: [{ date: d('2026-01-08T00:00:00Z'), dateOnly: true, tzid: null }],
    },
    d('2025-12-31T23:00:00Z'), d('2026-02-01T00:00:00Z'),
  );
  assert.deepEqual(occ.map((o) => [o.start.toISOString().slice(0, 10), o.end.toISOString().slice(0, 10)]), [
    ['2026-01-01', '2026-01-02'],
    ['2026-01-15', '2026-01-16'],
  ]);
});

test('runaway rules are capped and invalid rules degrade to a single event', () => {
  const capped = expandOccurrences(
    { start: d('2026-01-01T00:00:00Z'), end: d('2026-01-01T00:00:01Z'), allDay: false, tzid: null, rrule: 'FREQ=MINUTELY' },
    d('2026-01-01T00:00:00Z'), d('2026-03-01T00:00:00Z'), { max: 50 },
  );
  assert.equal(capped.length, 50);
  const invalid = expandOccurrences(
    { start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T11:00:00Z'), allDay: false, tzid: null, rrule: 'FREQ=NONSENSE' },
    d('2026-01-01T00:00:00Z'), d('2026-01-02T00:00:00Z'),
  );
  assert.equal(invalid.length, 1);
});

test('expandStoredEvent reads RRULE/EXDATE/TZID from the stored iCal and applies overrides', () => {
  const icalData = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:s', 'DTSTART;TZID=Europe/Berlin:20260105T100000', 'DTEND;TZID=Europe/Berlin:20260105T110000',
    'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;TZID=Europe/Berlin:20260106T100000', 'SUMMARY:Standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID;TZID=Europe/Berlin:20260107T100000',
    'DTSTART;TZID=Europe/Berlin:20260107T140000', 'DTEND;TZID=Europe/Berlin:20260107T150000', 'SUMMARY:Standup (moved)', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const rows = expandStoredEvent(
    { dtStart: d('2026-01-05T09:00:00Z'), dtEnd: d('2026-01-05T10:00:00Z'), allDay: false, recurring: true, rrule: null, icalData },
    d('2026-01-01T00:00:00Z'), d('2026-02-01T00:00:00Z'),
  );
  assert.deepEqual(rows.map((r) => [r.dtStart.toISOString(), r.override?.summary ?? null]), [
    ['2026-01-05T09:00:00.000Z', null],
    ['2026-01-07T13:00:00.000Z', 'Standup (moved)'],
    ['2026-01-08T09:00:00.000Z', null],
  ]);
});

test('expandStoredEvent: non-recurring rows use overlap semantics; REST-built rrule column is honoured', () => {
  const single = { dtStart: d('2026-01-01T23:00:00Z'), dtEnd: d('2026-01-02T01:00:00Z'), allDay: false, recurring: false, rrule: null, icalData: '' };
  assert.equal(expandStoredEvent(single, d('2026-01-02T00:00:00Z'), d('2026-01-03T00:00:00Z')).length, 1);
  assert.equal(expandStoredEvent(single, d('2026-01-02T01:00:00Z'), d('2026-01-03T00:00:00Z')).length, 0);

  const icalData = buildVCalendar({ uid: 'r', summary: 'x', start: '2026-01-01', end: '2026-01-02', allDay: true, rrule: 'FREQ=DAILY;COUNT=2' });
  const rows = expandStoredEvent(
    { dtStart: d('2026-01-01T00:00:00Z'), dtEnd: d('2026-01-02T00:00:00Z'), allDay: true, recurring: true, rrule: 'FREQ=DAILY;COUNT=2', icalData },
    d('2025-12-01T00:00:00Z'), d('2026-02-01T00:00:00Z'),
  );
  assert.deepEqual(rows.map((r) => [r.dtStart.toISOString().slice(0, 10), r.allDay]), [['2026-01-01', true], ['2026-01-02', true]]);
});
