/**
 * [MS-ASDTYPE] 2.7.4 TimeZone of a calendar item (pure): base64 of a 172-byte structure
 *
 *   Bias          int32 LE   minutes, UTC = local time + Bias (Berlin: -60)
 *   StandardName  32 WCHAR   UTF-16LE, NUL padded
 *   StandardDate  SYSTEMTIME change to standard time
 *   StandardBias  int32      added to Bias during standard time (0)
 *   DaylightName  32 WCHAR
 *   DaylightDate  SYSTEMTIME change to daylight saving time
 *   DaylightBias  int32      added to Bias during daylight saving time (-60)
 *
 * SYSTEMTIME = 8 × uint16: wYear, wMonth, wDayOfWeek (0 = Sunday), wDay, wHour, wMinute,
 * wSecond, wMilliseconds. wYear 0 is a yearly rule: wDay is the week of the month (1–4,
 * 5 = last), wHour:wMinute the local time of the change (before the change). wMonth 0 =
 * no daylight saving time.
 *
 * Encoding derives the rule of an IANA zone from its offsets in a given year; decoding
 * maps a device's structure back to the IANA zone with the same rule (name hints first,
 * then every zone the runtime knows).
 */
import { resolveTzid, utcToWallClockMs, isValidTimeZone } from '@coremail/core/calendar';

export interface SystemTime {
  year: number; month: number; dayOfWeek: number; day: number;
  hour: number; minute: number; second: number; milliseconds: number;
}

export interface EasTimeZone {
  bias: number;
  standardName: string;
  standardDate: SystemTime;
  standardBias: number;
  daylightName: string;
  daylightDate: SystemTime;
  daylightBias: number;
}

const SIZE = 172;
const NAME_CHARS = 32;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const NO_DATE: SystemTime = { year: 0, month: 0, dayOfWeek: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0 };

// ─── Binary form ─────────────────────────────────────────────────────────────

function writeName(buf: Buffer, at: number, name: string): void {
  buf.write(Array.from(name).slice(0, NAME_CHARS - 1).join(''), at, NAME_CHARS * 2, 'utf16le');
}

function readName(buf: Buffer, at: number): string {
  const s = buf.toString('utf16le', at, at + NAME_CHARS * 2);
  const nul = s.indexOf('\0');
  return (nul < 0 ? s : s.slice(0, nul)).trim();
}

function writeSystemTime(buf: Buffer, at: number, t: SystemTime): void {
  [t.year, t.month, t.dayOfWeek, t.day, t.hour, t.minute, t.second, t.milliseconds]
    .forEach((v, i) => buf.writeUInt16LE(v, at + i * 2));
}

function readSystemTime(buf: Buffer, at: number): SystemTime {
  const v = (i: number) => buf.readUInt16LE(at + i * 2);
  return { year: v(0), month: v(1), dayOfWeek: v(2), day: v(3), hour: v(4), minute: v(5), second: v(6), milliseconds: v(7) };
}

export function encodeTimeZone(tz: EasTimeZone): string {
  const buf = Buffer.alloc(SIZE);
  buf.writeInt32LE(tz.bias, 0);
  writeName(buf, 4, tz.standardName);
  writeSystemTime(buf, 68, tz.standardDate);
  buf.writeInt32LE(tz.standardBias, 84);
  writeName(buf, 88, tz.daylightName);
  writeSystemTime(buf, 152, tz.daylightDate);
  buf.writeInt32LE(tz.daylightBias, 168);
  return buf.toString('base64');
}

/** Null when the value is not a 172-byte structure. */
export function decodeTimeZone(b64: string): EasTimeZone | null {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== SIZE) return null;
  return {
    bias: buf.readInt32LE(0),
    standardName: readName(buf, 4),
    standardDate: readSystemTime(buf, 68),
    standardBias: buf.readInt32LE(84),
    daylightName: readName(buf, 88),
    daylightDate: readSystemTime(buf, 152),
    daylightBias: buf.readInt32LE(168),
  };
}

// ─── IANA zone → structure ───────────────────────────────────────────────────

const offsetMinutes = (utcMs: number, zone: string): number => Math.round((utcToWallClockMs(utcMs, zone) - utcMs) / MINUTE_MS);

interface Transition { at: number; before: number; after: number }

/** Offset changes of `zone` in `year` (to the minute). */
function transitions(zone: string, year: number): Transition[] {
  const out: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let t = Date.UTC(year, 0, 1); t < end; t += DAY_MS) {
    const before = offsetMinutes(t, zone);
    if (before === offsetMinutes(t + DAY_MS, zone)) continue;
    let lo = t / MINUTE_MS, hi = (t + DAY_MS) / MINUTE_MS;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetMinutes(mid * MINUTE_MS, zone) === before) lo = mid; else hi = mid;
    }
    out.push({ at: hi * MINUTE_MS, before, after: offsetMinutes(hi * MINUTE_MS, zone) });
  }
  return out;
}

/** Yearly rule of a change: month, weekday, week of the month (5 = last) and local time before it. */
function ruleOf(tr: Transition): SystemTime {
  const wall = new Date(tr.at + tr.before * MINUTE_MS);
  const day = wall.getUTCDate();
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    ...NO_DATE,
    month: wall.getUTCMonth() + 1,
    dayOfWeek: wall.getUTCDay(),
    day: day + 7 > daysInMonth ? 5 : Math.ceil(day / 7),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
  };
}

/** -n without a negative zero (Bias of UTC is 0). */
const minus = (n: number): number => (n === 0 ? 0 : -n);

/** The structure of IANA `zone` (or UTC for an unknown one) with the rules in effect in `year`. */
export function timeZoneOf(zone: string, year: number): EasTimeZone {
  const name = isValidTimeZone(zone) ? zone : 'UTC';
  const changes = transitions(name, year);
  const toDaylight = changes.find((c) => c.after > c.before);
  const toStandard = changes.find((c) => c.after < c.before);
  if (!toDaylight || !toStandard) {
    const offset = offsetMinutes(Date.UTC(year, 11, 31), name);
    return { bias: minus(offset), standardName: name, standardDate: NO_DATE, standardBias: 0, daylightName: name, daylightDate: NO_DATE, daylightBias: 0 };
  }
  return {
    bias: minus(toStandard.after),
    standardName: name,
    standardDate: ruleOf(toStandard),
    standardBias: 0,
    daylightName: name,
    daylightDate: ruleOf(toDaylight),
    daylightBias: minus(toDaylight.after - toDaylight.before),
  };
}

// ─── Structure → IANA zone ───────────────────────────────────────────────────

const sameRule = (a: SystemTime, b: SystemTime, withTime: boolean): boolean =>
  a.month === b.month && a.dayOfWeek === b.dayOfWeek && a.day === b.day && (!withTime || (a.hour === b.hour && a.minute === b.minute));

function hasDaylight(tz: EasTimeZone): boolean {
  return tz.daylightDate.month !== 0 && tz.standardDate.month !== 0 && tz.daylightBias !== tz.standardBias;
}

function matches(device: EasTimeZone, zone: string, year: number, withTime: boolean): boolean {
  // cheap pre-check on two offsets before the per-day scan
  const winter = offsetMinutes(Date.UTC(year, 0, 15), zone);
  const summer = offsetMinutes(Date.UTC(year, 6, 15), zone);
  const std = -(device.bias + device.standardBias);
  const dst = -(device.bias + device.daylightBias);
  if (!hasDaylight(device)) return winter === std && summer === std;
  if (!((winter === std && summer === dst) || (winter === dst && summer === std))) return false;
  const own = timeZoneOf(zone, year);
  return own.bias === device.bias + device.standardBias && own.daylightBias === device.daylightBias - device.standardBias
    && sameRule(own.standardDate, device.standardDate, withTime) && sameRule(own.daylightDate, device.daylightDate, withTime);
}

let allZones: string[] | null = null;
function knownZones(): string[] {
  allZones ??= Intl.supportedValuesOf('timeZone');
  return allZones;
}

const cache = new Map<string, string | null>();
const MAX_CACHE = 500;

/**
 * The IANA zone with the offsets and change rules of `device` in `year`; candidates in
 * order: `hints` (e.g. the user's zone), the structure's names (IANA or Windows names),
 * a fixed `Etc/GMT±h` zone, every zone of the runtime. Null when none matches.
 */
export function ianaForTimeZone(device: EasTimeZone, year: number, hints: ReadonlyArray<string | null> = []): string | null {
  const key = `${encodeTimeZone(device)}|${year}|${hints.join(',')}`;
  if (cache.has(key)) return cache.get(key)!;
  const named = [device.standardName, device.daylightName].map((n) => (n ? resolveTzid(n) : null));
  const offsetHours = -(device.bias + device.standardBias) / 60;
  const etc = !hasDaylight(device) && Number.isInteger(offsetHours) && Math.abs(offsetHours) <= 14
    ? [offsetHours === 0 ? 'UTC' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`]
    : [];
  const preferred = [...hints, ...named, ...etc].filter((z): z is string => !!z && isValidTimeZone(z));
  let found: string | null = null;
  for (const withTime of [true, false]) {
    found = [...preferred, ...knownZones()].find((z) => matches(device, z, year, withTime)) ?? null;
    if (found) break;
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, found);
  return found;
}

/** The standard-time UTC offset of a structure in minutes (local = UTC + offset). */
export function standardOffsetMinutes(device: EasTimeZone): number {
  return -(device.bias + device.standardBias);
}
