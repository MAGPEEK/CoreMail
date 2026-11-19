/**
 * w3: Calendar class codec ([MS-ASCAL]) — client WBXML written with the [MS-ASWBXML] code
 * page 4 tokens, byte fixtures of server elements, and the round trip of a recurring
 * meeting with exceptions across a daylight-saving change:
 * device Add → stored calendar object → Sync Add → device Change (echo) → unchanged object.
 * Run: node --import tsx --test src/pim/calendar-codec.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendarObject } from '@coremail/core/calendar';
import { expandStoredEvent } from '@coremail/core/recurrence';
import { clientWbxml, wbxmlTags, type WNode } from '../test-support/fake-db.js';
import { decodeWbxml, encodeWbxml, el, pel, tagsNewerThan, CP, type WbxmlElement } from '../wbxml.js';
import { DEFAULT_BODY_PREFERENCE } from '../commands/body.js';
import { parseCalendar, renderCalendar } from './calendar-codec.js';
import { changedEventIcal, newEventIcal, parsedEvent, type CalendarRow } from './calendar-ical.js';
import { calendarRecurrenceElements } from './recurrence.js';
import { decodeTimeZone, encodeTimeZone, timeZoneOf } from './timezone.js';
import { formatCompactDate } from './dates.js';
import type { PimUser, RenderContext, WriteContext } from './types.js';

const USER: PimUser = { id: 'u1', email: 'bob@example.com', displayName: 'Bob B', addresses: ['bob@example.com'], timeZone: 'Europe/Berlin', domainId: null };
const render = (version: '12.1' | '14.1' = '14.1', user = USER): RenderContext => ({ version, bodyPref: DEFAULT_BODY_PREFERENCE, user });
const write = (supported: ReadonlySet<string> | null = null): WriteContext => ({ version: '14.1', user: USER, now: new Date('2026-03-01T00:00:00Z'), supported });

const C = (t: number, k?: WNode[] | string): WNode => [4, t, k];
const B = (t: number, k?: WNode[] | string): WNode => [17, t, k];
const appData = (children: WNode[]): WbxmlElement => decodeWbxml(clientWbxml([0, 0x1d, children]));
const kid = (e: WbxmlElement | undefined, n: string) => e?.children?.find((c): c is WbxmlElement => typeof c !== 'string' && c.name === n);
const kids = (e: WbxmlElement | undefined, n: string) => (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string' && c.name === n);
/** Device time zone without names (as phones send it): matched by its rules. */
const BERLIN = encodeTimeZone({ ...timeZoneOf('Europe/Berlin', 2026), standardName: '', daylightName: '' });

/** A weekly Wednesday meeting at 10:00 Berlin from 18 March, 6 times; 1 April deleted, 25 March moved to 14:00. */
const MEETING: WNode[] = [
  C(0x05, BERLIN), C(0x06, '0'),
  B(0x0a, [B(0x06, '1'), B(0x0b, 'Agenda: Q2')]),
  C(0x0d, '2'), C(0x11, '20260301T120000Z'), C(0x12, '20260318T100000Z'), C(0x17, 'Raum 1'), C(0x24, '15'),
  C(0x25, '0'), C(0x26, 'Jour fixe'), C(0x27, '20260318T090000Z'), C(0x28, 'eas-uid-1@device'), C(0x18, '1'),
  C(0x07, [
    C(0x08, [C(0x09, 'carol@example.com'), C(0x0a, 'Carol'), C(0x2a, '1')]),
    C(0x08, [C(0x09, 'dave@example.com'), C(0x0a, 'Dave'), C(0x2a, '2')]),
  ]),
  C(0x1b, [C(0x1c, '1'), C(0x1f, '1'), C(0x20, '8'), C(0x1e, '6')]),
  C(0x14, [
    C(0x13, [C(0x15, '1'), C(0x16, '20260401T080000Z')]),
    C(0x13, [C(0x16, '20260325T090000Z'), C(0x26, 'Jour fixe (verschoben)'), C(0x27, '20260325T130000Z'), C(0x12, '20260325T140000Z')]),
  ]),
];

const row = (icalData: string, over: Partial<CalendarRow> = {}): CalendarRow => {
  const p = parseCalendarObject(icalData)!.main;
  return {
    id: 'ev1', calendarId: 'cal1', uid: p.uid ?? 'x', icalData, summary: p.summary, description: p.description, location: p.location,
    dtStart: p.start, dtEnd: p.end, allDay: p.allDay, rrule: p.rrule, organizer: p.organizer, attendees: p.attendees,
    classification: p.classification, showAs: p.showAs, status: 'CONFIRMED', sequence: p.sequence ?? 0,
    updatedAt: new Date('2026-03-02T08:00:00Z'), ...over,
  };
};
const instants = (ical: string) => expandStoredEvent(
  { dtStart: new Date(0), dtEnd: new Date(0), allDay: false, recurring: true, rrule: 'x', icalData: ical },
  new Date('2026-03-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'),
).map((i) => `${i.dtStart.toISOString()}${i.override ? ` ${i.override.summary}` : ''}`);

const EXPECTED_INSTANCES = [
  '2026-03-18T09:00:00.000Z',
  '2026-03-25T13:00:00.000Z Jour fixe (verschoben)',
  // 1 April deleted; after the DST change the series stays at 10:00 local = 08:00 UTC
  '2026-04-08T08:00:00.000Z', '2026-04-15T08:00:00.000Z', '2026-04-22T08:00:00.000Z',
];

test('byte fixture: calendar Recurrence on code page 4 ([MS-ASWBXML] tokens 0x1B–0x20)', () => {
  const buf = encodeWbxml(pel(CP.Calendar, 'Recurrence', calendarRecurrenceElements({ type: 1, interval: 1, dayOfWeek: 8, occurrences: 6 }, formatCompactDate, true)));
  const s = (t: string) => [0x03, ...Buffer.from(t), 0x00, 0x01];
  assert.deepEqual([...buf], [0x03, 0x01, 0x6a, 0x00, 0x00, 0x04, 0x5b, 0x5c, ...s('1'), 0x5e, ...s('6'), 0x5f, ...s('1'), 0x60, ...s('8'), 0x01]);
});

test('device Add of a recurring meeting → calendar object: TZID series, EXDATE, moved override, attendees, alarm', () => {
  const input = parseCalendar(appData(MEETING), 'Europe/Berlin');
  assert.equal(input.zone, 'Europe/Berlin');
  const ical = newEventIcal(input, write(), input.uid!)!;
  assert.match(ical, /DTSTART;TZID=Europe\/Berlin:20260318T100000/);
  assert.match(ical, /RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6/);
  assert.match(ical, /EXDATE;TZID=Europe\/Berlin:20260401T100000/);
  assert.match(ical, /RECURRENCE-ID;TZID=Europe\/Berlin:20260325T100000/);
  const parsed = parseCalendarObject(ical)!;
  assert.equal(parsed.main.uid, 'eas-uid-1@device');
  assert.equal(parsed.main.organizer, 'bob@example.com', 'the device user organizes a meeting it creates');
  assert.deepEqual(parsed.main.attendees.map((a) => `${a.email}/${a.role}/${a.cn}`), ['carol@example.com/REQ-PARTICIPANT/Carol', 'dave@example.com/OPT-PARTICIPANT/Dave']);
  assert.deepEqual([parsed.main.alarm?.minutes, parsed.main.showAs, parsed.main.location, parsed.main.description], [15, 'BUSY', 'Raum 1', 'Agenda: Q2']);
  assert.deepEqual(instants(ical), EXPECTED_INSTANCES);
});

test('stored meeting → Sync Add: calendar page properties, exceptions, 14.1 response type; 12.1 without 14.0 tags', () => {
  const ical = newEventIcal(parseCalendar(appData(MEETING), 'Europe/Berlin'), write(), 'eas-uid-1@device')!;
  const props = renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date('2026-03-02T08:00:00Z') }, render());
  const buf = encodeWbxml(el('ApplicationData', undefined, props));
  const tags = wbxmlTags(buf).map(([p, t]) => `${p}:${t.toString(16)}`);
  for (const t of ['4:5', '4:11', '4:27', '4:26', '4:28', '4:1a', '4:19', '4:7', '4:8', '4:29', '4:2a', '4:12', '4:1b', '4:14', '4:13', '4:15', '4:16', '17:a', '4:25', '4:d', '4:6', '4:24', '4:18', '4:36']) {
    assert.ok(tags.includes(t), `tag ${t} missing`);
  }
  assert.deepEqual(tagsNewerThan(buf, '14.1'), []);
  const tree = decodeWbxml(buf);
  const tz = decodeTimeZone(kid(tree, 'TimeZone')!.text!)!;
  assert.deepEqual([tz.bias, tz.daylightBias, tz.daylightDate.month, tz.standardDate.month], [-60, -60, 3, 10]);
  assert.equal(kid(tree, 'StartTime')!.text, '20260318T090000Z');
  const rec = kid(tree, 'Recurrence')!;
  assert.deepEqual(['Type', 'Interval', 'DayOfWeek', 'Occurrences'].map((n) => kid(rec, n)?.text), ['1', '1', '8', '6']);
  const [deleted, moved] = kids(kid(tree, 'Exceptions'), 'Exception');
  assert.deepEqual([kid(deleted, 'Deleted')?.text, kid(deleted, 'ExceptionStartTime')?.text], ['1', '20260401T080000Z']);
  assert.deepEqual(['ExceptionStartTime', 'Subject', 'StartTime', 'EndTime'].map((n) => kid(moved, n)?.text),
    ['20260325T090000Z', 'Jour fixe (verschoben)', '20260325T130000Z', '20260325T140000Z']);
  assert.deepEqual(['MeetingStatus', 'ResponseType', 'Reminder', 'BusyStatus', 'OrganizerEmail'].map((n) => kid(tree, n)?.text), ['1', '1', '15', '2', 'bob@example.com']);
  assert.deepEqual(kids(kid(tree, 'Attendees'), 'Attendee').map((a) => `${kid(a, 'Email')?.text}:${kid(a, 'AttendeeType')?.text}:${kid(a, 'AttendeeStatus')?.text}`),
    ['carol@example.com:1:5', 'dave@example.com:2:5']);

  const old = encodeWbxml(el('ApplicationData', undefined, renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date() }, render('12.1'))));
  assert.deepEqual(tagsNewerThan(old, '12.1'), []);
  assert.equal(kid(decodeWbxml(old), 'ResponseType'), undefined);
});

test('round trip: the device echoes the item back as a Change → the calendar object keeps its series and exceptions', () => {
  const ical = newEventIcal(parseCalendar(appData(MEETING), 'Europe/Berlin'), write(), 'eas-uid-1@device')!;
  const stored = row(ical);
  const echoed = el('ApplicationData', undefined, renderCalendar({ ...parsedEvent(stored), updatedAt: stored.updatedAt }, render()));
  const again = decodeWbxml(encodeWbxml(echoed));
  const changed = changedEventIcal(stored, parseCalendar(again, 'Europe/Berlin'), write());
  assert.deepEqual(instants(changed), EXPECTED_INSTANCES);
  const p = parseCalendarObject(changed)!;
  assert.equal(p.main.rrule, 'FREQ=WEEKLY;BYDAY=WE;COUNT=6');
  assert.equal(p.main.sequence, 0, 'nothing changed → no new sequence');
  assert.deepEqual(p.main.attendees.map((a) => a.email), ['carol@example.com', 'dave@example.com']);

  // the device moves the series to 11:00 and drops the deleted-instance exception
  const moved = appData([...MEETING.filter((n) => n[1] !== 0x27 && n[1] !== 0x12 && n[1] !== 0x14),
    C(0x27, '20260318T100000Z'), C(0x12, '20260318T110000Z'),
    C(0x14, [C(0x13, [C(0x16, '20260325T100000Z'), C(0x26, 'Jour fixe (verschoben)'), C(0x27, '20260325T130000Z'), C(0x12, '20260325T140000Z')])]),
  ]);
  const series = changedEventIcal(row(changed), parseCalendar(moved, 'Europe/Berlin'), write());
  assert.equal(parseCalendarObject(series)!.main.sequence, 1, 'a moved meeting gets a new sequence');
  assert.equal(parseCalendarObject(series)!.main.exdates.length, 0, '1 April restored');
});

test('device Change: absent elements are cleared unless the client ghosts them (airsync:Supported)', () => {
  const ical = newEventIcal(parseCalendar(appData(MEETING), 'Europe/Berlin'), write(), 'u@x')!;
  const minimal = appData([C(0x05, BERLIN), C(0x06, '0'), C(0x26, 'Jour fixe'), C(0x27, '20260318T090000Z'), C(0x12, '20260318T100000Z')]);
  const cleared = parseCalendarObject(changedEventIcal(row(ical), parseCalendar(minimal, 'Europe/Berlin'), write()))!.main;
  assert.deepEqual([cleared.location, cleared.alarm, cleared.attendees.length, cleared.rrule], ['', null, 0, null]);
  const ghosted = parseCalendarObject(changedEventIcal(row(ical), parseCalendar(minimal, 'Europe/Berlin'),
    write(new Set(['Subject', 'StartTime', 'EndTime']))))!.main;
  assert.deepEqual([ghosted.location, ghosted.alarm?.minutes, ghosted.attendees.length, ghosted.rrule], ['Raum 1', 15, 2, 'FREQ=WEEKLY;BYDAY=WE;COUNT=6']);
});

test('a stored rule without an ActiveSync form survives a device change without Recurrence', () => {
  const ical = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:odd@x', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5,20', 'SUMMARY:Abrechnung', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const sent = decodeWbxml(encodeWbxml(el('ApplicationData', undefined, renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date() }, render()))));
  assert.equal(kid(sent, 'Recurrence'), undefined);
  const kept = changedEventIcal(row(ical), parseCalendar(sent, null), write());
  assert.equal(parseCalendarObject(kept)!.main.rrule, 'FREQ=MONTHLY;BYMONTHDAY=5,20');
});

test('all-day: device midnight in its zone → date; sent as midnight in the user zone (UTC without one)', () => {
  const allDay = appData([C(0x05, BERLIN), C(0x06, '1'), C(0x26, 'Urlaub'), C(0x27, '20261124T230000Z'), C(0x12, '20261126T230000Z')]);
  const ical = newEventIcal(parseCalendar(allDay, null), write(), 'ad@x')!;
  assert.match(ical, /DTSTART;VALUE=DATE:20261125/);
  assert.match(ical, /DTEND;VALUE=DATE:20261127/);
  const berlin = decodeWbxml(encodeWbxml(el('ApplicationData', undefined, renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date() }, render()))));
  assert.deepEqual(['AllDayEvent', 'StartTime', 'EndTime'].map((n) => kid(berlin, n)?.text), ['1', '20261124T230000Z', '20261126T230000Z']);
  const utc = decodeWbxml(encodeWbxml(el('ApplicationData', undefined,
    renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date() }, render('14.1', { ...USER, timeZone: null })))));
  assert.equal(kid(utc, 'StartTime')?.text, '20261125T000000Z');
  assert.equal(decodeTimeZone(kid(utc, 'TimeZone')!.text!)!.bias, 0);
});

test('received meeting: MeetingStatus 3, ResponseType from the own attendee, organizer of the invitation', () => {
  const ical = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:inv@ext.test', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'SUMMARY:Kickoff', 'ORGANIZER;CN=Olga:mailto:olga@ext.test',
    'ATTENDEE;PARTSTAT=TENTATIVE;RSVP=TRUE:mailto:bob@example.com', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const tree = decodeWbxml(encodeWbxml(el('ApplicationData', undefined, renderCalendar({ ...parsedEvent(row(ical)), updatedAt: new Date() }, render()))));
  assert.deepEqual(['MeetingStatus', 'ResponseType', 'ResponseRequested', 'OrganizerEmail', 'OrganizerName'].map((n) => kid(tree, n)?.text),
    ['3', '2', '1', 'olga@ext.test', 'olga@ext.test']);
});
