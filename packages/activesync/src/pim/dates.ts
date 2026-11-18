/**
 * [MS-ASDTYPE] date values of the PIM classes (pure):
 *  - compact DateTime `YYYYMMDDTHHMMSSZ` (2.7.2) — calendar StartTime, EndTime, DtStamp,
 *    ExceptionStartTime, Recurrence Until;
 *  - DateTime `YYYY-MM-DDTHH:MM:SS.MSSZ` (2.3) — task dates, note LastModifiedDate.
 */
import { formatUtcDateTime } from '@coremail/core/calendar';

/** `20261120T090000Z` */
export function formatCompactDate(d: Date): string {
  return formatUtcDateTime(d);
}

/** `2026-11-20T09:00:00.000Z` */
export function formatEasDate(d: Date): string {
  return d.toISOString();
}

/** A local wall-clock time ("fake UTC" ms) written in the DateTime form — task StartDate / DueDate. */
export function formatLocalEasDate(wallMs: number): string {
  return new Date(wallMs).toISOString();
}

/** Either form (a missing `Z` is read as UTC); null when malformed. */
export function parseEasDate(s: string): Date | null {
  const v = s.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(v);
  if (compact) {
    const [, y, mo, d, h, mi, se] = compact;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const long = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/.exec(v);
  if (!long) return null;
  const [, y, mo, d, h, mi, se, frac] = long;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? '0'), Number((frac ?? '0').padEnd(3, '0')));
  return Number.isNaN(ms) ? null : new Date(ms);
}
