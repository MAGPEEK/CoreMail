/**
 * 10.1: date groups of the message list — "Heute", "Gestern", "Diese Woche",
 * "Letzte Woche", "Dieser Monat", "Älter". Calendar days are counted in the
 * user's time zone (Settings → Region, '' = the browser's zone), so midnight
 * and daylight-saving changes follow the wall clock of that zone; the week
 * starts on the day of Settings → Kalender (Monday by default). A future date
 * (wrong sender clock) counts as today. Imports only regionalFormat —
 * unit-tested with `node --test`.
 */
import { zonedParts } from './regionalFormat.ts';

export type DateGroupId = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'older';

export const DATE_GROUP_LABELS: Record<DateGroupId, string> = {
  today: 'Heute',
  yesterday: 'Gestern',
  thisWeek: 'Diese Woche',
  lastWeek: 'Letzte Woche',
  thisMonth: 'Dieser Monat',
  older: 'Älter',
};

const DAY_MS = 86_400_000;

/** Day number (days since 1970-01-01) of the wall-clock date of an instant in the zone, plus its month. */
function zonedDay(d: Date, timeZone: string): { day: number; year: number; month: number } {
  const p = zonedParts(d, timeZone);
  return { day: Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS), year: p.year, month: p.month };
}

/** 0 = Sunday … 6 = Saturday of a day number (1970-01-01 was a Thursday). */
const weekdayOf = (day: number): number => (day + 4) % 7;

/** Group of a message date. `weekStart`: 0 Sunday, 1 Monday, 6 Saturday. */
export function dateGroupOf(date: Date, now: Date, timeZone: string, weekStart: number): DateGroupId {
  const today = zonedDay(now, timeZone);
  const d = zonedDay(date, timeZone);
  if (d.day >= today.day) return 'today';
  if (d.day === today.day - 1) return 'yesterday';
  const weekBegin = today.day - ((weekdayOf(today.day) - weekStart + 7) % 7);
  if (d.day >= weekBegin) return 'thisWeek';
  if (d.day >= weekBegin - 7) return 'lastWeek';
  if (d.year === today.year && d.month === today.month) return 'thisMonth';
  return 'older';
}

export interface DateGroupRun<T> {
  /** Unique per run (`<group>:<index of its first item>`) — the same group can come back (pinned mails, ascending order). */
  key: string;
  group: DateGroupId;
  items: T[];
}

/**
 * Consecutive runs of the same group, in list order (the list is already
 * sorted by the server; nothing is reordered here).
 */
export function groupByDate<T extends { date: string }>(items: readonly T[], now: Date, timeZone: string, weekStart: number): DateGroupRun<T>[] {
  const runs: DateGroupRun<T>[] = [];
  items.forEach((item, i) => {
    const t = new Date(item.date);
    const group = Number.isNaN(t.getTime()) ? 'older' : dateGroupOf(t, now, timeZone, weekStart);
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.items.push(item);
    else runs.push({ key: `${group}:${i}`, group, items: [item] });
  });
  return runs;
}

/** Date groups only make sense in date order without conversation grouping. */
export function dateGroupsApply(sortBy: string, groupByConversation: boolean): boolean {
  return sortBy === 'date' && !groupByConversation;
}

/** Collapsed groups per folder (session only): toggles one group of one folder. */
export function toggleCollapsedGroup(state: Readonly<Record<string, readonly DateGroupId[]>>, folderKey: string, group: DateGroupId): Record<string, DateGroupId[]> {
  const current = state[folderKey] ?? [];
  const next = current.includes(group) ? current.filter((g) => g !== group) : [...current, group];
  return { ...Object.fromEntries(Object.entries(state).map(([k, v]) => [k, [...v]])), [folderKey]: next };
}
