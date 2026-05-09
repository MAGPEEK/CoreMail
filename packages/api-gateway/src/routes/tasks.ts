import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const TaskSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional().default(''),
  dueDate: z.string().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DEFERRED']).default('NOT_STARTED'),
  reminderAt: z.string().optional(),
});

// GET /api/v1/tasks
tasksRouter.get('/', async (req: Request, res: Response) => {
  const status = req.query['status'] as string | undefined;
  const prisma = getPrisma();

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
  const prisma = getPrisma();
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(task);
});

// POST /api/v1/tasks
tasksRouter.post('/', async (req: Request, res: Response) => {
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { title, notes, dueDate, priority, status, reminderAt } = parsed.data;
  const prisma = getPrisma();
  const task = await prisma.task.create({
    data: {
      userId: req.apiUser!.userId,
      title,
      notes,
      dueDate: dueDate ? new Date(dueDate) : null,
      priority,
      status,
      reminderAt: reminderAt ? new Date(reminderAt) : null,
    },
  });
  res.status(201).json(task);
});

// PUT /api/v1/tasks/:id
tasksRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = TaskSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const { title, notes, dueDate, priority, status, reminderAt } = parsed.data;
  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(title !== undefined && { title }),
      ...(notes !== undefined && { notes }),
      ...(priority !== undefined && { priority }),
      ...(status !== undefined && { status }),
      ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
      ...(reminderAt !== undefined && { reminderAt: reminderAt ? new Date(reminderAt) : null }),
      ...(status === 'COMPLETED' && { completedAt: new Date() }),
    },
  });
  res.json(updated);
});

// DELETE /api/v1/tasks/:id
tasksRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const prisma = getPrisma();
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  await prisma.task.delete({ where: { id } });
  res.json({ ok: true });
});
