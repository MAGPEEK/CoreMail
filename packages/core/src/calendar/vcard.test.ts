import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countVcards, parseVcard, serializeVcard, splitStructured, vcardProperty, vcardUid } from './vcard.js';
import { expandCalendarData, eventOverlapsRange, limitRecurrenceSet } from './recurrence.js';

const CARD = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:urn:uuid:keep-me', 'FN:Jane Doe', 'N:Doe;Jane;;Dr.;',
  'item1.EMAIL;TYPE=INTERNET,pref:jane@example.com', 'item1.X-ABLabel:Work',
  'TEL;TYPE=WORK;TYPE=VOICE:+49 30 1', 'TEL;TYPE=CELL:+49 170 2',
  'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC',
  'ORG:ACME\\; Inc;Sales;EMEA', 'NOTE:line1\\nline2', 'X-CUSTOM;FOO="a:b":value', 'END:VCARD', '',
].join('\r\n');

// 9.5: the field mapping and patching moved to @coremail/storage contacts/ (tested there)
test('parseVcard: groups, TYPE lists, quoted parameters; serializeVcard writes the source lines back', () => {
  const doc = parseVcard(CARD)!;
  const email = doc.properties.find((p) => p.name === 'EMAIL')!;
  assert.deepEqual([email.group, email.types, email.value], ['ITEM1', ['INTERNET', 'PREF'], 'jane@example.com']);
  assert.deepEqual(doc.properties.find((p) => p.name === 'TEL')!.types, ['WORK', 'VOICE']);
  assert.equal(doc.properties.find((p) => p.name === 'X-CUSTOM')!.params['FOO'], 'a:b');
  assert.deepEqual(splitStructured(doc.properties.find((p) => p.name === 'ORG')!.value), ['ACME\\; Inc', 'Sales', 'EMEA']);
  assert.equal(serializeVcard(doc), CARD);
  assert.equal(vcardProperty('item2.URL;type=pref:https://x.example')!.group, 'ITEM2');
  assert.equal(vcardUid(CARD), 'urn:uuid:keep-me');
  assert.equal(countVcards(CARD + CARD), 2);
  assert.equal(parseVcard('nothing'), null);
});

const SERIES = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:s1', 'DTSTART;TZID=Europe/Berlin:20260326T100000', 'DTEND;TZID=Europe/Berlin:20260326T110000',
  'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;TZID=Europe/Berlin:20260327T100000', 'SUMMARY:Daily', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID;TZID=Europe/Berlin:20260330T100000', 'DTSTART;TZID=Europe/Berlin:20260330T150000',
  'DTEND;TZID=Europe/Berlin:20260330T160000', 'SUMMARY:Moved', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

test('expandCalendarData: UTC instances across DST, EXDATE skipped, override used, no RRULE/VTIMEZONE', () => {
  const out = expandCalendarData(SERIES, new Date('2026-03-26T00:00:00Z'), new Date('2026-04-01T00:00:00Z'))!;
  assert.doesNotMatch(out, /RRULE|EXDATE|VTIMEZONE|TZID/);
  const rids = [...out.matchAll(/^RECURRENCE-ID:(\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(rids, ['20260326T090000Z', '20260328T090000Z', '20260329T080000Z', '20260330T080000Z']);
  assert.match(out, /DTSTART:20260330T130000Z\r\nDTEND:20260330T140000Z\r\nRECURRENCE-ID:20260330T080000Z/);
  assert.equal(expandCalendarData(SERIES, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-02T00:00:00Z')), null);
});

test('limitRecurrenceSet keeps the master and only overrides in range; eventOverlapsRange checks instances', () => {
  assert.match(limitRecurrenceSet(SERIES, new Date('2026-03-30T00:00:00Z'), new Date('2026-03-31T00:00:00Z')), /Moved/);
  const limited = limitRecurrenceSet(SERIES, new Date('2026-03-26T00:00:00Z'), new Date('2026-03-27T00:00:00Z'));
  assert.doesNotMatch(limited, /Moved/);
  assert.match(limited, /RRULE:FREQ=DAILY;COUNT=5/);
  const row = { dtStart: new Date('2026-03-26T09:00:00Z'), dtEnd: new Date('2026-03-26T10:00:00Z'), allDay: false, recurring: true, rrule: 'FREQ=DAILY;COUNT=5', icalData: SERIES };
  assert.equal(eventOverlapsRange(row, new Date('2026-03-28T00:00:00Z'), new Date('2026-03-29T00:00:00Z')), true);
  assert.equal(eventOverlapsRange(row, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-02T00:00:00Z')), false);
});