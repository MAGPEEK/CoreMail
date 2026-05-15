import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { getRedisClient } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

export const adminQueuesRouter: RouterType = Router();
adminQueuesRouter.use(requireAdmin);

const QUEUE_NAMES = ['smtp:outbound', 'smtp:outbound:retry', 'smtp:outbound:dead', 'smtp:inbound'];

// GET /api/v1/admin/queues
adminQueuesRouter.get('/', async (_req: Request, res: Response) => {
  const redis = getRedisClient();
  const stats = await Promise.all(
    QUEUE_NAMES.map(async (name) => ({
      name,
      count: await redis.llen(name),
    }))
  );
  res.json(stats);
});

// GET /api/v1/admin/queues/:name/jobs
adminQueuesRouter.get('/:name/jobs', async (req: Request, res: Response) => {
  const { name } = req.params as { name: string };
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 200);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

  const queueKey = QUEUE_NAMES.find((q) => q === name || q.endsWith(`:${name}`));
  if (!queueKey) { res.status(404).json({ error: 'Queue not found' }); return; }

  const redis = getRedisClient();
  const items = await redis.lrange(queueKey, offset, offset + limit - 1);
  const total = await redis.llen(queueKey);

  const jobs = items.map((item, idx) => {
    try { return { index: offset + idx, data: JSON.parse(item) }; }
    catch { return { index: offset + idx, data: item }; }
  });
  res.json({ jobs, total, limit, offset });
});

// DELETE /api/v1/admin/queues/:name/jobs/:index
adminQueuesRouter.delete('/:name/jobs/:index', async (req: Request, res: Response) => {
  const { name, index } = req.params as { name: string; index: string };
  const queueKey = QUEUE_NAMES.find((q) => q === name || q.endsWith(`:${name}`));
  if (!queueKey) { res.status(404).json({ error: 'Queue not found' }); return; }

  const redis = getRedisClient();
  const item = await redis.lindex(queueKey, parseInt(index, 10));
  if (!item) { res.status(404).json({ error: 'Job not found' }); return; }

  // Mark as deleted by replacing with a sentinel then removing
  const sentinel = `__DELETED__${Date.now()}`;
  await redis.lset(queueKey, parseInt(index, 10), sentinel);
  await redis.lrem(queueKey, 1, sentinel);
  res.json({ ok: true });
});

// POST /api/v1/admin/queues/:name/flush
adminQueuesRouter.post('/:name/flush', async (req: Request, res: Response) => {
  const { name } = req.params as { name: string };
  const queueKey = QUEUE_NAMES.find((q) => q === name || q.endsWith(`:${name}`));
  if (!queueKey) { res.status(404).json({ error: 'Queue not found' }); return; }

  const redis = getRedisClient();
  await redis.del(queueKey);
  res.json({ ok: true });
});

// GET /api/v1/admin/queues/stats
adminQueuesRouter.get('/stats', async (_req: Request, res: Response) => {
  const redis = getRedisClient();
  const stats = await Promise.all(
    QUEUE_NAMES.map(async (name) => ({
      name,
      count: await redis.llen(name),
    }))
  );
  res.json({ queues: stats, timestamp: new Date().toISOString() });
});
