import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarTimeZone, eventFetchRange, instantToWallClock, localDay, wallClockToInstant } from './zonedTime.ts';

test('calendarTimeZone: chosen zone, else the browser zone', () => {
  assert.equal(calendarTimeZone('America/New_York'), 'America/New_York');
  assert.equal(calendarTimeZone(''), 'local');
});

test('instantToWallClock: UTC instant shown in the chosen zone', () => {
  assert.deepEqual(instantToWallClock('2026-07-01T10:15:00Z', 'Europe/Berlin'), { date: '2026-07-01', time: '12:15' });
  assert.deepEqual(instantToWallClock('2026-01-15T03:00:00Z', 'America/New_York'), { date: '2026-01-14', time: '22:00' });
  assert.deepEqual(instantToWallClock('2026-03-09T23:30:00Z', 'Asia/Tokyo'), { date: '2026-03-10', time: '08:30' });
  assert.deepEqual(instantToWallClock('not a date', 'UTC'), { date: '', time: '' });
});

test('wallClockToInstant: wall clock in the chosen zone → UTC (both DST seasons)', () => {
  assert.equal(wallClockToInstant('2026-07-01', '12:15', 'Europe/Berlin'), '2026-07-01T10:15:00.000Z');
  assert.equal(wallClockToInstant('2026-12-01', '12:15', 'Europe/Berlin'), '2026-12-01T11:15:00.000Z');
  assert.equal(wallClockToInstant('2026-01-14', '22:00', 'America/New_York'), '2026-01-15T03:00:00.000Z');
  assert.equal(wallClockToInstant('2026-11-18', '09:00', 'UTC'), '2026-11-18T09:00:00.000Z');
  assert.equal(wallClockToInstant('2026-11-18', '', 'Asia/Kolkata'), '2026-11-17T18:30:00.000Z');
  assert.equal(wallClockToInstant('', '09:00', 'UTC'), '');
});

test('wallClockToInstant: skipped and repeated hours of a DST change', () => {
  // Europe/Berlin 2026-03-29: 02:00 → 03:00 (02:30 does not exist → 03:30 CEST)
  assert.equal(wallClockToInstant('2026-03-29', '02:30', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z');
  assert.equal(wallClockToInstant('2026-03-29', '03:30', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z');
  // 2026-10-25: 03:00 → 02:00 (02:30 twice → the first, still CEST)
  assert.equal(wallClockToInstant('2026-10-25', '02:30', 'Europe/Berlin'), '2026-10-25T00:30:00.000Z');
  assert.equal(wallClockToInstant('2026-10-25', '03:30', 'Europe/Berlin'), '2026-10-25T02:30:00.000Z');
});

test('round trip: every quarter hour of a DST day', () => {
  for (const tz of ['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'UTC']) {
    for (let t = Date.UTC(2026, 9, 24, 12); t < Date.UTC(2026, 9, 26, 12); t += 15 * 60_000) {
      const { date, time } = instantToWallClock(new Date(t).toISOString(), tz);
      const back = Date.parse(wallClockToInstant(date, time, tz));
      // repeated hour: the first occurrence is chosen → same wall clock, maybe an hour earlier
      assert.ok(back === t || back === t - 3_600_000, `${tz} ${new Date(t).toISOString()} → ${date} ${time}`);
      assert.deepEqual(instantToWallClock(new Date(back).toISOString(), tz), { date, time });
    }
  }
});

test('eventFetchRange widens by a day; localDay uses the browser calendar day', () => {
  const r = eventFetchRange(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
  assert.deepEqual(r, { start: '2026-10-31T00:00:00.000Z', end: '2026-12-02T00:00:00.000Z' });
  assert.equal(localDay(new Date(2026, 10, 18, 0, 5)), '2026-11-18');
});
