/**
 * 9.4: calendar settings (work days/hours, week start, time grid, default
 * duration) as FullCalendar options. No imports — unit-tested with `node --test`.
 */
export interface CalendarSettings {
  workDays: number[];
  workStart: string;
  workEnd: string;
  weekStart: number;
  slotMinutes: number;
  defaultEventMinutes: number;
}

/** "Arbeitswoche" view: the days that are not work days (all shown when none is set). */
export function hiddenDaysForWorkWeek(workDays: readonly number[]): number[] {
  if (workDays.length === 0) return [];
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !workDays.includes(d));
}

/** FullCalendar duration "HH:MM:00" for the time-grid scale. */
export function slotDuration(minutes: number): string {
  const m = Math.min(Math.max(Math.round(minutes), 5), 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
}

/** Highlighted work hours (FullCalendar businessHours); start after end → none. */
export function businessHours(s: Pick<CalendarSettings, 'workDays' | 'workStart' | 'workEnd'>): { daysOfWeek: number[]; startTime: string; endTime: string } | false {
  if (s.workDays.length === 0 || s.workStart >= s.workEnd) return false;
  return { daysOfWeek: [...s.workDays], startTime: s.workStart, endTime: s.workEnd };
}
