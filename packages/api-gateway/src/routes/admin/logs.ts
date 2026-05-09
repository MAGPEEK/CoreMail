import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminLogsRouter = Router();
adminLogsRouter.use(requireAdmin);

// GET /api/v1/admin/logs
adminLogsRouter.get('/', async (req: Request, res: Response) => {
  const schema = z.object({
    service: z.string().optional(),
    level: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']).optional(),
    category: z.string().optional(),
    q: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.coerce.number().int().max(500).default(100),
    offset: z.coerce.number().int().default(0),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid query' }); return; }

  const { service, level, category, q, from, to, limit, offset } = parsed.data;
  const prisma = getPrisma();

  const where: Record<string, unknown> = {};
  if (service) where['service'] = service;
  if (level) where['level'] = level;
  if (category) where['category'] = category;
  if (q) where['message'] = { contains: q, mode: 'insensitive' };
  if (from || to) {
    where['timestamp'] = {
      ...(from && { gte: new Date(from) }),
      ...(to && { lte: new Date(to) }),
    };
  }

  const [logs, total] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.systemLog.count({ where }),
  ]);
  res.json({ logs, total, limit, offset });
});

// PUT /api/v1/admin/logs/levels
adminLogsRouter.put('/levels', async (req: Request, res: Response) => {
  const schema = z.record(z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']));
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Store log level overrides in Redis for services to pick up dynamically
  const { getRedis } = await import('@coremail/core');
  const redis = getRedis();
  for (const [svc, lvl] of Object.entries(parsed.data)) {
    await redis.hset('config:log-levels', svc, lvl);
  }
  // Publish so services can apply immediately
  await redis.publish('config:log-levels:updated', JSON.stringify(parsed.data));
  res.json({ ok: true });
});

// DELETE /api/v1/admin/logs/purge
adminLogsRouter.delete('/purge', async (req: Request, res: Response) => {
  const before = req.query['before'] as string | undefined;
  if (!before) { res.status(400).json({ error: 'before parameter required' }); return; }

  const prisma = getPrisma();
  const { count } = await prisma.systemLog.deleteMany({
    where: { timestamp: { lt: new Date(before) } },
  });
  res.json({ deleted: count });
});
