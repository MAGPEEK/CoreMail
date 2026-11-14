/**
 * Admin API: quarantine management
 *
 * GET    /api/v1/admin/quarantine                 — list (paginated + filters)
 * GET    /api/v1/admin/quarantine/stats           — statistics
 * POST   /api/v1/admin/quarantine/:id/release     — release (deliver to recipient)
 * DELETE /api/v1/admin/quarantine/:id             — delete permanently
 * DELETE /api/v1/admin/quarantine                 — delete all deleted / older than X days
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, downloadBuffer } from '@coremail/storage';
import { getOutboundJobOptions } from '@coremail/storage/queue-options';
import { createLogger, createBullMqConnection } from '@coremail/core';
import { Queue } from 'bullmq';
import { requireArea } from '../../middleware/auth.js';
import { audit, auditContext } from '../../lib/audit.js';
import { releaseQuarantine, ReleaseError, type ReleaseDeps, type ReleaseJob } from '../../lib/quarantine-release.js';

const log = createLogger('admin:quarantine');

// BullMQ v5: no ':' in queue names — must match smtp-server ('smtp-outbound')
let _outboundQueue: Queue | null = null;
function getOutboundQueue(): Queue {
  if (!_outboundQueue) {
    _outboundQueue = new Queue('smtp-outbound', { connection: createBullMqConnection() });
  }
  return _outboundQueue;
}

const releaseDeps: ReleaseDeps = {
  findById: (id) => prisma.quarantine.findUnique({ where: { id } }),
  claim: async (id, releasedBy, at) => {
    const { count } = await prisma.quarantine.updateMany({
      where: { id, released: false },
      data:  { released: true, releasedAt: at, releasedBy },
    });
    return count;
  },
  unclaim: async (id) => {
    await prisma.quarantine.update({
      where: { id },
      data:  { released: false, releasedAt: null, releasedBy: null },
    });
  },
  download: (path) => downloadBuffer(path),
  enqueue: async (job: ReleaseJob) => {
    const added = await getOutboundQueue().add('send', job, {
      ...(await getOutboundJobOptions()),
      jobId: job.messageId,
    });
    return added.id ?? '';
  },
  isLocalAddress: async (addr) => {
    const domain = addr.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return !!(await prisma.domain.findFirst({ where: { name: domain, active: true }, select: { id: true } }));
  },
};
export const adminQuarantineRouter: RouterType = Router();
adminQuarantineRouter.use(requireArea('hygiene'));

// ── GET /stats ────────────────────────────────────────────────────────────────
adminQuarantineRouter.get('/stats', async (_req: Request, res: Response) => {
  const [total, virus, spam, policy, released] = await Promise.all([
    prisma.quarantine.count(),
    prisma.quarantine.count({ where: { reason: 'VIRUS' } }),
    prisma.quarantine.count({ where: { reason: 'SPAM' } }),
    prisma.quarantine.count({ where: { reason: 'POLICY' } }),
    prisma.quarantine.count({ where: { released: true } }),
  ]);
  res.json({ total, virus, spam, policy, released, pending: total - released });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
adminQuarantineRouter.get('/', async (req: Request, res: Response) => {
  const { search = '', reason = '', released = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: Record<string, unknown> = {};
  if (reason) where['reason'] = reason;
  if (released !== '') where['released'] = released === 'true';
  if (search) {
    where['OR'] = [
      { fromAddr: { contains: search, mode: 'insensitive' } },
      { toAddr:   { contains: search, mode: 'insensitive' } },
      { subject:  { contains: search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.quarantine.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip, take: parseInt(limit),
      select: {
        id: true, messageId: true, fromAddr: true, toAddr: true,
        subject: true, reason: true, details: true,
        released: true, releasedAt: true, releasedBy: true, createdAt: true,
      },
    }),
    prisma.quarantine.count({ where }),
  ]);
  res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminQuarantineRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const item = await prisma.quarantine.findUnique({ where: { id } });
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }

  // Try to fetch a preview of the raw message from MinIO
  let preview: { headers: Record<string, string>; bodyText: string } | null = null;
  try {
    const raw = await downloadBuffer(item.rawPath);
    const text = raw.toString('utf8');

    // Parse headers (up to blank line)
    const blankLine = text.indexOf('\r\n\r\n');
    const headerBlock = blankLine > -1 ? text.slice(0, blankLine) : text.slice(0, 2000);
    const bodyBlock   = blankLine > -1 ? text.slice(blankLine + 4) : '';

    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/)) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (m) headers[m[1]!] = m[2]!;
    }

    // Extract plain text body (strip MIME boundaries, base64 etc.)
    const bodyText = bodyBlock
      .replace(/--[^\r\n]+(\r?\n)?/g, '')
      .replace(/Content-[^\r\n]+(\r?\n)?/g, '')
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[base64]')
      .slice(0, 2000)
      .trim();

    preview = { headers, bodyText };
  } catch {
    // MinIO not available or object missing — return without preview
  }

  res.json({ ...item, preview });
});

// ── POST /:id/release ─────────────────────────────────────────────────────────
adminQuarantineRouter.post('/:id/release', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const actorId = req.apiUser?.userId ?? 'system';
  const actorEmail = req.apiUser?.email;

  try {
    const result = await releaseQuarantine(id, actorId, releaseDeps);
    audit({
      actorId,
      ...(actorEmail ? { actorEmail } : {}),
      action: 'quarantine.release',
      targetType: 'quarantine',
      targetId: id,
      targetName: result.recipients.join(', '),
      changes: { from: result.from, local: result.local, external: result.external, jobId: result.jobId },
      ...auditContext(req),
    });
    log.info({ id, recipients: result.recipients, releasedBy: actorId, jobId: result.jobId }, 'Quarantine item released');
    res.json({ message: 'Message released', recipients: result.recipients, jobId: result.jobId });
  } catch (err) {
    if (err instanceof ReleaseError) {
      if (err.status >= 500) log.error({ id, err: err.message }, 'Quarantine release failed');
      res.status(err.status).json({ error: err.message });
      return;
    }
    log.error({ err, id }, 'Quarantine release failed');
    res.status(500).json({ error: 'Release failed' });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminQuarantineRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.quarantine.delete({ where: { id } });
    log.info({ id }, 'Quarantine item deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── DELETE / (bulk cleanup) ───────────────────────────────────────────────────
adminQuarantineRouter.delete('/', async (req: Request, res: Response) => {
  const schema = z.object({
    olderThanDays: z.number().int().min(1).max(365).optional(),
    onlyReleased:  z.boolean().default(false),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }

  const where: Record<string, unknown> = {};
  if (p.data.onlyReleased) where['released'] = true;
  if (p.data.olderThanDays) {
    where['createdAt'] = { lt: new Date(Date.now() - p.data.olderThanDays * 86_400_000) };
  }

  const { count } = await prisma.quarantine.deleteMany({ where });
  log.info({ count, filter: p.data }, 'Quarantine bulk delete');
  res.json({ deleted: count });
});
