import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const userRouter = Router();
userRouter.use(requireAuth);

// GET /api/v1/user/profile
userRouter.get('/profile', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: req.apiUser!.userId },
    select: { id: true, email: true, displayName: true, role: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(user);
});

// PUT /api/v1/user/profile
userRouter.put('/profile', async (req: Request, res: Response) => {
  const schema = z.object({ displayName: z.string().min(1).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const updated = await prisma.user.update({
    where: { id: req.apiUser!.userId },
    data: parsed.data,
    select: { id: true, email: true, displayName: true, role: true },
  });
  res.json(updated);
});

// GET /api/v1/user/signature
userRouter.get('/signature', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.apiUser!.userId } });
  res.json({ signature: settings?.signature ?? '' });
});

// PUT /api/v1/user/signature
userRouter.put('/signature', async (req: Request, res: Response) => {
  const schema = z.object({ signature: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  await prisma.userSettings.upsert({
    where: { userId: req.apiUser!.userId },
    update: { signature: parsed.data.signature },
    create: { userId: req.apiUser!.userId, signature: parsed.data.signature },
  });
  res.json({ ok: true });
});

// GET /api/v1/user/oof — Out Of Office
userRouter.get('/oof', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.apiUser!.userId } });
  res.json({
    enabled: settings?.oofEnabled ?? false,
    internalMessage: settings?.oofInternal ?? '',
    externalMessage: settings?.oofExternal ?? '',
    startDate: settings?.oofStart ?? null,
    endDate: settings?.oofEnd ?? null,
  });
});

// PUT /api/v1/user/oof
userRouter.put('/oof', async (req: Request, res: Response) => {
  const schema = z.object({
    enabled: z.boolean(),
    internalMessage: z.string().optional().default(''),
    externalMessage: z.string().optional().default(''),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  await prisma.userSettings.upsert({
    where: { userId: req.apiUser!.userId },
    update: {
      oofEnabled: parsed.data.enabled,
      oofInternal: parsed.data.internalMessage,
      oofExternal: parsed.data.externalMessage,
      oofStart: parsed.data.startDate ? new Date(parsed.data.startDate) : null,
      oofEnd: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
    },
    create: {
      userId: req.apiUser!.userId,
      oofEnabled: parsed.data.enabled,
      oofInternal: parsed.data.internalMessage,
      oofExternal: parsed.data.externalMessage,
      oofStart: parsed.data.startDate ? new Date(parsed.data.startDate) : null,
      oofEnd: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
    },
  });
  res.json({ ok: true });
});

// GET /api/v1/user/rules — mail rules
userRouter.get('/rules', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const rules = await prisma.mailRule.findMany({
    where: { userId: req.apiUser!.userId },
    orderBy: { priority: 'asc' },
  });
  res.json(rules);
});

const RuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  conditions: z.array(z.object({
    field: z.enum(['from', 'to', 'subject', 'body', 'hasAttachment', 'size']),
    operator: z.enum(['contains', 'equals', 'startsWith', 'endsWith', 'greaterThan', 'lessThan', 'is']),
    value: z.string(),
  })),
  actions: z.array(z.object({
    type: z.enum(['move', 'copy', 'delete', 'markRead', 'markFlagged', 'forward', 'reject']),
    value: z.string().optional(),
  })),
});

// POST /api/v1/user/rules
userRouter.post('/rules', async (req: Request, res: Response) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const prisma = getPrisma();
  const rule = await prisma.mailRule.create({
    data: {
      userId: req.apiUser!.userId,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      conditions: parsed.data.conditions,
      actions: parsed.data.actions,
    },
  });
  res.status(201).json(rule);
});

// PUT /api/v1/user/rules/:id
userRouter.put('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = RuleSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }

  const updated = await prisma.mailRule.update({ where: { id }, data: parsed.data as Parameters<typeof prisma.mailRule.update>[0]['data'] });
  res.json(updated);
});

// DELETE /api/v1/user/rules/:id
userRouter.delete('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const prisma = getPrisma();
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  await prisma.mailRule.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /api/v1/user/shared-mailboxes
userRouter.get('/shared-mailboxes', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId: req.apiUser!.userId },
    include: { sharedMailbox: { select: { id: true, email: true, displayName: true } } },
  });
  res.json(perms.map((p) => ({ ...p.sharedMailbox, permission: p.permission })));
});
