import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateGroupOf, dateGroupsApply, groupByDate, toggleCollapsedGroup, DATE_GROUP_LABELS } from './dateGroups.ts';

const BERLIN = 'Europe/Berlin';
const MON = 1;
const SUN = 0;
/** Wednesday 2026-11-18, 10:00 in Berlin (UTC+1). */
const NOW = new Date('2026-11-18T09:00:00Z');
const at = (iso: string) => new Date(iso);

test('today, yesterday, this week, last week, this month, older (Monday weeks, Berlin)', () => {
  const g = (iso: string) => dateGroupOf(at(iso), NOW, BERLIN, MON);
  assert.equal(g('2026-11-18T08:59:00Z'), 'today');
  assert.equal(g('2026-11-17T23:30:00Z'), 'today', '00:30 local is already today');
  assert.equal(g('2026-11-17T22:59:00Z'), 'yesterday', '23:59 local the day before');
  assert.equal(g('2026-11-16T07:00:00Z'), 'thisWeek', 'Monday of this week');
  assert.equal(g('2026-11-15T12:00:00Z'), 'lastWeek', 'Sunday belongs to last week');
  assert.equal(g('2026-11-09T00:30:00Z'), 'lastWeek', 'Monday of last week (local)');
  assert.equal(g('2026-11-08T22:00:00Z'), 'thisMonth', 'Sunday 23:00 local, two weeks back');
  assert.equal(g('2026-11-01T00:00:00Z'), 'thisMonth');
  assert.equal(g('2026-10-31T23:30:00Z'), 'thisMonth', '23:30 UTC on Oct 31 is 00:30 Nov 1 in Berlin');
  assert.equal(g('2026-10-31T22:30:00Z'), 'older', '23:30 Oct 31 in Berlin');
  assert.equal(g('2025-11-18T09:00:00Z'), 'older', 'same day a year ago');
  assert.equal(g('2026-11-20T09:00:00Z'), 'today', 'a future date (wrong clock) counts as today');
});

test('the week start follows the calendar setting (Sunday)', () => {
  // Sunday 2026-11-15 starts this week when weeks start on Sunday
  assert.equal(dateGroupOf(at('2026-11-15T12:00:00Z'), NOW, BERLIN, SUN), 'thisWeek');
  assert.equal(dateGroupOf(at('2026-11-14T12:00:00Z'), NOW, BERLIN, SUN), 'lastWeek');
  assert.equal(dateGroupOf(at('2026-11-07T12:00:00Z'), NOW, BERLIN, SUN), 'thisMonth');
});

test('Monday "today": yesterday is Sunday and already last week', () => {
  const monday = new Date('2026-11-16T10:00:00Z');
  assert.equal(dateGroupOf(at('2026-11-15T10:00:00Z'), monday, BERLIN, MON), 'yesterday');
  assert.equal(dateGroupOf(at('2026-11-14T10:00:00Z'), monday, BERLIN, MON), 'lastWeek');
});

test('time zones: the same instant is today in Tokyo and yesterday in New York', () => {
  const now = new Date('2026-11-18T16:00:00Z');       // Tokyo 01:00 Nov 19, New York 11:00 Nov 18
  const mail = new Date('2026-11-18T15:30:00Z');      // Tokyo 00:30 Nov 19, New York 10:30 Nov 18
  assert.equal(dateGroupOf(mail, now, 'Asia/Tokyo', MON), 'today');
  assert.equal(dateGroupOf(mail, now, 'America/New_York', MON), 'today');
  const earlier = new Date('2026-11-18T14:30:00Z');   // Tokyo 23:30 Nov 18 → yesterday there
  assert.equal(dateGroupOf(earlier, now, 'Asia/Tokyo', MON), 'yesterday');
  assert.equal(dateGroupOf(earlier, now, 'America/New_York', MON), 'today');
});

test('daylight-saving days: 23 h and 25 h days keep the calendar day boundaries', () => {
  // Berlin: summer time ends 2026-10-25 03:00 → 02:00 (25 h day)
  const now = new Date('2026-10-26T06:00:00Z');       // Mon 07:00 CET
  assert.equal(dateGroupOf(at('2026-10-25T22:59:00Z'), now, BERLIN, MON), 'yesterday', '23:59 CET Sunday');
  assert.equal(dateGroupOf(at('2026-10-25T23:00:00Z'), now, BERLIN, MON), 'today', '00:00 CET Monday');
  assert.equal(dateGroupOf(at('2026-10-24T22:30:00Z'), now, BERLIN, MON), 'yesterday', '00:30 CEST Sunday (before the change)');
  // Berlin: summer time starts 2026-03-29 02:00 → 03:00 (23 h day)
  const spring = new Date('2026-03-30T06:00:00Z');    // Mon 08:00 CEST
  assert.equal(dateGroupOf(at('2026-03-29T21:59:00Z'), spring, BERLIN, MON), 'yesterday', '23:59 CEST Sunday');
  assert.equal(dateGroupOf(at('2026-03-29T22:00:00Z'), spring, BERLIN, MON), 'today', '00:00 CEST Monday');
});

test('groupByDate: consecutive runs in list order with unique keys; bad dates are "older"', () => {
  const items = [
    { id: 'pinned-old', date: '2026-01-02T10:00:00Z' },
    { id: 'a', date: '2026-11-18T08:00:00Z' },
    { id: 'b', date: '2026-11-18T07:00:00Z' },
    { id: 'c', date: '2026-11-17T07:00:00Z' },
    { id: 'd', date: 'not a date' },
  ];
  const runs = groupByDate(items, NOW, BERLIN, MON);
  assert.deepEqual(runs.map((r) => [r.key, r.items.map((i) => i.id)]), [
    ['older:0', ['pinned-old']],
    ['today:1', ['a', 'b']],
    ['yesterday:3', ['c']],
    ['older:4', ['d']],
  ]);
  assert.deepEqual(groupByDate([], NOW, BERLIN, MON), []);
});

test('date groups only in date order without conversations; collapsed state per folder', () => {
  assert.equal(dateGroupsApply('date', false), true);
  assert.equal(dateGroupsApply('date', true), false);
  assert.equal(dateGroupsApply('from', false), false);
  let s = toggleCollapsedGroup({}, 'own:f1', 'older');
  s = toggleCollapsedGroup(s, 'own:f2', 'today');
  assert.deepEqual(s, { 'own:f1': ['older'], 'own:f2': ['today'] });
  s = toggleCollapsedGroup(s, 'own:f1', 'older');
  assert.deepEqual(s, { 'own:f1': [], 'own:f2': ['today'] });
  assert.deepEqual(Object.values(DATE_GROUP_LABELS), ['Heute', 'Gestern', 'Diese Woche', 'Letzte Woche', 'Dieser Monat', 'Älter']);
});
