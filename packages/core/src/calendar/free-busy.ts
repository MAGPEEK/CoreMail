/**
 * 9.4: free/busy merging and meeting-time suggestions for the scheduling
 * assistant (REST POST /calendar/freebusy and /calendar/schedule-suggestions).
 * Pure — no I/O; the callers expand recurring events first.
 */
import { isValidTimeZone, utcToWallClockMs } from './ical.js';

export type BusyKind = 'tentative' | 'busy' | 'oof';

export interface BusyInterval {
  start: Date;
  end: Date;
  kind: BusyKind;
}

const RANK: Record<BusyKind, number> = { tentative: 1, busy: 2, oof: 3 };

/**
 * How an event blocks time: by its show-as value (FREE does not block) and its
 * status (CANCELLED does not block, TENTATIVE is at most tentative).
 */
export function busyKindOf(showAs: string | null | undefined, status: string | null | undefined): BusyKind | null {
  const st = (status ?? '').toUpperCase();
  const sa = (showAs ?? 'BUSY').toUpperCase();
  if (st === 'CANCELLED' || sa === 'FREE') return null;
  if (sa === 'OOF') return 'oof';
  if (sa === 'TENTATIVE' || st === 'TENTATIVE') return 'tentative';
  return 'busy';
}

/**
 * One person's busy time as non-overlapping, sorted intervals. Where intervals
 * overlap the strongest kind wins (absent > busy > tentative); touching
 * intervals of the same kind are joined.
 */
export function mergeBusy(intervals: readonly BusyInterval[]): BusyInterval[] {
  const valid = intervals.filter((i) => i.end.getTime() > i.start.getTime());
  const points = [...new Set(valid.flatMap((i) => [i.start.getTime(), i.end.getTime()]))].sort((a, b) => a - b);
  const out: BusyInterval[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    let kind: BusyKind | null = null;
    for (const i of valid) {
      if (i.start.getTime() <= a && i.end.getTime() >= b && (!kind || RANK[i.kind] > RANK[kind])) kind = i.kind;
    }
    if (!kind) continue;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.end.getTime() === a) last.end = new Date(b);
    else out.push({ start: new Date(a), end: new Date(b), kind });
  }
  return out;
}

export interface WorkingHours {
  /** Week days that count (0 = Sunday … 6 = Saturday). */
  days: readonly number[];
  /** Minutes after local midnight. */
  startMinute: number;
  endMinute: number;
  /** IANA zone of the organizer; '' = UTC. */
  timeZone: string;
}

export interface SlotSuggestion {
  start: Date;
  end: Date;
  /** Attendees busy or absent in the slot. */
  conflicts: number;
  /** Attendees only tentatively busy in the slot. */
  tentative: number;
}

export interface SuggestOptions {
  /** Merged busy intervals per attendee. */
  busy: readonly (readonly BusyInterval[])[];
  windowStart: Date;
  windowEnd: Date;
  durationMs: number;
  /** Candidate grid (default 30 min). */
  stepMs?: number;
  workingHours?: WorkingHours;
  /** No suggestion before this instant (e.g. now). */
  notBefore?: Date;
  max?: number;
}

const MAX_CANDIDATES = 5000;

function withinWorkingHours(start: Date, end: Date, wh: WorkingHours): boolean {
  const tz = wh.timeZone && isValidTimeZone(wh.timeZone) ? wh.timeZone : null;
  const wall = (d: Date): Date => new Date(tz ? utcToWallClockMs(d.getTime(), tz) : d.getTime());
  const s = wall(start);
  const e = wall(new Date(end.getTime() - 1));
  if (s.getUTCFullYear() !== e.getUTCFullYear() || s.getUTCMonth() !== e.getUTCMonth() || s.getUTCDate() !== e.getUTCDate()) return false;
  if (!wh.days.includes(s.getUTCDay())) return false;
  const startMin = s.getUTCHours() * 60 + s.getUTCMinutes();
  const endMin = startMin + Math.round((end.getTime() - start.getTime()) / 60_000);
  return startMin >= wh.startMinute && endMin <= wh.endMinute;
}

function overlapKind(list: readonly BusyInterval[], start: number, end: number): BusyKind | null {
  let kind: BusyKind | null = null;
  for (const i of list) {
    if (i.start.getTime() < end && i.end.getTime() > start && (!kind || RANK[i.kind] > RANK[kind])) kind = i.kind;
  }
  return kind;
}

/**
 * Meeting times inside the window, best first: slots without any conflict, then
 * slots where only few attendees are busy; ties chronologically.
 */
export function suggestSlots(opts: SuggestOptions): SlotSuggestion[] {
  const step = Math.max(5 * 60_000, opts.stepMs ?? 30 * 60_000);
  const duration = Math.max(60_000, opts.durationMs);
  const floor = Math.max(opts.windowStart.getTime(), opts.notBefore?.getTime() ?? -Infinity);
  const first = Math.ceil(floor / step) * step;
  const out: SlotSuggestion[] = [];
  for (let t = first, n = 0; t + duration <= opts.windowEnd.getTime() && n < MAX_CANDIDATES; t += step, n++) {
    const start = new Date(t);
    const end = new Date(t + duration);
    if (opts.workingHours && !withinWorkingHours(start, end, opts.workingHours)) continue;
    let conflicts = 0;
    let tentative = 0;
    for (const person of opts.busy) {
      const kind = overlapKind(person, t, t + duration);
      if (kind === 'tentative') tentative++;
      else if (kind) conflicts++;
    }
    out.push({ start, end, conflicts, tentative });
  }
  out.sort((a, b) => a.conflicts - b.conflicts || a.tentative - b.tentative || a.start.getTime() - b.start.getTime());
  return out.slice(0, opts.max ?? 10);
}
