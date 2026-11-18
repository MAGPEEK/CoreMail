import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRrule, defaultModel, describeRrule, parseRrule, positionOf, recurrencePresets } from './recurrence.ts';

test('recurrencePresets: derived from the chosen date (Tuesday, 10 March 2026 = 2nd Tuesday)', () => {
  assert.deepEqual(recurrencePresets('2026-03-10').map((p) => [p.label, p.rrule]), [
    ['Jeden Tag', 'FREQ=DAILY'],
    ['Jeden Dienstag', 'FREQ=WEEKLY;BYDAY=TU'],
    ['Jeden Arbeitstag', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
    ['Am 10. Tag jedes Monats', 'FREQ=MONTHLY;BYMONTHDAY=10'],
    ['Jeden zweiten Dienstag des Monats', 'FREQ=MONTHLY;BYDAY=2TU'],
    ['Jährlich am 10. März', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=10'],
  ]);
});

test('positionOf: 5th week day of a month counts as the last one', () => {
  assert.equal(positionOf('2026-03-03'), 1);
  assert.equal(positionOf('2026-03-24'), 4);
  assert.equal(positionOf('2026-03-31'), -1);
  assert.equal(positionOf('2026-02-23'), -1); // last Monday of February 2026 (4th, but no 5th)
  assert.equal(recurrencePresets('2026-03-31')[4]!.rrule, 'FREQ=MONTHLY;BYDAY=-1TU');
  assert.equal(recurrencePresets('2026-03-31')[4]!.label, 'Jeden letzten Dienstag des Monats');
});

test('buildRrule / parseRrule round trip for the editor', () => {
  const cases: Array<[string, Parameters<typeof buildRrule>[0]]> = [
    ['FREQ=DAILY;INTERVAL=3;COUNT=10', { ...defaultModel('2026-03-10', 'DAILY'), interval: 3, end: { type: 'count', count: 10 } }],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', { ...defaultModel('2026-03-10'), interval: 2, byDay: ['FR', 'MO', 'WE'] }],
    ['FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T235959Z', { ...defaultModel('2026-03-10', 'MONTHLY'), monthlyMode: 'position', setPos: -1, posDay: 'FR', end: { type: 'until', date: '2026-12-31' } }],
    ['FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=10', defaultModel('2026-03-10', 'YEARLY')],
  ];
  for (const [rrule, model] of cases) {
    assert.equal(buildRrule(model), rrule);
    assert.equal(buildRrule(parseRrule(rrule, '2026-03-10')!), rrule, `round trip ${rrule}`);
  }
});

test('parseRrule: rules the editor cannot show are kept as they are (null)', () => {
  assert.equal(parseRrule('FREQ=HOURLY', '2026-03-10'), null);
  assert.equal(parseRrule('FREQ=WEEKLY;BYHOUR=9', '2026-03-10'), null);
  assert.equal(parseRrule('FREQ=MONTHLY;BYDAY=MO,TU', '2026-03-10'), null);
  assert.equal(parseRrule('FREQ=DAILY;BYDAY=MO', '2026-03-10'), null);
});

test('describeRrule: preset labels, editor rules in words, unknown rules generic', () => {
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=TU', '2026-03-10'), 'Jeden Dienstag');
  assert.equal(describeRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6', '2026-03-10'), 'Alle 2 Wochen am Montag, Mittwoch, 6 Mal');
  assert.equal(describeRrule('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T235959Z', '2026-03-10'), 'Jeden Monat am 15., bis 31.12.2026');
  assert.equal(describeRrule('FREQ=YEARLY;BYMONTH=5;BYDAY=1SU', '2026-03-10'), 'Jedes Jahr am ersten Sonntag im Mai');
  assert.equal(describeRrule('FREQ=MINUTELY', '2026-03-10'), 'Benutzerdefinierte Serie');
});
