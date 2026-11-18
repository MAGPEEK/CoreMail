/**
 * w3: [MS-ASDTYPE] 2.7.4 TimeZone structure — byte layout, IANA zone → yearly rule, device
 * structure → IANA zone.
 * Run: node --import tsx --test src/pim/timezone.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTimeZone, encodeTimeZone, ianaForTimeZone, timeZoneOf, type EasTimeZone, type SystemTime } from './timezone.js';

const rule = (month: number, week: number, hour: number): SystemTime =>
  ({ year: 0, month, dayOfWeek: 0, day: week, hour, minute: 0, second: 0, milliseconds: 0 });

/** The structure as a Windows client writes it for the US Pacific zone (names + rules). */
function pacificBytes(): Buffer {
  const b = Buffer.alloc(172);
  b.writeInt32LE(480, 0);
  b.write('Pacific Standard Time', 4, 'utf16le');
  [0, 11, 0, 1, 2, 0, 0, 0].forEach((v, i) => b.writeUInt16LE(v, 68 + i * 2));
  b.writeInt32LE(0, 84);
  b.write('Pacific Daylight Time', 88, 'utf16le');
  [0, 3, 0, 2, 2, 0, 0, 0].forEach((v, i) => b.writeUInt16LE(v, 152 + i * 2));
  b.writeInt32LE(-60, 168);
  return b;
}

test('decode: the 172-byte structure field by field (Pacific, Windows names)', () => {
  const tz = decodeTimeZone(pacificBytes().toString('base64'))!;
  assert.equal(tz.bias, 480);
  assert.equal(tz.standardName, 'Pacific Standard Time');
  assert.deepEqual(tz.standardDate, rule(11, 1, 2));
  assert.equal(tz.daylightName, 'Pacific Daylight Time');
  assert.deepEqual(tz.daylightDate, rule(3, 2, 2));
  assert.equal(tz.daylightBias, -60);
  assert.equal(decodeTimeZone(Buffer.alloc(100).toString('base64')), null, 'wrong length');
});

test('encode: byte-exact round trip; names are UTF-16LE, cut at 31 characters', () => {
  const tz = decodeTimeZone(pacificBytes().toString('base64'))!;
  assert.deepEqual(Buffer.from(encodeTimeZone(tz), 'base64'), pacificBytes());
  const long = { ...tz, standardName: 'x'.repeat(40) };
  assert.equal(decodeTimeZone(encodeTimeZone(long))!.standardName, 'x'.repeat(31));
});

test('timeZoneOf: yearly rules derived from the zone offsets (north, south, no DST)', () => {
  const berlin = timeZoneOf('Europe/Berlin', 2026);
  assert.equal(berlin.bias, -60);
  assert.equal(berlin.daylightBias, -60);
  assert.deepEqual(berlin.daylightDate, rule(3, 5, 2), 'last Sunday of March, 02:00 local');
  assert.deepEqual(berlin.standardDate, rule(10, 5, 3), 'last Sunday of October, 03:00 local (summer time)');
  const la = timeZoneOf('America/Los_Angeles', 2026);
  assert.equal(la.bias, 480);
  assert.deepEqual([la.standardDate, la.daylightDate], [rule(11, 1, 2), rule(3, 2, 2)]);
  const sydney = timeZoneOf('Australia/Sydney', 2026);
  assert.equal(sydney.bias, -600);
  assert.deepEqual([sydney.standardDate, sydney.daylightDate], [rule(4, 1, 3), rule(10, 1, 2)]);
  const kolkata = timeZoneOf('Asia/Kolkata', 2026);
  assert.deepEqual([kolkata.bias, kolkata.standardDate.month, kolkata.daylightDate.month, kolkata.daylightBias], [-330, 0, 0, 0]);
  assert.equal(timeZoneOf('Not/AZone', 2026).bias, 0, 'unknown zone → UTC');
});

test('ianaForTimeZone: Windows names, hints, rule matching without names, fixed offsets', () => {
  const pacific = decodeTimeZone(pacificBytes().toString('base64'))!;
  assert.equal(ianaForTimeZone(pacific, 2026), 'America/Los_Angeles');
  const unnamed = (tz: EasTimeZone): EasTimeZone => ({ ...tz, standardName: '', daylightName: '' });
  // the user's zone wins among zones with the same rules
  assert.equal(ianaForTimeZone(unnamed(timeZoneOf('Europe/Berlin', 2026)), 2026, ['Europe/Berlin']), 'Europe/Berlin');
  assert.equal(ianaForTimeZone(unnamed(timeZoneOf('Europe/Berlin', 2026)), 2026, ['Europe/Vienna']), 'Europe/Vienna');
  const found = ianaForTimeZone(unnamed(timeZoneOf('Europe/Berlin', 2026)), 2026)!;
  assert.deepEqual(timeZoneOf(found, 2026).daylightDate, rule(3, 5, 2), `${found} has the Central European rules`);
  assert.equal(ianaForTimeZone(unnamed(timeZoneOf('Asia/Tokyo', 2026)), 2026), 'Etc/GMT-9');
  const sydney = ianaForTimeZone(unnamed(timeZoneOf('Australia/Sydney', 2026)), 2026, [null])!;
  assert.equal(timeZoneOf(sydney, 2026).bias, -600);
  // a device that writes the change to standard time at the standard-time hour still matches
  const shifted = { ...unnamed(timeZoneOf('Europe/Berlin', 2026)), standardDate: rule(10, 5, 2) };
  assert.ok(ianaForTimeZone(shifted, 2026, ['Europe/Berlin']) === 'Europe/Berlin');
  // no zone has these rules
  assert.equal(ianaForTimeZone({ ...unnamed(timeZoneOf('Europe/Berlin', 2026)), bias: -37 }, 2026), null);
});
