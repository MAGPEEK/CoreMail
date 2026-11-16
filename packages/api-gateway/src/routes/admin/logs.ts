import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { areaAccess } from '../../lib/rbac.js';

export const adminLogsRouter: RouterType = Router();
adminLogsRouter.use(requireArea('servers'));

const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const;

/** An ISO date / date-time string that parses to a valid Date. */
const dateParam = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid date');

export const LogsQuerySchema = z.object({
  service: z.string().max(64).optional(),
  level: z.enum(LEVELS).optional(),
  category: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Prisma `where` for the log viewer. MAIL_FLOW entries name sender, recipient
 * and subject of every mail (the message trace data, compliance area): a role
 * without compliance access does not get them here either.
 */
export function buildLogsWhere(q: z.infer<typeof LogsQuerySchema>, canSeeMailFlow: boolean): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  // the UI filter is free text: "smtp" finds "smtp-server"
  if (q.service) where['service'] = { contains: q.service, mode: 'insensitive' };
  if (q.level) where['level'] = q.level;
  if (q.category) where['category'] = q.category;
  if (!canSeeMailFlow) {
    if (q.category === 'MAIL_FLOW') where['category'] = { in: [] };
    else if (!q.category) where['category'] = { not: 'MAIL_FLOW' };
  }
  if (q.q) where['message'] = { contains: q.q, mode: 'insensitive' };
  if (q.from || q.to) {
    where['timestamp'] = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  return where;
}

// GET /api/v1/admin/logs
adminLogsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = LogsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return;
  }
  const { limit, offset } = parsed.data;
  const where = buildLogsWhere(parsed.data, areaAccess(req.apiUser?.role, 'compliance') !== null);

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

// GET /api/v1/admin/logs/levels — stored per-service overrides
adminLogsRouter.get('/levels', async (_req: Request, res: Response) => {
  const { getRedisClient, LOG_LEVELS_HASH } = await import('@coremail/core');
  res.json(await getRedisClient().hgetall(LOG_LEVELS_HASH));
});

const serviceKey = z.string().min(1).max(64).regex(/^[a-z0-9*:-]+$/i);

// PUT /api/v1/admin/logs/levels
// Body: { "<service>": "ERROR"|"WARN"|"INFO"|"DEBUG" } — service = package name
// (e.g. "smtp-server"), a short alias ("smtp") or "*" for all services.
// Every service applies it at runtime via initRuntimeLogLevel() (@coremail/core).
adminLogsRouter.put('/levels', async (req: Request, res: Response) => {
  const schema = z.record(serviceKey, z.enum(LEVELS));
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Store log level overrides in Redis for services to pick up dynamically
  const { getRedisClient, LOG_LEVELS_HASH, CHANNEL_LOG_LEVELS } = await import('@coremail/core');
  const redis = getRedisClient();
  for (const [svc, lvl] of Object.entries(parsed.data)) {
    await redis.hset(LOG_LEVELS_HASH, svc.toLowerCase(), lvl);
  }
  // Publish so services can apply immediately
  await redis.publish(CHANNEL_LOG_LEVELS, JSON.stringify(parsed.data));
  res.json({ ok: true });
});

// DELETE /api/v1/admin/logs/levels/:service — remove an override. Running
// services re-resolve the remaining map (e.g. the "*" level); without another
// matching key they keep their current level until restart (env LOG_LEVEL).
adminLogsRouter.delete('/levels/:service', async (req: Request, res: Response) => {
  const parsed = serviceKey.safeParse(req.params['service']);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid service' }); return; }
  const { getRedisClient, LOG_LEVELS_HASH, CHANNEL_LOG_LEVELS } = await import('@coremail/core');
  const redis = getRedisClient();
  const removed = await redis.hdel(LOG_LEVELS_HASH, parsed.data.toLowerCase());
  if (!removed) { res.status(404).json({ error: 'No override for this service' }); return; }
  await redis.publish(CHANNEL_LOG_LEVELS, JSON.stringify(await redis.hgetall(LOG_LEVELS_HASH)));
  res.json({ ok: true });
});

// DELETE /api/v1/admin/logs/purge?before=<ISO date>
adminLogsRouter.delete('/purge', async (req: Request, res: Response) => {
  const before = dateParam.safeParse(req.query['before']);
  if (!before.success) { res.status(400).json({ error: 'before parameter (ISO date) required' }); return; }

  const { count } = await prisma.systemLog.deleteMany({
    where: { timestamp: { lt: new Date(before.data) } },
  });
  res.json({ deleted: count });
});
