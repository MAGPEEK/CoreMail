/**
 * Admin API: SMTP queue management (BullMQ)
 *
 * GET  /api/v1/admin/queues/stats                — counters per queue state
 * GET  /api/v1/admin/queues/jobs                 — jobs (paginated, filterable by state)
 * POST /api/v1/admin/queues/jobs/:id/retry       — retry a single job
 * POST /api/v1/admin/queues/retry-failed         — retry all failed jobs
 * DELETE /api/v1/admin/queues/jobs/:id           — delete a single job
 * POST /api/v1/admin/queues/flush                — flush queue by state
 * GET  /api/v1/admin/queues/settings             — queue settings
 * PUT  /api/v1/admin/queues/settings             — update queue settings
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { Queue, type Job } from 'bullmq';
import { z } from 'zod';
import { createBullMqConnection, createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { prisma, adminRetryJobData, invalidateQueueSettingsCache } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';

const log = createLogger('admin:queues');
export const adminQueuesRouter: RouterType = Router();
adminQueuesRouter.use(requireArea('servers'));

const OUTBOUND_QUEUE_NAME = 'smtp-outbound';

/** Opens a queue connection, runs fn, closes it afterwards. */
async function withQueue<T>(fn: (q: Queue) => Promise<T>): Promise<T> {
  const q = new Queue(OUTBOUND_QUEUE_NAME, {
    connection: createBullMqConnection(),
  });
  try {
    return await fn(q);
  } finally {
    await q.close();
  }
}

function serializeJob(job: Job) {
  const d = job.data as {
    messageId?: string; from?: string; to?: string[];
    rawMessage?: string; senderUserId?: string;
    dkimDomain?: string; dkimSelector?: string;
  };
  return {
    id:            job.id,
    name:          job.name,
    messageId:     d.messageId,
    from:          d.from,
    to:            d.to,
    attemptsMade:  job.attemptsMade,
    maxAttempts:   job.opts.attempts ?? 10,
    createdAt:     new Date(job.timestamp).toISOString(),
    processedAt:   job.processedOn  ? new Date(job.processedOn).toISOString()  : undefined,
    finishedAt:    job.finishedOn   ? new Date(job.finishedOn).toISOString()   : undefined,
    delay:         job.delay,
    nextRunAt:     job.delay > 0    ? new Date(job.timestamp + job.delay).toISOString() : undefined,
    failedReason:  job.failedReason,
    stacktrace:    (job.stacktrace ?? []).slice(0, 3),
    dkimDomain:    d.dkimDomain,
    // rawMessage is NOT serialized (can be MBs in size)
  };
}

// ── GET /stats ────────────────────────────────────────────────────────────────
adminQueuesRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const counts = await withQueue(async (q) => {
      const [waiting, active, delayed, failed, completed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getDelayedCount(),
        q.getFailedCount(),
        q.getCompletedCount(),
      ]);
      return { waiting, active, delayed, failed, completed };
    });
    res.json({ ...counts, timestamp: new Date().toISOString() });
  } catch (err) {
    log.error({ err }, 'Failed to get queue stats');
    res.json({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, timestamp: new Date().toISOString() });
  }
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────
adminQueuesRouter.get('/jobs', async (req: Request, res: Response) => {
  const state = (req.query['state'] as string) || 'all';
  const page  = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50), 200);
  const start = (page - 1) * limit;
  const end   = start + limit - 1;

  const validStates = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;
  type BullState = typeof validStates[number];

  const states: BullState[] = state === 'all'
    ? ['waiting', 'active', 'delayed', 'failed']
    : validStates.includes(state as BullState) ? [state as BullState] : ['waiting'];

  try {
    const { jobs, counts } = await withQueue(async (q) => {
      const [allJobs, waiting, active, delayed, failed, completed] = await Promise.all([
        q.getJobs(states, start, end, false),
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getDelayedCount(),
        q.getFailedCount(),
        q.getCompletedCount(),
      ]);
      return {
        jobs: allJobs,
        counts: { waiting, active, delayed, failed, completed },
      };
    });

    const total = states.reduce((acc, s) => acc + (counts[s] ?? 0), 0);
    res.json({
      jobs: jobs.map(serializeJob),
      total,
      page,
      limit,
      counts,
    });
  } catch (err) {
    log.error({ err }, 'Failed to get queue jobs');
    res.json({ jobs: [], total: 0, page, limit, counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 } });
  }
});

/**
 * Admin "Retry" of a dead letter: the retry window starts again now
 * (`expiryBaseMs`, otherwise an expired message fails again at once and the
 * sender gets a second 5.4.7 NDR) and the attempt counter is reset. Delivery
 * progress and the recipients that already got a final NDR stay in the job
 * data — the worker never sends them a second final NDR.
 */
export async function adminRetryJob(
  job: Pick<Job, 'data' | 'updateData' | 'retry'>,
  now = Date.now(),
): Promise<void> {
  await job.updateData(adminRetryJobData((job.data ?? {}) as Record<string, unknown>, now));
  await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
}

/**
 * "Retry now" for one job: a dead letter (failed) is retried with a fresh
 * retry window; a job waiting for its next attempt (delayed — the "Retry"
 * section and the overview) is promoted to run at once. `job.retry('failed')`
 * throws for delayed jobs, so before this the button always answered 500.
 * Returns false when the job is in neither state (waiting/active/completed).
 */
export async function adminRetryOrPromoteJob(
  job: Pick<Job, 'data' | 'updateData' | 'retry' | 'promote' | 'getState'>,
  now = Date.now(),
): Promise<boolean> {
  const state = await job.getState();
  if (state === 'failed') { await adminRetryJob(job, now); return true; }
  if (state === 'delayed') { await job.promote(); return true; }
  return false;
}

// ── POST /jobs/:id/retry ──────────────────────────────────────────────────────
adminQueuesRouter.post('/jobs/:id/retry', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  try {
    await withQueue(async (q) => {
      const job = await q.getJob(id);
      if (!job) { res.status(404).json({ error: 'Job nicht gefunden' }); return; }
      if (!(await adminRetryOrPromoteJob(job))) {
        res.status(409).json({ error: 'Job wartet nicht auf einen erneuten Versuch' });
        return;
      }
      log.info({ id }, 'Queue job retried');
      res.json({ ok: true });
    });
  } catch (err) {
    log.error({ err, id }, 'Failed to retry job');
    res.status(500).json({ error: 'Retry fehlgeschlagen' });
  }
});

// ── POST /retry-failed ────────────────────────────────────────────────────────
adminQueuesRouter.post('/retry-failed', async (_req: Request, res: Response) => {
  try {
    const retried = await withQueue(async (q) => {
      const failedJobs = await q.getFailed(0, 999);
      let count = 0;
      for (const job of failedJobs) {
        try { await adminRetryJob(job); count++; } catch { /* skip */ }
      }
      return count;
    });
    log.info({ retried }, 'Bulk retry of failed jobs');
    res.json({ retried });
  } catch (err) {
    log.error({ err }, 'Failed to retry-all');
    res.status(500).json({ error: 'Retry-All fehlgeschlagen' });
  }
});

// ── DELETE /jobs/:id ──────────────────────────────────────────────────────────
adminQueuesRouter.delete('/jobs/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  try {
    await withQueue(async (q) => {
      const job = await q.getJob(id);
      if (!job) { res.status(404).json({ error: 'Job nicht gefunden' }); return; }
      await job.remove();
      log.info({ id }, 'Queue job removed');
      res.status(204).end();
    });
  } catch (err) {
    log.error({ err, id }, 'Failed to remove job');
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

// ── POST /flush ───────────────────────────────────────────────────────────────
adminQueuesRouter.post('/flush', async (req: Request, res: Response) => {
  const schema = z.object({
    state: z.enum(['failed', 'delayed', 'completed', 'waiting']),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültiger State' }); return; }

  try {
    await withQueue(async (q) => {
      await q.clean(0, 0, p.data.state === 'waiting' ? 'wait' : p.data.state as 'failed' | 'delayed' | 'completed');
    });
    log.info({ state: p.data.state }, 'Queue flushed');
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Failed to flush queue');
    res.status(500).json({ error: 'Flush fehlgeschlagen' });
  }
});

// ── GET /settings ─────────────────────────────────────────────────────────────
adminQueuesRouter.get('/settings', async (_req: Request, res: Response) => {
  const settings = await prisma.queueSettings.upsert({
    where:  { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });
  res.json(settings);
});

// ── PUT /settings ─────────────────────────────────────────────────────────────
adminQueuesRouter.put('/settings', async (req: Request, res: Response) => {
  const schema = z.object({
    maxRetryAttempts:        z.number().int().min(1).max(50).optional(),
    retryBackoffDelaySec:    z.number().int().min(10).max(3600).optional(),
    deadLetterRetentionDays: z.number().int().min(1).max(365).optional(),
    outboundRetentionHours:  z.number().int().min(1).max(720).optional(),
    completedRetentionHours: z.number().int().min(1).max(720).optional(),
    autoFlushDead:           z.boolean().optional(),
    notifyOnDeadLetter:      z.boolean().optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Einstellungen' }); return; }

  const settings = await prisma.queueSettings.upsert({
    where:  { id: 'singleton' },
    update: p.data as Record<string, unknown>,
    create: { id: 'singleton', ...(p.data as Record<string, unknown>) },
  });
  log.info({ settings: p.data }, 'Queue settings updated');
  // 60 s caches: this process (REST producers) and the smtp-server worker
  // (settings:reload subscriber) pick the new retry/retention values up at once.
  invalidateQueueSettingsCache();
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ kind: 'queues' })).catch(() => undefined);
  res.json(settings);
});
