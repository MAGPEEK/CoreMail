/**
 * 9.4: task status rules — status, % complete and completion date stay
 * consistent whichever field the client changes, and completing a recurring
 * task yields the next one. Pure; used by the REST task routes.
 */
import { expandOccurrences } from '@coremail/core/recurrence';

export const TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'DEFERRED'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export interface TaskProgress {
  status: TaskStatus;
  percentComplete: number;
  completedAt: Date | null;
}

export interface TaskProgressPatch {
  status?: TaskStatus;
  percentComplete?: number;
  /** null reopens a completed task. */
  completedAt?: Date | null;
}

const clampPercent = (p: number): number => Math.min(100, Math.max(0, Math.round(p)));

export function normTaskStatus(v: string | null | undefined): TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v ?? '') ? (v as TaskStatus) : 'NOT_STARTED';
}

/**
 * The progress after a change:
 *  - COMPLETED (status, 100 %, or a completion date) → 100 % with a completion date
 *  - NOT_STARTED → 0 %
 *  - a percentage between 1 and 99 moves NOT_STARTED / COMPLETED to IN_PROGRESS,
 *    0 % moves IN_PROGRESS / COMPLETED to NOT_STARTED
 *  - leaving COMPLETED drops the completion date (and 100 % becomes 0 %)
 */
export function applyTaskProgress(current: TaskProgress, patch: TaskProgressPatch, now: Date): TaskProgress {
  const percent = patch.percentComplete !== undefined ? clampPercent(patch.percentComplete) : undefined;
  const completes = patch.status === 'COMPLETED'
    || (patch.status === undefined && (percent === 100 || (patch.completedAt instanceof Date)));
  if (completes) {
    const completedAt = patch.completedAt ?? (current.status === 'COMPLETED' ? current.completedAt : null) ?? now;
    return { status: 'COMPLETED', percentComplete: 100, completedAt };
  }
  const reopened = current.status === 'COMPLETED' || patch.completedAt === null;
  let status: TaskStatus = patch.status ?? (reopened && current.status === 'COMPLETED' ? 'NOT_STARTED' : current.status);
  let percentComplete = percent ?? (reopened && current.percentComplete === 100 ? 0 : current.percentComplete);
  if (status === 'NOT_STARTED') {
    if (patch.status === undefined && percent !== undefined && percent > 0) status = 'IN_PROGRESS';
    else percentComplete = 0;
  } else if (patch.status === undefined && percent === 0 && status === 'IN_PROGRESS') {
    status = 'NOT_STARTED';
  }
  if (percentComplete === 100) percentComplete = 99;
  return { status, percentComplete, completedAt: null };
}

export interface RecurringTaskDates {
  rrule: string;
  dueDate: Date | null;
  startDate: Date | null;
  reminder: Date | null;
}

export interface NextTaskDates {
  rrule: string;
  dueDate: Date | null;
  startDate: Date | null;
  reminder: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Dates of the task that follows a completed occurrence of a recurring task: the
 * next RRULE date after the current due date (start/reminder keep their distance
 * to it). COUNT is reduced by one; null when the series is over or has no due date.
 */
export function nextTaskOccurrence(task: RecurringTaskDates): NextTaskDates | null {
  const anchor = task.dueDate ?? task.startDate;
  if (!anchor) return null;
  const countMatch = /(?:^|;)COUNT=(\d+)/i.exec(task.rrule);
  const count = countMatch ? Number(countMatch[1]) : null;
  if (count !== null && count <= 1) return null;
  const [, next] = expandOccurrences(
    { start: anchor, end: anchor, allDay: false, tzid: null, rrule: task.rrule },
    anchor,
    new Date(anchor.getTime() + 400 * 7 * DAY_MS),
    { max: 2 },
  );
  if (!next) return null;
  const shift = next.start.getTime() - anchor.getTime();
  const moved = (d: Date | null): Date | null => (d ? new Date(d.getTime() + shift) : null);
  const rrule = count !== null ? task.rrule.replace(/COUNT=\d+/i, `COUNT=${count - 1}`) : task.rrule;
  return {
    rrule,
    dueDate: task.dueDate ? next.start : null,
    startDate: task.dueDate ? moved(task.startDate) : next.start,
    reminder: moved(task.reminder),
  };
}
