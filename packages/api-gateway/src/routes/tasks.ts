import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { patchSchema } from '../lib/zod-compat.js';
import {
  prisma, applyTaskProgress, nextTaskOccurrence, normTaskStatus, TASK_STATUSES, type TaskProgressPatch,
} from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';

export const tasksRouter: RouterType = Router();
tasksRouter.use(requireAuth);
// 9.4: task writes (incl. reminders) reach the user's other tabs and devices
tasksRouter.use(announceOnWrite({ type: 'tasks' }));

const isoDate = z.string().refine((s) => !isNaN(new Date(s).getTime()), 'invalid date');
const nullableDate = isoDate.nullable().optional();
const text = (max: number) => z.string().max(max);

// 9.4: the full task form (Start, Fällig, Abschluss, Status, % erledigt, privat, Serie,
// Aufwand, Kilometer, Abrechnung, Firmen, Notiz als Rich Text)
const TaskSchema = z.object({
  subject:           z.string().min(1).max(500),
  body:              text(100_000).optional().default(''),
  bodyHtml:          text(200_000).optional(),
  dueDate:           nullableDate,
  startDate:         nullableDate,
  completedAt:       nullableDate,
  priority:          z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  status:            z.enum(TASK_STATUSES).optional(),
  percentComplete:   z.number().int().min(0).max(100).optional(),
  reminder:          nullableDate,
  reminderByMail:    z.boolean().optional().default(false),
  isPrivate:         z.boolean().optional(),
  // a task repeats at most daily (the next task is created on completion)
  rrule:             z.string().max(500).regex(/^(RRULE:)?FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Za-z]+=[A-Za-z0-9,:+-]+)*$/i, 'Invalid RRULE').nullable().optional(),
  totalWorkMinutes:  z.number().int().min(0).max(1_000_000).nullable().optional(),
  actualWorkMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
  mileage:           text(500).optional(),
  billingInfo:       text(500).optional(),
  companies:         text(500).optional(),
});
type TaskInput = z.infer<typeof TaskSchema>;

const toDate = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(v));
const normRrule = (v: string | null | undefined): string | null | undefined => (v === undefined ? undefined : v ? v.replace(/^RRULE:/i, '').toUpperCase() : null);

interface TaskColumns {
  subject?: string; body?: string; bodyHtml?: string; priority?: string; reminderByMail?: boolean; isPrivate?: boolean;
  totalWorkMinutes?: number | null; actualWorkMinutes?: number | null; mileage?: string; billingInfo?: string; companies?: string;
  dueDate?: Date | null; startDate?: Date | null; reminder?: Date | null; rrule?: string | null;
}

/** Columns of the form fields that were sent (absent = keep). */
function optionalColumns(d: { [K in keyof TaskInput]?: TaskInput[K] | undefined }): TaskColumns {
  const dueDate = toDate(d.dueDate);
  const startDate = toDate(d.startDate);
  const reminder = toDate(d.reminder);
  const rrule = normRrule(d.rrule);
  return {
    ...(d.subject !== undefined ? { subject: d.subject } : {}),
    ...(d.body !== undefined ? { body: d.body } : {}),
    ...(d.bodyHtml !== undefined ? { bodyHtml: d.bodyHtml } : {}),
    ...(d.priority !== undefined ? { priority: d.priority } : {}),
    ...(d.reminderByMail !== undefined ? { reminderByMail: d.reminderByMail } : {}),
    ...(d.isPrivate !== undefined ? { isPrivate: d.isPrivate } : {}),
    ...(d.totalWorkMinutes !== undefined ? { totalWorkMinutes: d.totalWorkMinutes } : {}),
    ...(d.actualWorkMinutes !== undefined ? { actualWorkMinutes: d.actualWorkMinutes } : {}),
    ...(d.mileage !== undefined ? { mileage: d.mileage } : {}),
    ...(d.billingInfo !== undefined ? { billingInfo: d.billingInfo } : {}),
    ...(d.companies !== undefined ? { companies: d.companies } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(reminder !== undefined ? { reminder } : {}),
    ...(rrule !== undefined ? { rrule } : {}),
  };
}

function progressPatch(d: { status?: TaskInput['status'] | undefined; percentComplete?: number | undefined; completedAt?: string | null | undefined }): TaskProgressPatch {
  const completedAt = toDate(d.completedAt);
  return {
    ...(d.status !== undefined ? { status: d.status } : {}),
    ...(d.percentComplete !== undefined ? { percentComplete: d.percentComplete } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

// GET /api/v1/tasks
tasksRouter.get('/', async (req: Request, res: Response) => {
  const status = req.query['status'] as string | undefined;
  const where: Record<string, unknown> = { userId: req.apiUser!.userId };
  if (status) where['status'] = status;

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  });
  res.json(tasks);
});

// GET /api/v1/tasks/:id
tasksRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(task);
});

// POST /api/v1/tasks
tasksRouter.post('/', async (req: Request, res: Response) => {
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const progress = applyTaskProgress({ status: 'NOT_STARTED', percentComplete: 0, completedAt: null }, progressPatch(parsed.data), new Date());
  const task = await prisma.task.create({
    data: {
      ...optionalColumns(parsed.data),
      userId: req.apiUser!.userId,
      subject: parsed.data.subject,
      ...progress,
    },
  });
  res.status(201).json(task);
});

// PUT /api/v1/tasks/:id
// 9.4: status / % / completion date stay consistent (task-rules.ts); completing a
// recurring task closes this occurrence and creates the next one (returned as `next`).
tasksRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = patchSchema(TaskSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const now = new Date();
  const patch = progressPatch(parsed.data);
  const current = { status: normTaskStatus(task.status), percentComplete: task.percentComplete, completedAt: task.completedAt };
  const progressTouched = Object.keys(patch).length > 0;
  const progress = progressTouched ? applyTaskProgress(current, patch, now) : current;
  const columns = optionalColumns(parsed.data);
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

  // only the fields that were sent (a one-field PUT must not rewrite the others)
  const data = { ...columns, ...(progressTouched ? progress : {}), ...(justCompleted && rrule ? { rrule: null } : {}) };
  if (!next) {
    res.json(await prisma.task.update({ where: { id }, data }));
    return;
  }
  // Completing a recurring occurrence creates the next one exactly once: the update
  // only applies while the task is still open (a concurrent or repeated completion
  // matches no row and creates nothing).
  const { updated, created } = await prisma.$transaction(async (tx) => {
    const won = await tx.task.updateMany({ where: { id, userId: task.userId, status: { not: 'COMPLETED' } }, data });
    const row = await tx.task.findFirst({ where: { id, userId: task.userId } });
    if (won.count === 0 || !row) return { updated: row, created: null };
    const nextTask = await tx.task.create({
      data: {
        userId: task.userId, subject: row.subject, body: row.body, bodyHtml: row.bodyHtml,
        priority: row.priority, reminderByMail: row.reminderByMail, isPrivate: row.isPrivate,
        totalWorkMinutes: row.totalWorkMinutes, mileage: row.mileage, billingInfo: row.billingInfo,
        companies: row.companies, status: 'NOT_STARTED', percentComplete: 0,
        rrule: next.rrule, dueDate: next.dueDate, startDate: next.startDate, reminder: next.reminder,
      },
    });
    return { updated: row, created: nextTask };
  });
  if (!updated) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(created ? { ...updated, next: created } : updated);
});

// DELETE /api/v1/tasks/:id
tasksRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  await prisma.task.delete({ where: { id } });
  res.json({ ok: true });
});
