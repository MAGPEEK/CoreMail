/**
 * 9.4: single-occurrence edits/deletes, show-as and reminders on stored calendar objects.
 * Run: node --import tsx --test src/calendar/exceptions.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVCalendar, parseCalendarObject, patchVEvent } from './ical.js';
import { excludeOccurrence, isSeriesOccurrence, upsertOccurrence } from './exceptions.js';
import { expandStoredEvent } from './recurrence.js';

const d = (iso: string): Date => new Date(iso);

const CRLF = '\r\n';
/** Weekly 10:00 Europe/Berlin series starting before the March DST change. */
const ZONED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VEVENT', 'UID:zoned@test', 'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20260319T100000', 'DTEND;TZID=Europe/Berlin:20260319T110000',
  'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Jour fixe', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:x', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', '',
].join(CRLF);

const stored = (ical: string) => ({ dtStart: d('2026-03-19T09:00:00Z'), dtEnd: d('2026-03-19T10:00:00Z'), allDay: false, recurring: true, rrule: 'FREQ=WEEKLY;COUNT=4', icalData: ical });
const window = [d('2026-03-01T00:00:00Z'), d('2026-05-01T00:00:00Z')] as const;

test('isSeriesOccurrence: generated instances yes, other instants and non-series no', () => {
  assert.equal(isSeriesOccurrence(ZONED, d('2026-04-02T08:00:00Z')), true); // after DST: 10:00 CEST
  assert.equal(isSeriesOccurrence(ZONED, d('2026-04-02T09:00:00Z')), false);
  assert.equal(isSeriesOccurrence(ZONED, d('2026-04-16T08:00:00Z')), false); // beyond COUNT
  const single = buildVCalendar({ uid: 's', summary: 's', start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T11:00:00Z') });
  assert.equal(isSeriesOccurrence(single, d('2026-01-01T10:00:00Z')), false);
});

test('excludeOccurrence: EXDATE in the master TZID form, idempotent, instance gone after DST', () => {
  const once = excludeOccurrence(ZONED, d('2026-04-02T08:00:00Z'))!;
  assert.match(once, /EXDATE;TZID=Europe\/Berlin:20260402T100000/);
  const twice = excludeOccurrence(once, d('2026-04-02T08:00:00Z'))!;
  assert.equal(twice.match(/EXDATE/g)?.length, 1);
  const starts = expandStoredEvent(stored(twice), ...window).map((i) => i.dtStart.toISOString());
  assert.deepEqual(starts, ['2026-03-19T09:00:00.000Z', '2026-03-26T09:00:00.000Z', '2026-04-09T08:00:00.000Z']);
});

test('upsertOccurrence: override with RECURRENCE-ID, moved time and subject; master untouched', () => {
  const changed = upsertOccurrence(ZONED, d('2026-03-26T09:00:00Z'), {
    summary: 'Verschoben', start: d('2026-03-26T13:00:00Z'), end: d('2026-03-26T14:00:00Z'), showAs: 'TENTATIVE',
  })!;
  const parsed = parseCalendarObject(changed)!;
  assert.equal(parsed.main.summary, 'Jour fixe');
  assert.equal(parsed.main.rrule, 'FREQ=WEEKLY;COUNT=4');
  assert.equal(parsed.overrides.length, 1);
  const o = parsed.overrides[0]!;
  assert.equal(o.recurrenceId!.date.toISOString(), '2026-03-26T09:00:00.000Z');
  assert.equal(o.start.toISOString(), '2026-03-26T13:00:00.000Z');
  assert.equal(o.summary, 'Verschoben');
  assert.equal(o.rrule, null);
  assert.equal(o.showAs, 'TENTATIVE');
  assert.match(changed, /RECURRENCE-ID;TZID=Europe\/Berlin:20260326T100000/);
  const inst = expandStoredEvent(stored(changed), ...window);
  assert.deepEqual(inst.map((i) => [i.dtStart.toISOString(), i.override?.summary ?? null]), [
    ['2026-03-19T09:00:00.000Z', null],
    ['2026-03-26T13:00:00.000Z', 'Verschoben'],
    ['2026-04-02T08:00:00.000Z', null],
    ['2026-04-09T08:00:00.000Z', null],
  ]);
  // a second edit of the same occurrence patches the existing override
  const again = upsertOccurrence(changed, d('2026-03-26T09:00:00Z'), { location: 'Raum 2' })!;
  const reparsed = parseCalendarObject(again)!;
  assert.equal(reparsed.overrides.length, 1);
  assert.equal(reparsed.overrides[0]!.location, 'Raum 2');
  assert.equal(reparsed.overrides[0]!.summary, 'Verschoben');
  // deleting the overridden occurrence drops the override and adds the EXDATE
  const removed = excludeOccurrence(again, d('2026-03-26T09:00:00Z'))!;
  assert.equal(parseCalendarObject(removed)!.overrides.length, 0);
  assert.equal(expandStoredEvent(stored(removed), ...window).length, 3);
});

test('upsertOccurrence refuses an instant that is not an occurrence', () => {
  assert.equal(upsertOccurrence(ZONED, d('2026-03-27T09:00:00Z'), { summary: 'x' }), null);
});

test('all-day series: EXDATE and RECURRENCE-ID as dates', () => {
  const allDay = buildVCalendar({ uid: 'a', summary: 'Urlaub', start: '2026-07-06', end: '2026-07-07', allDay: true, rrule: 'FREQ=DAILY;COUNT=5' });
  const ex = excludeOccurrence(allDay, d('2026-07-08T00:00:00Z'))!;
  assert.match(ex, /EXDATE;VALUE=DATE:20260708/);
  const ov = upsertOccurrence(allDay, d('2026-07-09T00:00:00Z'), { summary: 'Halber Tag' })!;
  assert.match(ov, /RECURRENCE-ID;VALUE=DATE:20260709/);
});

test('review: floating series keep floating EXDATE / RECURRENCE-ID; UTC series stay UTC', () => {
  const floating = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    'BEGIN:VEVENT', 'UID:float@test', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260601T090000', 'DTEND:20260601T100000',
    'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Float', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join(CRLF);
  const ex = excludeOccurrence(floating, d('2026-06-02T09:00:00Z'))!;
  assert.match(ex, /\r\nEXDATE:20260602T090000\r\n/);
  const ov = upsertOccurrence(floating, d('2026-06-03T09:00:00Z'), { summary: 'x' })!;
  assert.match(ov, /\r\nRECURRENCE-ID:20260603T090000\r\n/);
  assert.equal(isSeriesOccurrence(ex, d('2026-06-02T09:00:00Z')), false, 'the floating EXDATE removes the instance');
  const utc = buildVCalendar({ uid: 'u', summary: 'u', start: d('2026-06-01T09:00:00Z'), end: d('2026-06-01T10:00:00Z'), rrule: 'FREQ=DAILY;COUNT=3' });
  assert.match(excludeOccurrence(utc, d('2026-06-02T09:00:00Z'))!, /EXDATE:20260602T090000Z/);
});

test('show-as and reminders: build, parse, patch (TRANSP + busy status, VALARM display/e-mail)', () => {
  const ics = buildVCalendar({
    uid: 'u', summary: 'Fokuszeit', start: d('2026-01-05T08:00:00Z'), end: d('2026-01-05T10:00:00Z'),
    showAs: 'FREE', alarm: { minutes: 30, byMail: true, mailTo: 'owner@example.com' },
  });
  assert.match(ics, /TRANSP:TRANSPARENT/);
  assert.match(ics, /X-MICROSOFT-CDO-BUSYSTATUS:FREE/);
  assert.match(ics, /ACTION:EMAIL/);
  assert.match(ics, /ATTENDEE:mailto:owner@example.com/);
  const parsed = parseCalendarObject(ics)!.main;
  assert.equal(parsed.showAs, 'FREE');
  assert.deepEqual(parsed.alarm, { minutes: 30, byMail: true });

  const patched = patchVEvent(ics, { showAs: 'OOF', alarm: { minutes: 1440 } })!;
  const p2 = parseCalendarObject(patched)!.main;
  assert.equal(p2.showAs, 'OOF');
  assert.match(patched, /TRANSP:OPAQUE/);
  assert.deepEqual(p2.alarm, { minutes: 1440, byMail: false });
  assert.equal(parseCalendarObject(patchVEvent(patched, { alarm: null })!)!.main.alarm, null);
});

test('show-as fallback: TRANSP only (CalDAV clients), unknown values are busy', () => {
  const base = buildVCalendar({ uid: 'u', summary: 's', start: d('2026-01-05T08:00:00Z'), end: d('2026-01-05T09:00:00Z') });
  assert.equal(parseCalendarObject(base)!.main.showAs, 'BUSY');
  const transparent = base.replace('SUMMARY:s', 'SUMMARY:s\r\nTRANSP:TRANSPARENT');
  assert.equal(parseCalendarObject(transparent)!.main.showAs, 'FREE');
  const elsewhere = base.replace('SUMMARY:s', 'SUMMARY:s\r\nX-MICROSOFT-CDO-BUSYSTATUS:WORKINGELSEWHERE');
  assert.equal(parseCalendarObject(elsewhere)!.main.showAs, 'BUSY');
});
