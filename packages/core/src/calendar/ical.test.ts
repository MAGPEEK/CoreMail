import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unfoldLines,
  foldLine,
  escapeText,
  unescapeText,
  parseContentLine,
  parseIcal,
  findMainVEvent,
  parseCalendarObject,
  parseDateString,
  parseDuration,
  buildVCalendar,
  patchVEvent,
  normalizeAllDayRange,
  wallClockToUtcMs,
  utcToWallClockMs,
  getProperty,
} from './ical.js';

const CRLF = '\r\n';

test('unfoldLines joins folded lines (SP and HTAB) and tolerates LF-only input', () => {
  const cases: Array<[string, string[]]> = [
    ['A:1\r\nB:2', ['A:1', 'B:2']],
    ['SUMMARY:Long\r\n  text\r\n\tmore', ['SUMMARY:Long textmore']],
    ['A:1\nB:2\n\n', ['A:1', 'B:2']],
  ];
  for (const [input, expected] of cases) assert.deepEqual(unfoldLines(input), expected);
});

test('foldLine keeps every physical line ≤ 75 octets and never splits UTF-8 characters', () => {
  const inputs = ['SUMMARY:' + 'x'.repeat(200), 'SUMMARY:' + 'ä€😀'.repeat(60), 'SHORT:ok'];
  for (const input of inputs) {
    const folded = foldLine(input);
    for (const physical of folded.split(CRLF)) {
      assert.ok(Buffer.byteLength(physical, 'utf8') <= 75, `too long: ${physical.length}`);
      assert.ok(!physical.includes('�'));
    }
    assert.deepEqual(unfoldLines(folded), [input]);
  }
});

test('escapeText / unescapeText round-trip and neutralise CRLF injection', () => {
  const table: Array<[string, string]> = [
    ['a;b,c\\d', 'a\\;b\\,c\\\\d'],
    ['line1\nline2', 'line1\\nline2'],
    ['evil\r\nATTENDEE:mailto:x@y', 'evil\\nATTENDEE:mailto:x@y'],
  ];
  for (const [raw, escaped] of table) {
    assert.equal(escapeText(raw), escaped);
    assert.ok(!/[\r\n]/.test(escapeText(raw)));
  }
  assert.equal(unescapeText('a\\;b\\,c\\\\d\\nX'), 'a;b,c\\d\nX');
});

test('parseContentLine honours quoted parameter values containing colons', () => {
  const p = parseContentLine('ATTENDEE;CN="Doe, John: CEO";PARTSTAT=ACCEPTED:mailto:john@example.com');
  assert.deepEqual(p, {
    name: 'ATTENDEE',
    params: { CN: 'Doe, John: CEO', PARTSTAT: 'ACCEPTED' },
    value: 'mailto:john@example.com',
  });
});

const VTZ_FIRST = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:abc-123',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20260101T100000',
  'DTEND;TZID=Europe/Berlin:20260101T113000',
  'SUMMARY:Team\\, weekly',
  ' sync',
  'RRULE:FREQ=WEEKLY;BYDAY=TH',
  'EXDATE;TZID=Europe/Berlin:20260108T100000',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join(CRLF);

test('VTIMEZONE-first document: DTSTART is taken from the VEVENT, TZID converted to UTC', () => {
  const parsed = parseCalendarObject(VTZ_FIRST);
  assert.ok(parsed);
  const ev = parsed.main;
  assert.equal(ev.uid, 'abc-123');
  assert.equal(ev.summary, 'Team, weeklysync'); // folded line joined, \, unescaped
  assert.equal(ev.start.toISOString(), '2026-01-01T09:00:00.000Z'); // CET = UTC+1
  assert.equal(ev.end.toISOString(), '2026-01-01T10:30:00.000Z');
  assert.equal(ev.tzid, 'Europe/Berlin');
  assert.equal(ev.allDay, false);
  assert.equal(ev.rrule, 'FREQ=WEEKLY;BYDAY=TH');
  assert.equal(ev.exdates[0]?.date.toISOString(), '2026-01-08T09:00:00.000Z');
});

test('parseDateString: table of value forms', () => {
  const table: Array<[string, string | null, string, boolean]> = [
    ['20260101', null, '2026-01-01T00:00:00.000Z', true],
    ['20260101T100000Z', null, '2026-01-01T10:00:00.000Z', false],
    ['20260101T100000', 'Europe/Berlin', '2026-01-01T09:00:00.000Z', false],
    ['20260701T100000', 'Europe/Berlin', '2026-07-01T08:00:00.000Z', false],
    ['20260701T100000', '/Europe/Berlin', '2026-07-01T08:00:00.000Z', false],
    ['20260701T100000', 'W. Europe Standard Time', '2026-07-01T08:00:00.000Z', false],
    ['20260101T100000', 'America/New_York', '2026-01-01T15:00:00.000Z', false],
    ['20260101T100000', null, '2026-01-01T10:00:00.000Z', false], // floating → UTC
  ];
  for (const [value, tzid, iso, dateOnly] of table) {
    const r = parseDateString(value, tzid);
    assert.ok(r, value);
    assert.equal(r.date.toISOString(), iso, `${value} ${tzid}`);
    assert.equal(r.dateOnly, dateOnly);
  }
});

test('unknown TZID falls back to the VTIMEZONE STANDARD offset instead of Invalid Date', () => {
  const doc = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE', 'TZID:Custom Zone', 'BEGIN:STANDARD', 'TZOFFSETTO:+0300', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=Custom Zone:20260101T100000', 'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
  const ev = parseCalendarObject(doc)!.main;
  assert.equal(ev.start.toISOString(), '2026-01-01T07:00:00.000Z');
});

test('DST: ambiguous wall time → first occurrence, gap → offset before the gap', () => {
  const tz = 'Europe/Berlin';
  // 2026-10-25 02:30 happens twice; first is CEST (UTC+2) → 00:30Z
  assert.equal(new Date(wallClockToUtcMs(Date.UTC(2026, 9, 25, 2, 30), tz)).toISOString(), '2026-10-25T00:30:00.000Z');
  // 2026-03-29 02:30 does not exist; interpreted with CET (+1) → 01:30Z (= 03:30 CEST)
  assert.equal(new Date(wallClockToUtcMs(Date.UTC(2026, 2, 29, 2, 30), tz)).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(new Date(utcToWallClockMs(Date.UTC(2026, 6, 1, 8), tz)).toISOString(), '2026-07-01T10:00:00.000Z');
});

test('all-day: DTEND exclusive, missing DTEND = one day, DURATION honoured', () => {
  const table: Array<[string[], string, string]> = [
    [['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106'], '2026-01-05', '2026-01-06'],
    [['DTSTART;VALUE=DATE:20260105'], '2026-01-05', '2026-01-06'],
    [['DTSTART;VALUE=DATE:20260105', 'DURATION:P3D'], '2026-01-05', '2026-01-08'],
    [['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260105'], '2026-01-05', '2026-01-06'],
  ];
  for (const [lines, s, e] of table) {
    const doc = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(CRLF);
    const ev = parseCalendarObject(doc)!.main;
    assert.equal(ev.allDay, true);
    assert.equal(ev.start.toISOString().slice(0, 10), s);
    assert.equal(ev.end.toISOString().slice(0, 10), e);
  }
  assert.equal(parseDuration('PT1H30M'), 5_400_000);
  assert.equal(parseDuration('P1W'), 7 * 86_400_000);
  assert.equal(parseDuration('-PT15M'), -900_000);
});

test('normalizeAllDayRange: date-only values, inclusive/equal end corrected, no TZ shift', () => {
  const table: Array<[string, string, string, string]> = [
    ['2026-01-05', '2026-01-06', '2026-01-05', '2026-01-06'],
    ['2026-01-05', '2026-01-05', '2026-01-05', '2026-01-06'],
    ['2026-01-05T00:00:00.000Z', '2026-01-07T00:00:00.000Z', '2026-01-05', '2026-01-07'],
    ['20260105', '20260109', '2026-01-05', '2026-01-09'],
  ];
  for (const [s, e, es, ee] of table) {
    const r = normalizeAllDayRange(s, e);
    assert.equal(r.start.toISOString(), `${es}T00:00:00.000Z`);
    assert.equal(r.end.toISOString(), `${ee}T00:00:00.000Z`);
  }
});

test('buildVCalendar: UID, DTSTAMP, exclusive all-day DTEND, escaping, folding, no injection', () => {
  const ics = buildVCalendar({
    uid: 'u1@example.com',
    dtstamp: new Date('2026-01-01T00:00:00Z'),
    summary: 'Hello\r\nATTENDEE:mailto:evil@x.com',
    description: 'a;b,c ' + 'long '.repeat(40),
    location: 'Room 1, Floor 2',
    start: '2026-02-01',
    end: '2026-02-01',
    allDay: true,
    rrule: 'FREQ=WEEKLY;COUNT=3\r\nX-EVIL:1',
    classification: 'PRIVATE',
  });
  const lines = unfoldLines(ics);
  assert.ok(lines.includes('UID:u1@example.com'));
  assert.ok(lines.includes('DTSTAMP:20260101T000000Z'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20260201'));
  assert.ok(lines.includes('DTEND;VALUE=DATE:20260202'));
  assert.ok(lines.includes('CLASS:PRIVATE'));
  assert.ok(lines.includes('LOCATION:Room 1\\, Floor 2'));
  assert.equal(lines.filter((l) => l.startsWith('ATTENDEE')).length, 0, 'CRLF in SUMMARY must not create a property');
  assert.ok(!lines.some((l) => l.startsWith('X-EVIL')));
  for (const physical of ics.split(CRLF)) assert.ok(Buffer.byteLength(physical) <= 75);
  const ev = parseCalendarObject(ics)!.main;
  assert.equal(ev.summary, 'Hello\nATTENDEE:mailto:evil@x.com');
  assert.equal(ev.allDay, true);
});

test('buildVCalendar: timed values in UTC', () => {
  const ics = buildVCalendar({ uid: 'u2', summary: 's', start: new Date('2026-03-01T09:15:00Z'), end: new Date('2026-03-01T10:00:00Z') });
  const lines = unfoldLines(ics);
  assert.ok(lines.includes('DTSTART:20260301T091500Z'));
  assert.ok(lines.includes('DTEND:20260301T100000Z'));
});

test('patchVEvent preserves RRULE, EXDATE, VALARM, VTIMEZONE and keeps the TZID of a timed event', () => {
  const patched = patchVEvent(VTZ_FIRST, {
    summary: 'Renamed',
    start: new Date('2026-01-01T10:00:00Z'), // 11:00 Berlin
    end: new Date('2026-01-01T11:00:00Z'),
    dtstamp: new Date('2026-02-02T00:00:00Z'),
  })!;
  const root = parseIcal(patched)!;
  assert.ok(root.components.some((c) => c.name === 'VTIMEZONE'));
  const ev = findMainVEvent(root)!;
  assert.equal(getProperty(ev, 'SUMMARY')?.value, 'Renamed');
  assert.equal(getProperty(ev, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=TH');
  assert.ok(getProperty(ev, 'EXDATE'));
  assert.ok(ev.components.some((c) => c.name === 'VALARM'));
  assert.deepEqual(getProperty(ev, 'DTSTART'), { name: 'DTSTART', params: { TZID: 'Europe/Berlin' }, value: '20260101T110000' });
  assert.equal(getProperty(ev, 'UID')?.value, 'abc-123');
  assert.equal(getProperty(ev, 'DTSTAMP')?.value, '20260202T000000Z');
});

test('patchVEvent switches to all-day and back, removes RRULE on null, edits attendees', () => {
  const base = buildVCalendar({
    uid: 'p1', summary: 'x', start: new Date('2026-01-01T10:00:00Z'), end: new Date('2026-01-01T11:00:00Z'),
    rrule: 'FREQ=DAILY;COUNT=2',
    attendees: [{ email: 'a@example.com', cn: 'A' }],
  });
  const allDay = patchVEvent(base, { allDay: true, start: '2026-01-03', end: '2026-01-04', rrule: null, attendees: [{ email: 'a@example.com', partstat: 'ACCEPTED' }, { email: 'b@example.com' }] })!;
  const ev = parseCalendarObject(allDay)!.main;
  assert.equal(ev.allDay, true);
  assert.equal(ev.start.toISOString(), '2026-01-03T00:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-01-04T00:00:00.000Z');
  assert.equal(ev.rrule, null);
  assert.deepEqual(ev.attendees.map((a) => [a.email, a.partstat, a.cn ?? null]), [
    ['a@example.com', 'ACCEPTED', 'A'],
    ['b@example.com', 'NEEDS-ACTION', null],
  ]);
  assert.equal(patchVEvent('garbage', { summary: 'x' }), null);
});

test('parseCalendarObject returns overrides (RECURRENCE-ID) separately from the master', () => {
  const doc = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID:20260102T100000Z', 'DTSTART:20260102T120000Z', 'DTEND:20260102T130000Z', 'SUMMARY:moved', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s', 'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:master', 'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
  const parsed = parseCalendarObject(doc)!;
  assert.equal(parsed.main.summary, 'master');
  assert.equal(parsed.overrides.length, 1);
  assert.equal(parsed.overrides[0]?.recurrenceId?.date.toISOString(), '2026-01-02T10:00:00.000Z');
});

test('custom VTIMEZONE without IANA id: DAYLIGHT/STANDARD yearly rules are evaluated (summer offset)', () => {
  const doc = (dt: string) => [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE', 'TZID:My Office Zone',
    'BEGIN:DAYLIGHT', 'DTSTART:19810329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:19961027T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:x', `DTSTART;TZID=My Office Zone:${dt}`, 'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
  assert.equal(parseCalendarObject(doc('20260701T100000'))!.main.start.toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(parseCalendarObject(doc('20260115T100000'))!.main.start.toISOString(), '2026-01-15T09:00:00.000Z');
  // 2026: DST starts Sun 29 March 02:00, ends Sun 25 October 03:00
  assert.equal(parseCalendarObject(doc('20260329T030000'))!.main.start.toISOString(), '2026-03-29T01:00:00.000Z');
  assert.equal(parseCalendarObject(doc('20261025T040000'))!.main.start.toISOString(), '2026-10-25T03:00:00.000Z');
  // US-style "second Sunday" written with BYMONTHDAY
  const us = doc('20260310T120000')
    .replace('BYMONTH=3;BYDAY=-1SU', 'BYMONTH=3;BYDAY=SU;BYMONTHDAY=8,9,10,11,12,13,14');
  assert.equal(parseCalendarObject(us)!.main.start.toISOString(), '2026-03-10T10:00:00.000Z');
});

test('buildVCalendar writes RECURRENCE-ID for an instance', () => {
  const ics = buildVCalendar({ uid: 'u', summary: 's', start: new Date('2026-01-08T09:00:00Z'), end: new Date('2026-01-08T10:00:00Z'),
    recurrenceId: { date: new Date('2026-01-08T09:00:00Z'), dateOnly: false } });
  assert.match(ics, /^RECURRENCE-ID:20260108T090000Z$/m);
});