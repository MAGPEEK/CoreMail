/**
 * 9.4: follow-up flags in the webmail — the "Kennzeichnen" presets (Heute, Morgen,
 * Diese Woche, Nächste Woche, Kein Datum) and the flag state of a list row.
 * Dates are the start of the day in the user's zone (Settings → Region), sent to
 * the server as UTC instants. Pure — unit-tested with `node --test`.
 */
import { instantToWallClock, wallClockToInstant } from './zonedTime.ts';

export type FollowUpStatus = 'none' | 'flagged' | 'complete';
export type FlagPreset = 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'noDate';
export const FLAG_PRESETS: readonly FlagPreset[] = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'noDate'];


/** Effective flag of a message row: rows from before 9.4 only carry `\Flagged`. */
export function followUpStatusOf(m: { flags: readonly string[]; flagStatus?: string | null }): FollowUpStatus {
  if (m.flagStatus === 'flagged' || m.flagStatus === 'complete') return m.flagStatus;
  return m.flags.includes('\\Flagged') ? 'flagged' : 'none';
}

/** Calendar arithmetic on `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** First / last work day of the week that contains `date` (weeks start Monday). */
function workWeek(date: string, workDays: readonly number[]): { first: string; last: string } {
  const days = workDays.length > 0 ? workDays : [1, 2, 3, 4, 5];
  const monday = addDays(date, -((weekday(date) + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => days.includes(weekday(d)));
  return { first: week[0] ?? monday, last: week[week.length - 1] ?? addDays(monday, 4) };
}

/**
 * Start and due date of a preset (ISO instants of local midnight; null for "Kein Datum"):
 *  - Heute / Morgen: start = due = that day
 *  - Diese Woche: start today, due the last work day of this week (today when it is later)
 *  - Nächste Woche: first to last work day of next week
 */
export function flagPresetDates(
  preset: FlagPreset,
  now: Date,
  timeZone: string,
  workDays: readonly number[],
): { startAt: string | null; dueAt: string | null } {
  if (preset === 'noDate') return { startAt: null, dueAt: null };
  const today = instantToWallClock(now.toISOString(), timeZone).date;
  const at = (date: string) => wallClockToInstant(date, '00:00', timeZone);
  switch (preset) {
    case 'today': return { startAt: at(today), dueAt: at(today) };
    case 'tomorrow': { const t = addDays(today, 1); return { startAt: at(t), dueAt: at(t) }; }
    case 'thisWeek': {
      const { last } = workWeek(today, workDays);
      return { startAt: at(today), dueAt: at(last < today ? today : last) };
    }
    case 'nextWeek': {
      const next = workWeek(addDays(today, 7), workDays);
      return { startAt: at(next.first), dueAt: at(next.last) };
    }
  }
}

/** Is a due date (start of its day) before today in the user's zone? */
export function isOverdue(dueAt: string | null | undefined, now: Date, timeZone: string): boolean {
  if (!dueAt) return false;
  const due = instantToWallClock(dueAt, timeZone).date;
  const today = instantToWallClock(now.toISOString(), timeZone).date;
  return due !== '' && due < today;
}

/** Relative due label: "Heute", "Morgen", or null (the caller formats the date). */
export function relativeDueDay(dueAt: string, now: Date, timeZone: string): 'today' | 'tomorrow' | 'yesterday' | null {
  const due = instantToWallClock(dueAt, timeZone).date;
  const today = instantToWallClock(now.toISOString(), timeZone).date;
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  if (due === addDays(today, -1)) return 'yesterday';
  return null;
}

/** Default reminder of a flag: 09:00 local on the due day (today when there is none). */
export function defaultFlagReminder(dueAt: string | null, now: Date, timeZone: string): string {
  const day = dueAt ? instantToWallClock(dueAt, timeZone).date : instantToWallClock(now.toISOString(), timeZone).date;
  const nine = wallClockToInstant(day, '09:00', timeZone);
  return new Date(nine).getTime() > now.getTime() ? nine : new Date(now.getTime() + 60 * 60_000 - (now.getTime() % (15 * 60_000))).toISOString();
}

