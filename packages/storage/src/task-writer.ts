/**
 * Task writes shared by the REST API and ActiveSync (w3): the status rules of
 * task-rules.ts keep status, % complete and completion date consistent, and
 * completing an open occurrence of a recurring task creates the next one exactly
 * once. Realtime announcements stay with the callers (REST: announceOnWrite).
 */
import type { Task } from '@prisma/client';
import { prisma } from './prisma/index.js';
import { applyTaskProgress, nextTaskOccurrence, normTaskStatus, type TaskProgressPatch } from './task-rules.js';

/** A stored task row (for writers outside this package). */
export type TaskRecord = Task;

/** Task columns a writer may set (absent = keep the stored value). */
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
}

/** Creates a task; its progress follows `patch` (a new task starts as not started). */
export async function createTask(
  userId: string,
  columns: TaskColumns & { subject: string },
  patch: TaskProgressPatch,
  now: Date = new Date(),
): Promise<Task> {
  const progress = applyTaskProgress({ status: 'NOT_STARTED', percentComplete: 0, completedAt: null }, patch, now);
  return prisma.task.create({ data: { ...columns, userId, ...progress } });
}

export interface TaskUpdateResult {
  /** The task after the change; null when it vanished during a recurring completion. */
  updated: Task | null;
  /** The next occurrence created by completing a recurring task. */
  next: Task | null;
}

/**
 * Applies `columns` and the progress `patch` to `task` (only the given fields change).
 * Completing a recurring occurrence closes it (its RRULE moves to the next task) and
 * creates the next one — exactly once: the update only applies while the task is still
 * open, a concurrent or repeated completion matches no row and creates nothing.
 */
export async function updateTask(task: Task, columns: TaskColumns, patch: TaskProgressPatch, now: Date = new Date()): Promise<TaskUpdateResult> {
  const current = { status: normTaskStatus(task.status), percentComplete: task.percentComplete, completedAt: task.completedAt };
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

  const data = { ...columns, ...(progressTouched ? progress : {}), ...(justCompleted && rrule ? { rrule: null } : {}) };
  if (!next) return { updated: await prisma.task.update({ where: { id: task.id }, data }), next: null };

  return prisma.$transaction(async (tx) => {
    const won = await tx.task.updateMany({ where: { id: task.id, userId: task.userId, status: { not: 'COMPLETED' } }, data });
    const row = await tx.task.findFirst({ where: { id: task.id, userId: task.userId } });
    if (won.count === 0 || !row) return { updated: row, next: null };
    const created = await tx.task.create({
      data: {
        userId: task.userId, subject: row.subject, body: row.body, bodyHtml: row.bodyHtml,
        priority: row.priority, reminderByMail: row.reminderByMail, isPrivate: row.isPrivate,
        totalWorkMinutes: row.totalWorkMinutes, mileage: row.mileage, billingInfo: row.billingInfo,
        companies: row.companies, status: 'NOT_STARTED', percentComplete: 0,
        rrule: next.rrule, dueDate: next.dueDate, startDate: next.startDate, reminder: next.reminder,
      },
    });
    return { updated: row, next: created };
  });
}
