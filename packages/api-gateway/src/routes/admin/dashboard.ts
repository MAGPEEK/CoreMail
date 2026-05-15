import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { Queue } from 'bullmq';
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

export const adminDashboardRouter: RouterType = Router();
adminDashboardRouter.use(requireAdmin);

const log = createLogger('api:admin:dashboard');

// ── BullMQ Outbound-Queue-Referenz ────────────────────────────────────────────
let _queue: Queue | null = null;
function getOutboundQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('smtp:outbound', { connection: getRedisClient() });
  }
  return _queue;
}

// ── GET /api/v1/admin/dashboard ───────────────────────────────────────────────
// Aggregiert alle Dashboard-Metriken in einem einzigen Aufruf.
adminDashboardRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const sevenDaysAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── Daten parallel abrufen ────────────────────────────────────────────────
    const [
      userTotal,
      userActive,
      userNewWeek,
      userStorageAgg,
      topStorageUsers,
      domainTotal,
      domainList,
      messageTotal,
      messageNewWeek,
      messageNewDay,
      groupTotal,
      sharedMailboxTotal,
      recentErrors,
      recentAuditEvents,
      mailsPerDay,
      queueCounts,
    ] = await Promise.all([
      // Benutzer
      prisma.user.count(),
      prisma.user.count({ where: { active: true } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.user.aggregate({ _sum: { usedBytes: true } }),

      // Top-10 Nutzer nach Speicherverbrauch
      prisma.user.findMany({
        where: { active: true },
        orderBy: { usedBytes: 'desc' },
        take: 10,
        select: {
          id: true, email: true, displayName: true,
          usedBytes: true, quotaBytes: true,
          domain: { select: { name: true } },
        },
      }),

      // Domains
      prisma.domain.count(),
      prisma.domain.findMany({
        select: {
          id: true, name: true, active: true,
          _count: { select: { users: true } },
        },
        orderBy: { name: 'asc' },
      }),

      // Nachrichten
      prisma.message.count({ where: { deletedAt: null } }),
      prisma.message.count({ where: { deletedAt: null, date: { gte: sevenDaysAgo } } }),
      prisma.message.count({ where: { deletedAt: null, date: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }),

      // Gruppen + Shared Mailboxes
      prisma.distributionGroup.count().catch(() => 0),
      prisma.sharedMailbox.count().catch(() => 0),

      // Letzte 10 Fehler- und Warn-Logs
      prisma.systemLog.findMany({
        where: { level: { in: ['ERROR', 'WARN'] }, timestamp: { gte: thirtyDaysAgo } },
        orderBy: { timestamp: 'desc' },
        take: 10,
        select: { id: true, timestamp: true, level: true, service: true, message: true },
      }).catch(() => [] as never[]),

      // Letzte 8 Audit-Events
      prisma.auditLog.findMany({
        orderBy: { timestamp: 'desc' },
        take: 8,
        select: {
          id: true, timestamp: true, actorEmail: true,
          action: true, targetType: true, targetName: true, success: true,
        },
      }).catch(() => [] as never[]),

      // Nachrichten pro Tag (letzte 7 Tage) — Gruppierung in PostgreSQL
      prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT DATE_TRUNC('day', date) AS day, COUNT(*)::bigint AS count
        FROM "Message"
        WHERE "deletedAt" IS NULL AND date >= ${sevenDaysAgo}
        GROUP BY DATE_TRUNC('day', date)
        ORDER BY day ASC
      `.catch(() => [] as { day: Date; count: bigint }[]),

      // BullMQ Queue-Status
      getOutboundQueue().getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed').catch(() => ({
        waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0,
      })),
    ]);

    // ── Mails-pro-Tag-Daten normalisieren ─────────────────────────────────────
    const dayMap = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, 0);
    }
    for (const row of mailsPerDay) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      if (dayMap.has(key)) dayMap.set(key, Number(row.count));
    }
    const mailsChart = Array.from(dayMap.entries()).map(([day, count]) => ({
      day: day.slice(5), // MM-DD
      count,
    }));

    // ── Speicher gesamt ───────────────────────────────────────────────────────
    const totalUsedBytes  = Number(userStorageAgg._sum.usedBytes ?? 0);

    // ── Antwort zusammenbauen ─────────────────────────────────────────────────
    res.json({
      users: {
        total:    userTotal,
        active:   userActive,
        inactive: userTotal - userActive,
        newWeek:  userNewWeek,
      },
      domains: {
        total: domainTotal,
        list:  domainList.map((d) => ({
          id:         d.id,
          name:       d.name,
          active:     d.active,
          userCount:  d._count.users,
        })),
      },
      messages: {
        total:      messageTotal,
        newDay:     messageNewDay,
        newWeek:    messageNewWeek,
        mailsChart,
      },
      storage: {
        totalUsedBytes,
        topUsers: topStorageUsers.map((u) => ({
          id:           u.id,
          email:        u.email,
          displayName:  u.displayName,
          domainName:   u.domain.name,
          usedBytes:    Number(u.usedBytes),
          quotaBytes:   Number(u.quotaBytes),
          usedPercent:  u.quotaBytes > 0n
            ? Math.round(Number(u.usedBytes) / Number(u.quotaBytes) * 100)
            : 0,
        })),
      },
      groups:        groupTotal,
      sharedMailboxes: sharedMailboxTotal,
      queues: {
        waiting:   queueCounts.waiting,
        active:    queueCounts.active,
        failed:    queueCounts.failed,
        delayed:   queueCounts.delayed,
        completed: queueCounts.completed,
      },
      recentErrors,
      recentAuditEvents,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    log.error({ err }, 'Dashboard-Fehler');
    res.status(500).json({ error: 'Dashboard nicht verfügbar' });
  }
});
