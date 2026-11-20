/**
 * Admin — security attack events
 *
 * GET  /api/v1/admin/security/attacks     — attack events (paginated, filterable)
 * GET  /api/v1/admin/security/attacks/summary — summary (last 24 h)
 * DELETE /api/v1/admin/security/attacks   — delete all events before a given date
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { isoDateTime } from '../../lib/zod-compat.js';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { requireUnscoped } from '../../middleware/admin-scope.js';
import { createLogger } from '@coremail/core';

const log = createLogger('admin:security-attacks');

/** 10.5: merges per-protocol counts (sorted by count, then name) — pure, tested. */
export function mergeProtocolCounts(...lists: Array<Array<{ key: string; count: number }>>): Array<{ protocol: string; count: number }> {
  const m = new Map<string, number>();
  for (const list of lists) for (const { key, count } of list) m.set(key, (m.get(key) ?? 0) + count);
  return [...m.entries()]
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count || a.protocol.localeCompare(b.protocol));
}
export const adminSecurityAttacksRouter: RouterType = Router();
adminSecurityAttacksRouter.use(requireArea('hygiene'), requireUnscoped); // 9.5: server-wide (connection IPs)

// ── GET /api/v1/admin/security/attacks ───────────────────────────────────────
adminSecurityAttacksRouter.get('/', async (req: Request, res: Response) => {
  const QuerySchema = z.object({
    limit:  z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    type:   z.string().optional(),
    ip:     z.string().optional(),
    since:  isoDateTime().optional(),
    until:  isoDateTime().optional(),
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

  const [total24h, total1h, byType, topIps, latestEvents, byProtocolRaw, byLegacyService] = await Promise.all([
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
    // 10.5: per protocol (smtp, imap, pop3, web, jmap, caldav, activesync, mapi, mcp, autodiscover, http)
    prisma.attackEvent.groupBy({
      by: ['protocol'],
      where: { timestamp: { gte: since24h }, protocol: { not: null } },
      _count: { id: true },
    }),
    // events written before 10.5 carry the protocol in `service` only
    prisma.attackEvent.groupBy({
      by: ['service'],
      where: { timestamp: { gte: since24h }, protocol: null },
      _count: { id: true },
    }),
  ]);

  res.json({
    total24h,
    total1h,
    byType: byType.map((b) => ({ type: b.type, count: b._count.id })),
    topIps: topIps.map((b) => ({ ip: b.ip, count: b._count.id })),
    byProtocol: mergeProtocolCounts(
      byProtocolRaw.map((b) => ({ key: b.protocol ?? 'unknown', count: b._count.id })),
      byLegacyService.map((b) => ({ key: b.service, count: b._count.id })),
    ),
    latestEvents: latestEvents.map((e) => ({ ...e, protocol: e.protocol ?? e.service })),
    isUnderAttack: total1h >= 10, // heuristic: >= 10 events in 1h
  });
});

// ── DELETE /api/v1/admin/security/attacks ────────────────────────────────────
adminSecurityAttacksRouter.delete('/', async (req: Request, res: Response) => {
  const schema = z.object({ before: isoDateTime() });
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
