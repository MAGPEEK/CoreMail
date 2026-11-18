/**
 * 9.4 review: iMIP for one occurrence of a series — RECURRENCE-ID in the form of
 * DTSTART (DATE for all-day series, UTC date-time otherwise), EXDATE lines.
 * Run: node --import tsx --test src/lib/imip-occurrence.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

import type { EventData } from './imip.js';
// imip.js pulls in @coremail/core, which validates the env at import time
const { buildCancelIcs, buildRequestIcs, recurrenceLines } = await import('./imip.js');

const unfold = (ics: string): string => ics.replace(/\r?\n[ \t]/g, '');

const base: EventData = {
  uid: 'series@example.com', sequence: 2, summary: 'Teamtag',
  dtStart: new Date('2026-11-20T00:00:00Z'), dtEnd: new Date('2026-11-21T00:00:00Z'),
  organizer: { email: 'alice@example.com' }, attendees: [{ email: 'bob@example.com' }], publicHostname: 'mail.example.com',
};

test('all-day occurrence: RECURRENCE-ID;VALUE=DATE, no date-time, DTSTART stays a date', () => {
  for (const ics of [
    buildRequestIcs({ ...base, allDay: true, rrule: 'FREQ=WEEKLY', recurrenceId: new Date('2026-11-20T00:00:00Z') }),
    buildCancelIcs({ ...base, allDay: true, rrule: 'FREQ=WEEKLY', recurrenceId: new Date('2026-11-20T00:00:00Z') }),
  ]) {
    const text = unfold(ics);
    assert.match(text, /\r\nRECURRENCE-ID;VALUE=DATE:20261120\r\nEND:VEVENT/);
    assert.equal((text.match(/^RECURRENCE-ID/gm) ?? []).length, 1);
    assert.doesNotMatch(text, /RECURRENCE-ID[^\r\n]*T\d{6}/);
    assert.match(text, /DTSTART;VALUE=DATE:20261120/);
    assert.doesNotMatch(text, /^RRULE/m, 'an occurrence carries no RRULE');
  }
});

test('timed occurrence: RECURRENCE-ID as UTC date-time', () => {
  const text = unfold(buildRequestIcs({
    ...base, dtStart: new Date('2026-11-20T09:00:00Z'), dtEnd: new Date('2026-11-20T10:00:00Z'),
    rrule: 'FREQ=WEEKLY', recurrenceId: new Date('2026-11-20T09:00:00Z'),
  }));
  assert.match(text, /^RECURRENCE-ID:20261120T090000Z$/m);
  assert.doesNotMatch(text, /VALUE=DATE/);
});

test('recurrenceLines: EXDATE as dates for all-day series, UTC otherwise', () => {
  const ex = [new Date('2026-11-27T00:00:00Z')];
  assert.equal(recurrenceLines({ rrule: 'FREQ=WEEKLY', exdates: ex, allDay: true }), 'RRULE:FREQ=WEEKLY\nEXDATE;VALUE=DATE:20261127');
  assert.equal(recurrenceLines({ rrule: 'RRULE:FREQ=WEEKLY', exdates: ex }), 'RRULE:FREQ=WEEKLY\nEXDATE:20261127T000000Z');
});
