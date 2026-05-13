import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const tasksRouter: RouterType = Router();
tasksRouter.use(requireAuth);

const TaskSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional().default(''),
  dueDate: z.string().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DEFERRED']).default('NOT_STARTED'),
  reminder: z.string().optional(),
});

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

  const { subject, body, dueDate, priority, status, reminder } = parsed.data;

  const task = await prisma.task.create({
    data: {
      userId: req.apiUser!.userId,
      subject,
      body,
      priority,
      status,
      ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
      ...(reminder ? { reminder: new Date(reminder) } : {}),
    },
  });
  res.status(201).json(task);
});

// PUT /api/v1/tasks/:id
tasksRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = TaskSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const { subject, body, dueDate, priority, status, reminder } = parsed.data;
  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(subject !== undefined ? { subject } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
      ...(reminder !== undefined ? { reminder: reminder ? new Date(reminder) : null } : {}),
      ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
    },
  });
  res.json(updated);
});

// DELETE /api/v1/tasks/:id
tasksRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const task = await prisma.task.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  await prisma.task.delete({ where: { id } });
  res.json({ ok: true });
});
