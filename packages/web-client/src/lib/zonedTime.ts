/**
 * 9.4: calendar times in the user's time zone (Settings → Region). The calendar
 * grid (FullCalendar with the luxon time-zone plugin) and the event dialog show
 * wall-clock times of that zone; the API keeps UTC instants. '' = the browser's
 * zone. Imports only regionalFormat — unit-tested with `node --test`.
 */
import { zonedParts } from './regionalFormat.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/** FullCalendar `timeZone` option: the chosen IANA zone, or the browser's ('local'). */
export function calendarTimeZone(timeZone: string): string {
  return timeZone || 'local';
}

/** UTC instant → wall-clock date (YYYY-MM-DD) and time (HH:MM) in the zone. */
export function instantToWallClock(iso: string, timeZone: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: '', time: '' };
  const p = zonedParts(d, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** Offset of the zone at an instant (zone wall clock − UTC), in ms. */
function offsetAt(t: number, timeZone: string): number {
  const p = zonedParts(new Date(t), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(t / 60_000) * 60_000; // zonedParts has minute precision
}

/**
 * Wall-clock date + time in the zone → UTC instant (ISO). A time skipped by a
 * daylight-saving change maps to the instant one offset later (02:30 → 03:30);
 * a repeated time maps to its first occurrence. '' when the date is invalid.
 */
export function wallClockToInstant(date: string, time: string, timeZone: string): string {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) return '';
  const tm = /^(\d{2}):(\d{2})$/.exec(time || '00:00');
  const [h, mi] = tm ? [Number(tm[1]), Number(tm[2])] : [0, 0];
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  if (!timeZone) {
    const local = new Date(y, mo - 1, d, h, mi);
    return isNaN(local.getTime()) ? '' : local.toISOString();
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (isNaN(wall)) return '';
  // Two candidates (offset before and after a possible change around this time):
  // the earliest one whose wall clock matches; none matches → skipped time.
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])].map((off) => wall - off).sort((a, b) => a - b);
  const exact = candidates.find((t) => offsetAt(t, timeZone) === wall - t);
  return new Date(exact ?? wall - before).toISOString();
}

/**
 * Range for the events API from FullCalendar's view range. With a named zone
 * FullCalendar hands out UTC-coerced dates (wall clock as UTC), so the range is
 * widened by a day on both sides — every zone offset is inside it.
 */
export function eventFetchRange(start: Date, end: Date): { start: string; end: string } {
  return { start: new Date(start.getTime() - DAY_MS).toISOString(), end: new Date(end.getTime() + DAY_MS).toISOString() };
}

/** Browser-local calendar day of a date picker value (FullCalendar `gotoDate` takes it zone-free). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
