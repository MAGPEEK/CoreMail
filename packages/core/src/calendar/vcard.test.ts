import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVcard, countVcards, parseVcard, patchVcard, structuredName, vcardFields, vcardUid } from './vcard.js';
import { expandCalendarData, eventOverlapsRange, limitRecurrenceSet } from './recurrence.js';

const CARD = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:urn:uuid:keep-me', 'FN:Jane Doe', 'N:Doe;Jane;;Dr.;',
  'item1.EMAIL;TYPE=INTERNET,pref:jane@example.com', 'item1.X-ABLabel:Work',
  'TEL;TYPE=WORK;TYPE=VOICE:+49 30 1', 'TEL;TYPE=CELL:+49 170 2',
  'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC',
  'ORG:ACME\\; Inc;Sales;EMEA', 'NOTE:line1\\nline2', 'X-CUSTOM;FOO="a:b":value', 'END:VCARD', '',
].join('\r\n');

test('vcardFields reads every indexed column (groups, TYPE lists, escaping)', () => {
  assert.deepEqual(vcardFields(CARD), {
    displayName: 'Jane Doe', email: 'jane@example.com', email2: '', phone: '+49 30 1', mobile: '+49 170 2',
    company: 'ACME; Inc', department: 'Sales', jobTitle: '', notes: 'line1\nline2',
  });
  assert.equal(vcardUid(CARD), 'urn:uuid:keep-me');
  assert.equal(countVcards(CARD + CARD), 2);
  assert.equal(parseVcard('nothing'), null);
});

test('patchVcard rewrites only the changed fields and keeps every other property verbatim', () => {
  const out = patchVcard(CARD, { displayName: 'Jane Q. Public', email: 'jq@example.com', mobile: '', department: 'R&D', jobTitle: 'CTO, Ops; Lead\nX-EVIL:1' });
  const lines = out.replace(/\r\n /g, '').split('\r\n');
  for (const kept of ['UID:urn:uuid:keep-me', 'item1.X-ABLabel:Work', 'TEL;TYPE=WORK;TYPE=VOICE:+49 30 1',
    'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC', 'NOTE:line1\\nline2', 'X-CUSTOM;FOO="a:b":value']) {
    assert.ok(lines.includes(kept), `lost ${kept}`);
  }
  assert.ok(lines.includes('FN:Jane Q. Public'));
  assert.ok(lines.includes('N:Public;Jane Q.;;;'));
  assert.ok(lines.includes('item1.EMAIL;TYPE=INTERNET,pref:jq@example.com'), 'group + parameters kept');
  assert.ok(lines.includes('ORG:ACME\\; Inc;R&D;EMEA'));
  assert.ok(!lines.some((l) => l.startsWith('TEL;TYPE=CELL')), 'emptied field removed');
  assert.ok(lines.includes('TITLE:CTO\\, Ops\\; Lead\\nX-EVIL:1'), 'escaped, no property injection');
  assert.ok(!lines.some((l) => l.startsWith('X-EVIL')));
  assert.equal(vcardFields(out).jobTitle, 'CTO, Ops; Lead\nX-EVIL:1');
});

test('buildVcard: escaped FN, structured N (family;given;;;) and a UID', () => {
  const v = buildVcard({ displayName: 'Anna Maria, von Berg', email: 'a@example.com', phone: '1', mobile: '2', company: 'X;Y' });
  const f = vcardFields(v);
  assert.equal(f.displayName, 'Anna Maria, von Berg');
  assert.equal(f.company, 'X;Y');
  assert.deepEqual([f.phone, f.mobile], ['1', '2']);
  assert.match(v, /^N:Berg;Anna Maria\\, von;;;$/m);
  assert.ok(vcardUid(v)?.startsWith('urn:uuid:'));
  assert.equal(structuredName('Cher'), 'Cher;;;;');
  assert.equal(countVcards(v), 1);
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