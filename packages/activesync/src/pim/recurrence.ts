/**
 * Recurrence of calendar items ([MS-ASCAL] 2.2.2.38) and tasks ([MS-ASTASK] 2.2.2.18)
 * ↔ iCalendar RRULE (pure).
 *
 *   Type 0 daily            FREQ=DAILY
 *   Type 1 weekly           FREQ=WEEKLY;BYDAY=…          (DayOfWeek bit mask)
 *   Type 2 monthly          FREQ=MONTHLY;BYMONTHDAY=d    (DayOfMonth)
 *   Type 3 monthly on nth   FREQ=MONTHLY;BYDAY=nDD       (WeekOfMonth 1–4, 5 = last; DayOfWeek;
 *                           several days → BYDAY=…;BYSETPOS=n; DayOfWeek 127 + week 5 = last day)
 *   Type 5 yearly           FREQ=YEARLY;BYMONTH=m;BYMONTHDAY=d
 *   Type 6 yearly on nth    FREQ=YEARLY;BYMONTH=m;BYDAY=nDD
 *
 * Interval, Occurrences (COUNT), Until (UNTIL) and FirstDayOfWeek (WKST, 14.1) carry over.
 * An RRULE outside this set (BYHOUR, BYWEEKNO, several BYMONTHDAY values, …) has no ActiveSync
 * form: `rruleToEas` returns null and the item is sent without recurrence; the stored rule is
 * then kept on device changes (see `isRepresentable`).
 */
import { getText, pel, CP, type WbxmlElement } from '../wbxml.js';

export type RecurrenceType = 0 | 1 | 2 | 3 | 5 | 6;

export interface EasRecurrence {
  type: RecurrenceType;
  interval: number;
  occurrences?: number;
  until?: Date;
  /** Bit mask: 1 Sunday, 2 Monday, 4 Tuesday, … 64 Saturday; 127 = last day of the month (type 3). */
  dayOfWeek?: number;
  dayOfMonth?: number;
  /** 1–4, 5 = last. */
  weekOfMonth?: number;
  monthOfYear?: number;
  /** 0 = Sunday … 6 = Saturday. */
  firstDayOfWeek?: number;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export const LAST_DAY_OF_MONTH = 127;
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST']);

function parts(rrule: string): Map<string, string> {
  return new Map(rrule.replace(/^RRULE:/i, '').toUpperCase().split(';').filter(Boolean)
    .map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)] as [string, string]; }));
}

const dayBit = (code: string): number => { const i = DAYS.indexOf(code as typeof DAYS[number]); return i < 0 ? 0 : 1 << i; };
const maskOf = (codes: string[]): number => codes.reduce((m, c) => m | dayBit(c), 0);
const codesOf = (mask: number): string[] => DAYS.filter((_, i) => mask & (1 << i));

/** Ordinal BYDAY entry (`2TU`, `-1FR`) → [week 1–5, weekday code]; null when not of that form. */
function ordinalDay(entry: string): [number, string] | null {
  const m = /^([+-]?\d)([A-Z]{2})$/.exec(entry);
  if (!m || !DAYS.includes(m[2] as typeof DAYS[number])) return null;
  const n = Number(m[1]);
  if (n === -1) return [5, m[2]!];
  return n >= 1 && n <= 4 ? [n, m[2]!] : null;
}

/** BYSETPOS (1–4, -1) → week of the month; undefined otherwise. */
function setPosWeek(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return n === -1 ? 5 : Number.isInteger(n) && n >= 1 && n <= 4 ? n : undefined;
}

/** Week, weekday mask of a monthly / yearly "nth weekday" rule; null when the rule has another form. */
function nthDay(p: Map<string, string>): { weekOfMonth: number; dayOfWeek: number } | null {
  const byday = p.get('BYDAY')?.split(',') ?? [];
  if (byday.length === 1) {
    const ord = ordinalDay(byday[0]!);
    if (ord && !p.has('BYSETPOS')) return { weekOfMonth: ord[0], dayOfWeek: dayBit(ord[1]) };
  }
  const week = setPosWeek(p.get('BYSETPOS'));
  if (week !== undefined && byday.length > 0 && byday.every((d) => dayBit(d) > 0)) return { weekOfMonth: week, dayOfWeek: maskOf(byday) };
  return null;
}

const singleInt = (v: string | undefined, min: number, max: number): number | undefined => {
  if (v === undefined || !/^-?\d{1,2}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
};

/**
 * RRULE → ActiveSync recurrence. `startWall` is DTSTART as local wall clock ("fake UTC") —
 * the source of the weekday / day / month a rule leaves implicit. `untilOf` converts the raw
 * UNTIL value. Null when the rule has no ActiveSync form.
 */
export function rruleToEas(rrule: string, startWall: Date, untilOf: (raw: string) => Date | null): EasRecurrence | null {
  const p = parts(rrule);
  if ([...p.keys()].some((k) => !SUPPORTED_PARTS.has(k))) return null;
  const interval = p.has('INTERVAL') ? Number(p.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) return null;
  const base: Omit<EasRecurrence, 'type'> = { interval };
  if (p.has('COUNT')) {
    const n = Number(p.get('COUNT'));
    if (!Number.isInteger(n) || n < 1) return null;
    base.occurrences = n;
  }
  if (p.has('UNTIL')) {
    const until = untilOf(p.get('UNTIL')!);
    if (!until) return null;
    base.until = until;
  }
  const wkst = p.get('WKST');
  if (wkst && DAYS.includes(wkst as typeof DAYS[number])) base.firstDayOfWeek = DAYS.indexOf(wkst as typeof DAYS[number]);
  const byday = p.get('BYDAY')?.split(',');
  const byMonthDay = p.get('BYMONTHDAY');
  const month = p.has('BYMONTH') ? singleInt(p.get('BYMONTH'), 1, 12) : startWall.getUTCMonth() + 1;
  if (month === undefined) return null;

  switch (p.get('FREQ')) {
    case 'DAILY':
      if (byMonthDay || p.has('BYMONTH') || p.has('BYSETPOS')) return null;
      if (!byday) return { type: 0, ...base };
      // "every weekday": an ActiveSync weekly rule
      return interval === 1 && byday.every((d) => dayBit(d) > 0) ? { type: 1, ...base, dayOfWeek: maskOf(byday) } : null;
    case 'WEEKLY': {
      if (byMonthDay || p.has('BYMONTH') || p.has('BYSETPOS')) return null;
      const mask = byday ? maskOf(byday) : 1 << startWall.getUTCDay();
      return byday && byday.some((d) => dayBit(d) === 0) ? null : { type: 1, ...base, dayOfWeek: mask };
    }
    case 'MONTHLY': {
      if (p.has('BYMONTH')) return null;
      if (byday) { const nth = nthDay(p); return nth ? { type: 3, ...base, ...nth } : null; }
      if (byMonthDay === '-1') return { type: 3, ...base, weekOfMonth: 5, dayOfWeek: LAST_DAY_OF_MONTH };
      const day = byMonthDay === undefined ? startWall.getUTCDate() : singleInt(byMonthDay, 1, 31);
      return day === undefined || p.has('BYSETPOS') ? null : { type: 2, ...base, dayOfMonth: day };
    }
    case 'YEARLY': {
      if (byday) { const nth = nthDay(p); return nth ? { type: 6, ...base, monthOfYear: month, ...nth } : null; }
      const day = byMonthDay === undefined ? startWall.getUTCDate() : singleInt(byMonthDay, 1, 31);
      return day === undefined || p.has('BYSETPOS') ? null : { type: 5, ...base, monthOfYear: month, dayOfMonth: day };
    }
    default:
      return null;
  }
}

/** True when the stored rule reaches the device (so a missing Recurrence in a device change clears it). */
export function isRepresentable(rrule: string | null, startWall: Date): boolean {
  return !rrule || rruleToEas(rrule, startWall, () => new Date(0)) !== null;
}

/** ActiveSync recurrence → RRULE value (without `RRULE:`); `untilValue` formats UNTIL. */
export function easToRrule(r: EasRecurrence, untilValue: (d: Date) => string): string {
  const out: string[] = [];
  const nth = (week: number | undefined, mask: number | undefined): string[] => {
    const codes = codesOf(mask ?? 0);
    const n = week === 5 ? -1 : week ?? 1;
    return codes.length === 1 ? [`BYDAY=${n}${codes[0]}`] : [`BYDAY=${codes.join(',')}`, `BYSETPOS=${n}`];
  };
  switch (r.type) {
    case 0: out.push('FREQ=DAILY'); if (r.dayOfWeek) out.push(`BYDAY=${codesOf(r.dayOfWeek).join(',')}`); break;
    case 1: out.push('FREQ=WEEKLY'); if (r.dayOfWeek) out.push(`BYDAY=${codesOf(r.dayOfWeek).join(',')}`); break;
    case 2: out.push('FREQ=MONTHLY'); if (r.dayOfMonth) out.push(`BYMONTHDAY=${r.dayOfMonth}`); break;
    case 3:
      out.push('FREQ=MONTHLY');
      out.push(...(r.dayOfWeek === LAST_DAY_OF_MONTH ? ['BYMONTHDAY=-1'] : nth(r.weekOfMonth, r.dayOfWeek)));
      break;
    case 5:
      out.push('FREQ=YEARLY');
      if (r.monthOfYear) out.push(`BYMONTH=${r.monthOfYear}`);
      if (r.dayOfMonth) out.push(`BYMONTHDAY=${r.dayOfMonth}`);
      break;
    case 6:
      out.push('FREQ=YEARLY');
      if (r.monthOfYear) out.push(`BYMONTH=${r.monthOfYear}`);
      out.push(...nth(r.weekOfMonth, r.dayOfWeek));
      break;
  }
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.occurrences !== undefined) out.push(`COUNT=${r.occurrences}`);
  else if (r.until) out.push(`UNTIL=${untilValue(r.until)}`);
  if (r.firstDayOfWeek !== undefined) out.push(`WKST=${DAYS[r.firstDayOfWeek]}`);
  return out.join(';');
}

// ─── WBXML ───────────────────────────────────────────────────────────────────

const RECURRENCE_TYPES = new Set([0, 1, 2, 3, 5, 6]);

const intOf = (s: string, min: number, max: number): number | undefined => {
  if (!/^\d{1,4}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
};

/** The Recurrence element of a client item (either page; children read by name); null when invalid. */
export function parseRecurrence(el: WbxmlElement, parseDate: (s: string) => Date | null): EasRecurrence | null {
  const type = intOf(getText(el, 'Type'), 0, 6);
  if (type === undefined || !RECURRENCE_TYPES.has(type)) return null;
  const r: EasRecurrence = { type: type as RecurrenceType, interval: intOf(getText(el, 'Interval'), 1, 999) ?? 1 };
  const occ = intOf(getText(el, 'Occurrences'), 1, 999);
  if (occ !== undefined) r.occurrences = occ;
  const until = getText(el, 'Until');
  if (until) { const d = parseDate(until); if (d) r.until = d; }
  const fields: Array<[keyof EasRecurrence, string, number, number]> = [
    ['dayOfWeek', 'DayOfWeek', 1, 127], ['dayOfMonth', 'DayOfMonth', 1, 31], ['weekOfMonth', 'WeekOfMonth', 1, 5],
    ['monthOfYear', 'MonthOfYear', 1, 12], ['firstDayOfWeek', 'FirstDayOfWeek', 0, 6],
  ];
  for (const [key, name, min, max] of fields) {
    const v = intOf(getText(el, name), min, max);
    if (v !== undefined) (r as unknown as Record<string, number>)[key] = v;
  }
  return r;
}

/** Recurrence children in [MS-ASCAL] order (calendar code page 4). */
export function calendarRecurrenceElements(r: EasRecurrence, untilText: (d: Date) => string, withFirstDayOfWeek: boolean): WbxmlElement[] {
  const C = CP.Calendar;
  return [
    pel(C, 'Type', String(r.type)),
    ...(r.occurrences !== undefined ? [pel(C, 'Occurrences', String(r.occurrences))] : []),
    pel(C, 'Interval', String(r.interval)),
    ...(r.weekOfMonth !== undefined ? [pel(C, 'WeekOfMonth', String(r.weekOfMonth))] : []),
    ...(r.dayOfWeek !== undefined ? [pel(C, 'DayOfWeek', String(r.dayOfWeek))] : []),
    ...(r.monthOfYear !== undefined ? [pel(C, 'MonthOfYear', String(r.monthOfYear))] : []),
    ...(r.until && r.occurrences === undefined ? [pel(C, 'Until', untilText(r.until))] : []),
    ...(r.dayOfMonth !== undefined ? [pel(C, 'DayOfMonth', String(r.dayOfMonth))] : []),
    ...(withFirstDayOfWeek && r.firstDayOfWeek !== undefined ? [pel(C, 'FirstDayOfWeek', String(r.firstDayOfWeek))] : []),
  ];
}

/** Recurrence children in [MS-ASTASK] order (tasks code page 9); `start` is the required Start. */
export function taskRecurrenceElements(r: EasRecurrence, start: Date, dateText: (d: Date) => string, withFirstDayOfWeek: boolean): WbxmlElement[] {
  const T = CP.Tasks;
  return [
    pel(T, 'Type', String(r.type)),
    pel(T, 'Start', dateText(start)),
    ...(r.until && r.occurrences === undefined ? [pel(T, 'Until', dateText(r.until))] : []),
    ...(r.occurrences !== undefined ? [pel(T, 'Occurrences', String(r.occurrences))] : []),
    pel(T, 'Interval', String(r.interval)),
    ...(r.dayOfWeek !== undefined ? [pel(T, 'DayOfWeek', String(r.dayOfWeek))] : []),
    ...(r.dayOfMonth !== undefined ? [pel(T, 'DayOfMonth', String(r.dayOfMonth))] : []),
    ...(r.weekOfMonth !== undefined ? [pel(T, 'WeekOfMonth', String(r.weekOfMonth))] : []),
    ...(r.monthOfYear !== undefined ? [pel(T, 'MonthOfYear', String(r.monthOfYear))] : []),
    pel(T, 'Regenerate', '0'),
    pel(T, 'DeadOccur', '0'),
    ...(withFirstDayOfWeek && r.firstDayOfWeek !== undefined ? [pel(T, 'FirstDayOfWeek', String(r.firstDayOfWeek))] : []),
  ];
}
