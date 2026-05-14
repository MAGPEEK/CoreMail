/**
 * Admin API — Audit Log (Phase 10)
 *
 * ECP → Compliance Management → Audit Log
 *
 * Routes:
 *   GET    /api/v1/admin/audit-log                — list (filterable, paginated)
 *   GET    /api/v1/admin/audit-log/export         — CSV export
 *   DELETE /api/v1/admin/audit-log/purge          — purge old entries (admin)
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminAuditLogRouter: RouterType = Router();
adminAuditLogRouter.use(requireAuth, requireAdmin);

/**
 * GET /api/v1/admin/audit-log
 * Query parameters:
 *   actorId, action, targetType, targetId, success, from, to, limit (max 500), offset
 */
adminAuditLogRouter.get('/', async (req: Request, res: Response) => {
  const {
    actorId,
    action,
    targetType,
    targetId,
    success,
    from,
    to,
    limit: limitStr,
    offset: offsetStr,
  } = req.query as Record<string, string | undefined>;

  const limit = Math.min(parseInt(limitStr ?? '100', 10), 500);
  const offset = parseInt(offsetStr ?? '0', 10);

  const where: Record<string, unknown> = {};
  if (actorId) where['actorId'] = actorId;
  if (action) where['action'] = { contains: action };
  if (targetType) where['targetType'] = targetType;
  if (targetId) where['targetId'] = targetId;
  if (success !== undefined) where['success'] = success === 'true';
  if (from || to) {
    where['timestamp'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ total, limit, offset, entries });
});

/**
 * GET /api/v1/admin/audit-log/export
 * Export audit log as CSV (same filters as GET /).
 */
adminAuditLogRouter.get('/export', async (req: Request, res: Response) => {
  const { action, targetType, from, to } = req.query as Record<string, string | undefined>;

  const where: Record<string, unknown> = {};
  if (action) where['action'] = { contains: action };
  if (targetType) where['targetType'] = targetType;
  if (from || to) {
    where['timestamp'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 10_000,
  });

  const csvHeader = 'timestamp,actorEmail,action,targetType,targetId,targetName,ipAddress,success,errorMsg';
  const csvRows = entries.map((e) =>
    [
      e.timestamp.toISOString(),
      csvEscape(e.actorEmail ?? ''),
      csvEscape(e.action),
      csvEscape(e.targetType ?? ''),
      csvEscape(e.targetId ?? ''),
      csvEscape(e.targetName ?? ''),
      csvEscape(e.ipAddress ?? ''),
      e.success ? 'true' : 'false',
      csvEscape(e.errorMsg ?? ''),
    ].join(','),
  );

  const csv = [csvHeader, ...csvRows].join('\n');
  const dateStr = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.csv"`);
  res.send(csv);
});

/**
 * DELETE /api/v1/admin/audit-log/purge
 * Purge audit log entries older than `before` date.
 * Body: { before: ISO-date-string }
 */
adminAuditLogRouter.delete('/purge', async (req: Request, res: Response) => {
  const { before } = req.body as { before?: string };
  if (!before) {
    res.status(400).json({ error: 'before date is required' });
    return;
  }

  const beforeDate = new Date(before);
  if (isNaN(beforeDate.getTime())) {
    res.status(400).json({ error: 'Invalid date format' });
    return;
  }

  const { count } = await prisma.auditLog.deleteMany({
    where: { timestamp: { lt: beforeDate } },
  });

  res.json({ ok: true, deleted: count });
});

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
