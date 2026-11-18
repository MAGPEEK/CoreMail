/**
 * 9.5: task writes with the status rules (task-rules.ts) — shared by the REST task
 * routes (api-gateway) and the CalDAV task list (caldav-server), so both keep status,
 * % complete and completion date consistent and both create the next task of a
 * completed recurring task exactly once.
 *
 * Realtime announcements stay with the callers (REST: announceOnWrite, CalDAV:
 * announceUserEvent) — they know the acting user and the protocol.
 */
import type { Task } from '@prisma/client';
import { prisma } from './prisma/index.js';
import {
  applyTaskProgress, nextTaskOccurrence, normTaskStatus, type TaskProgress, type TaskProgressPatch,
} from './task-rules.js';

/** A task row (Prisma model Task). */
export type StoredTask = Task;

/** Task columns a writer may set (absent = keep). Progress columns go through {@link TaskProgressPatch}. */
export interface TaskColumns {
  subject?: string;
  body?: string;
  bodyHtml?: string;
  priority?: string;
  reminderByMail?: boolean;
  isPrivate?: boolean;
  totalWorkMinutes?: number | null;
  actualWorkMinutes?: number | null;
  mileage?: string;
  billingInfo?: string;
  companies?: string;
  dueDate?: Date | null;
  startDate?: Date | null;
  reminder?: Date | null;
  rrule?: string | null;
  /** 9.5 CalDAV: iCal UID (null = the task id) and the VTODO the client stored. */
  uid?: string | null;
  icalData?: string | null;
}

const NEW_TASK: TaskProgress = { status: 'NOT_STARTED', percentComplete: 0, completedAt: null };

/** Create a task; `id` is the CalDAV resource name (absent = generated). */
export async function createTaskWithRules(
  userId: string,
  subject: string,
  columns: TaskColumns,
  patch: TaskProgressPatch,
  now = new Date(),
  id?: string,
): Promise<Task> {
  const progress = applyTaskProgress(NEW_TASK, patch, now);
  return prisma.task.create({
    data: { ...columns, ...(id !== undefined ? { id } : {}), userId, subject, ...progress },
  });
}

export interface TaskUpdateResult {
  /** The task after the write; null when it vanished meanwhile. */
  updated: Task | null;
  /** The next task of a completed recurring task. */
  created: Task | null;
}

/**
 * Update a task: only the given columns change; the progress patch goes through the
 * status rules. Completing a recurring occurrence removes its rule and creates the next
 * task — as a conditional update (only while the task is still open) in one transaction
 * with the creation, so a concurrent or repeated completion creates nothing.
 */
export async function updateTaskWithRules(
  task: Task,
  columns: TaskColumns,
  patch: TaskProgressPatch,
  now = new Date(),
): Promise<TaskUpdateResult> {
  const current: TaskProgress = { status: normTaskStatus(task.status), percentComplete: task.percentComplete, completedAt: task.completedAt };
  const progressTouched = Object.keys(patch).length > 0;
  const progress = progressTouched ? applyTaskProgress(current, patch, now) : current;
  const rrule = columns.rrule !== undefined ? columns.rrule : task.rrule;
  const justCompleted = progress.status === 'COMPLETED' && current.status !== 'COMPLETED';
  const next = justCompleted && rrule
    ? nextTaskOccurrence({
        rrule,
        dueDate: columns.dueDate !== undefined ? columns.dueDate : task.dueDate,
        startDate: columns.startDate !== undefined ? columns.startDate : task.startDate,
        reminder: columns.reminder !== undefined ? columns.reminder : task.reminder,
      })
    : null;

  // only the fields that were sent (a one-field update must not rewrite the others)
  const data = { ...columns, ...(progressTouched ? progress : {}), ...(justCompleted && rrule ? { rrule: null } : {}) };
  if (!next) return { updated: await prisma.task.update({ where: { id: task.id }, data }), created: null };
  return prisma.$transaction(async (tx) => {
    const won = await tx.task.updateMany({ where: { id: task.id, userId: task.userId, status: { not: 'COMPLETED' } }, data });
    const row = await tx.task.findFirst({ where: { id: task.id, userId: task.userId } });
    if (won.count === 0 || !row) return { updated: row, created: null };
    const created = await tx.task.create({
      data: {
        userId: task.userId, subject: row.subject, body: row.body, bodyHtml: row.bodyHtml,
        priority: row.priority, reminderByMail: row.reminderByMail, isPrivate: row.isPrivate,
        totalWorkMinutes: row.totalWorkMinutes, mileage: row.mileage, billingInfo: row.billingInfo,
        companies: row.companies, status: 'NOT_STARTED', percentComplete: 0,
        rrule: next.rrule, dueDate: next.dueDate, startDate: next.startDate, reminder: next.reminder,
        // the next task is a new CalDAV resource (own UID = its id); the client's other
        // properties (CATEGORIES …) carry over through the stored VTODO
        ...(row.icalData !== null ? { icalData: row.icalData } : {}),
      },
    });
    return { updated: row, created };
  });
}
