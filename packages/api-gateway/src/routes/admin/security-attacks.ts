/**
 * Admin — Sicherheitsangriffs-Events
 *
 * GET  /api/v1/admin/security/attacks     — Angriffsereignisse (paginiert, filterbar)
 * GET  /api/v1/admin/security/attacks/summary — Zusammenfassung (letzte 24 h)
 * DELETE /api/v1/admin/security/attacks   — Alle Events vor gegebenem Datum löschen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';

const log = createLogger('admin:security-attacks');
export const adminSecurityAttacksRouter: RouterType = Router();
adminSecurityAttacksRouter.use(requireAdmin);

// ── GET /api/v1/admin/security/attacks ───────────────────────────────────────
adminSecurityAttacksRouter.get('/', async (req: Request, res: Response) => {
  const QuerySchema = z.object({
    limit:  z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    type:   z.string().optional(),
    ip:     z.string().optional(),
    since:  z.string().datetime().optional(),
    until:  z.string().datetime().optional(),
  });

  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Query-Parameter' });
    return;
  }

  const { limit, offset, type, ip, since, until } = parsed.data;

  // Build where clause
  const whereType = type ? { type } : {};
  const whereIp   = ip   ? { ip: { contains: ip } } : {};
  const whereTs   = (since || until) ? {
    timestamp: {
      ...(since ? { gte: new Date(since) } : {}),
      ...(until ? { lte: new Date(until) } : {}),
    },
  } : {};
  const where = { ...whereType, ...whereIp, ...whereTs };

  const [events, total] = await Promise.all([
    prisma.attackEvent.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.attackEvent.count({ where }),
  ]);

  res.json({ events, total, limit, offset });
});

// ── GET /api/v1/admin/security/attacks/summary ───────────────────────────────
adminSecurityAttacksRouter.get('/summary', async (_req: Request, res: Response) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since1h  = new Date(Date.now() -      60 * 60 * 1000);

  const [total24h, total1h, byType, topIps, latestEvents] = await Promise.all([
    prisma.attackEvent.count({ where: { timestamp: { gte: since24h } } }),
    prisma.attackEvent.count({ where: { timestamp: { gte: since1h } } }),
    prisma.attackEvent.groupBy({
      by: ['type'],
      where: { timestamp: { gte: since24h } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
    prisma.attackEvent.groupBy({
      by: ['ip'],
      where: { timestamp: { gte: since24h } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.attackEvent.findMany({
      orderBy: { timestamp: 'desc' },
      take: 20,
    }),
  ]);

  res.json({
    total24h,
    total1h,
    byType: byType.map((b) => ({ type: b.type, count: b._count.id })),
    topIps: topIps.map((b) => ({ ip: b.ip, count: b._count.id })),
    latestEvents,
    isUnderAttack: total1h >= 10, // Heuristik: >= 10 Events in 1h
  });
});

// ── DELETE /api/v1/admin/security/attacks ────────────────────────────────────
adminSecurityAttacksRouter.delete('/', async (req: Request, res: Response) => {
  const schema = z.object({ before: z.string().datetime() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datum fehlt oder ungültig (ISO 8601)' });
    return;
  }
  const result = await prisma.attackEvent.deleteMany({
    where: { timestamp: { lt: new Date(parsed.data.before) } },
  });
  log.info({ deleted: result.count, before: parsed.data.before }, 'Attack events purged');
  res.json({ deleted: result.count });
});
