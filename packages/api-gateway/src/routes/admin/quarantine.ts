/**
 * Admin-API: Quarantäne-Verwaltung
 *
 * GET    /api/v1/admin/quarantine                 — Liste (paginiert + Filter)
 * GET    /api/v1/admin/quarantine/stats           — Statistiken
 * POST   /api/v1/admin/quarantine/:id/release     — Freigeben (an Empfänger zustellen)
 * DELETE /api/v1/admin/quarantine/:id             — Endgültig löschen
 * DELETE /api/v1/admin/quarantine                 — Alle gelöschten / älter als X Tage löschen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:quarantine');
export const adminQuarantineRouter: RouterType = Router();
adminQuarantineRouter.use(requireAdmin);

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

// ── POST /:id/release ─────────────────────────────────────────────────────────
adminQuarantineRouter.post('/:id/release', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const item = await prisma.quarantine.findUnique({ where: { id } });
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  if (item.released) { res.status(409).json({ error: 'Bereits freigegeben' }); return; }

  const actorId = (req as Request & { userId?: string }).userId ?? 'system';

  await prisma.quarantine.update({
    where: { id },
    data: { released: true, releasedAt: new Date(), releasedBy: actorId },
  });

  // TODO: Tatsächliche SMTP-Zustellung der rohen Nachricht aus MinIO
  // (erfordert smtp-server Integration — hier nur DB-Update als Placeholder)
  log.info({ id, toAddr: item.toAddr, releasedBy: actorId }, 'Quarantine item released');
  res.json({ message: 'Nachricht freigegeben' });
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

// ── DELETE / (Bulk-Bereinigung) ───────────────────────────────────────────────
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
