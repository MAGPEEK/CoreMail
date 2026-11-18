/**
 * w3: ActiveSync Recurrence ([MS-ASCAL] / [MS-ASTASK]) ↔ RRULE.
 * Run: node --import tsx --test src/pim/recurrence.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easToRrule, isRepresentable, parseRecurrence, rruleToEas, LAST_DAY_OF_MONTH, type EasRecurrence } from './recurrence.js';
import { decodeWbxml } from '../wbxml.js';
import { clientWbxml } from '../test-support/fake-db.js';
import { parseEasDate } from './dates.js';

/** Thursday 2026-11-19 10:00 (wall clock). */
const START = new Date('2026-11-19T10:00:00Z');
const until = (raw: string) => parseEasDate(raw.replace(/^(\d{8})$/, '$1T000000Z'));
const toEas = (rrule: string) => rruleToEas(rrule, START, until);
const back = (r: EasRecurrence) => easToRrule(r, (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));

test('RRULE → Recurrence: the six ActiveSync types, implicit values from DTSTART', () => {
  assert.deepEqual(toEas('FREQ=DAILY;INTERVAL=2;COUNT=5'), { type: 0, interval: 2, occurrences: 5 });
  assert.deepEqual(toEas('FREQ=WEEKLY'), { type: 1, interval: 1, dayOfWeek: 16 }, 'Thursday from DTSTART');
  assert.deepEqual(toEas('FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=MO'), { type: 1, interval: 1, dayOfWeek: 2 | 8 | 32, firstDayOfWeek: 1 });
  assert.deepEqual(toEas('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'), { type: 1, interval: 1, dayOfWeek: 62 }, 'every weekday');
  assert.deepEqual(toEas('FREQ=MONTHLY'), { type: 2, interval: 1, dayOfMonth: 19 });
  assert.deepEqual(toEas('FREQ=MONTHLY;BYMONTHDAY=3;UNTIL=20271231T235959Z'),
    { type: 2, interval: 1, dayOfMonth: 3, until: new Date('2027-12-31T23:59:59Z') });
  assert.deepEqual(toEas('FREQ=MONTHLY;BYDAY=2TU'), { type: 3, interval: 1, weekOfMonth: 2, dayOfWeek: 4 });
  assert.deepEqual(toEas('FREQ=MONTHLY;BYDAY=-1FR'), { type: 3, interval: 1, weekOfMonth: 5, dayOfWeek: 32 });
  assert.deepEqual(toEas('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1'), { type: 3, interval: 1, weekOfMonth: 1, dayOfWeek: 62 });
  assert.deepEqual(toEas('FREQ=MONTHLY;BYMONTHDAY=-1'), { type: 3, interval: 1, weekOfMonth: 5, dayOfWeek: LAST_DAY_OF_MONTH });
  assert.deepEqual(toEas('FREQ=YEARLY'), { type: 5, interval: 1, monthOfYear: 11, dayOfMonth: 19 });
  assert.deepEqual(toEas('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU'), { type: 6, interval: 1, monthOfYear: 3, weekOfMonth: 5, dayOfWeek: 1 });
});

test('RRULE without an ActiveSync form → null (the stored rule is kept on device changes)', () => {
  for (const r of ['FREQ=HOURLY', 'FREQ=WEEKLY;BYHOUR=9', 'FREQ=MONTHLY;BYMONTHDAY=1,15', 'FREQ=YEARLY;BYWEEKNO=20',
    'FREQ=MONTHLY;BYDAY=3MO,1FR', 'FREQ=DAILY;INTERVAL=2;BYDAY=MO', 'FREQ=MONTHLY;BYDAY=5MO']) {
    assert.equal(toEas(r), null, r);
    assert.equal(isRepresentable(r, START), false, r);
  }
  assert.equal(isRepresentable(null, START), true);
  assert.equal(isRepresentable('FREQ=WEEKLY;BYDAY=TH', START), true);
});

test('Recurrence → RRULE round trip (COUNT wins over UNTIL, INTERVAL only when > 1)', () => {
  for (const r of ['FREQ=DAILY;INTERVAL=2;COUNT=5', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=MO', 'FREQ=MONTHLY;BYMONTHDAY=3;UNTIL=20271231T235959Z',
    'FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYDAY=-1FR', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', 'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=19']) {
    assert.equal(back(toEas(r)!), r);
  }
  assert.equal(back({ type: 1, interval: 1, dayOfWeek: 16, occurrences: 3, until: new Date('2027-01-01T00:00:00Z') }), 'FREQ=WEEKLY;BYDAY=TH;COUNT=3');
});

test('parseRecurrence: client Recurrence element on the calendar page (4) and the tasks page (9)', () => {
  // [MS-ASWBXML] calendar: Recurrence 0x1B, Type 0x1C, Until 0x1D, Interval 0x1F, DayOfWeek 0x20, FirstDayOfWeek 0x39
  const cal = decodeWbxml(clientWbxml([4, 0x1b, [[4, 0x1c, '1'], [4, 0x1f, '2'], [4, 0x20, '10'], [4, 0x1d, '20270301T090000Z'], [4, 0x39, '1']]]));
  assert.deepEqual(parseRecurrence(cal, parseEasDate),
    { type: 1, interval: 2, dayOfWeek: 10, until: new Date('2027-03-01T09:00:00Z'), firstDayOfWeek: 1 });
  // tasks: Recurrence 0x0F, Type 0x10, Start 0x11, Occurrences 0x13, Interval 0x14, DayOfMonth 0x15
  const task = decodeWbxml(clientWbxml([9, 0x0f, [[9, 0x10, '2'], [9, 0x11, '2026-11-03T08:00:00.000Z'], [9, 0x13, '6'], [9, 0x14, '1'], [9, 0x15, '3']]]));
  assert.deepEqual(parseRecurrence(task, parseEasDate), { type: 2, interval: 1, occurrences: 6, dayOfMonth: 3 });
  assert.equal(parseRecurrence(decodeWbxml(clientWbxml([4, 0x1b, [[4, 0x1c, '4']]])), parseEasDate), null, 'type 4 does not exist');
});
