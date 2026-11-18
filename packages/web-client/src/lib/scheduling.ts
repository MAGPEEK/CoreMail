/**
 * 9.4: geometry and texts of the scheduling assistant (per-person free/busy
 * timeline of one day). Pure — unit-tested with `node --test`.
 */

export type BusyKind = 'tentative' | 'busy' | 'oof';

export const BUSY_LABEL: Record<BusyKind, string> = {
  tentative: 'Mit Vorbehalt',
  busy: 'Gebucht',
  oof: 'Abwesend',
};

/** Horizontal position of [start, end) on the timeline [viewStart, viewEnd) in percent; null outside. */
export function barPosition(start: string, end: string, viewStart: Date, viewEnd: Date): { left: number; width: number } | null {
  const s = Math.max(new Date(start).getTime(), viewStart.getTime());
  const e = Math.min(new Date(end).getTime(), viewEnd.getTime());
  const span = viewEnd.getTime() - viewStart.getTime();
  if (!(e > s) || span <= 0) return null;
  const pct = (t: number) => Math.round(((t - viewStart.getTime()) / span) * 10_000) / 100;
  return { left: pct(s), width: Math.round((pct(e) - pct(s)) * 100) / 100 };
}

/** Visible hours of the timeline: the work day, widened to the selected slot, at least 8 hours. */
export function timelineHours(workStart: string, workEnd: string, slotStartHour: number, slotEndHour: number): { from: number; to: number } {
  const h = (s: string) => Number(s.split(':')[0] ?? '0');
  let from = Math.min(h(workStart), Math.floor(slotStartHour));
  let to = Math.max(h(workEnd) + (workEnd.endsWith(':00') ? 0 : 1), Math.ceil(slotEndHour));
  if (to - from < 8) to = Math.min(24, from + 8);
  if (to - from < 8) from = Math.max(0, to - 8);
  return { from, to };
}

/** Text of a suggestion's availability. */
export function suggestionNote(conflicts: number, tentative: number): string {
  if (conflicts === 0 && tentative === 0) return 'Alle verfügbar';
  const parts: string[] = [];
  if (conflicts > 0) parts.push(conflicts === 1 ? '1 Konflikt' : `${conflicts} Konflikte`);
  if (tentative > 0) parts.push(`${tentative} mit Vorbehalt`);
  return parts.join(', ');
}
