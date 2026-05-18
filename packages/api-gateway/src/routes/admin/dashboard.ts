import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { Queue } from 'bullmq';
import { prisma } from '@coremail/storage';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';
import os from 'node:os';
import v8 from 'node:v8';
import { readFile } from 'node:fs/promises';

// Boot-Zeit + Coremail-Version einmalig ermitteln
const PROCESS_STARTED_AT = new Date();
let _appVersion: string | null = null;
async function getAppVersion(): Promise<string> {
  if (_appVersion !== null) return _appVersion;
  try {
    const raw = await readFile(new URL('../../../../../package.json', import.meta.url), 'utf-8');
    _appVersion = (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    _appVersion = process.env['COREMAIL_VERSION'] ?? 'unknown';
  }
  return _appVersion;
}

export const adminDashboardRouter: RouterType = Router();
adminDashboardRouter.use(requireAdmin);

const log = createLogger('api:admin:dashboard');

// ── BullMQ Outbound-Queue-Referenz ────────────────────────────────────────────
let _queue: Queue | null = null;
function getOutboundQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('smtp-outbound', { connection: createBullMqConnection() }); // BullMQ v5: kein ':', maxRetriesPerRequest: null
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
      activeSessions,
      recentLogins,
      securityHits24h,
      appVersion,
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
        FROM "messages"
        WHERE "deletedAt" IS NULL AND date >= ${sevenDaysAgo}
        GROUP BY DATE_TRUNC('day', date)
        ORDER BY day ASC
      `.catch(() => [] as { day: Date; count: bigint }[]),

      // BullMQ Queue-Status
      getOutboundQueue().getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed').catch(() => ({
        waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0,
      })),

      // Aktive Sessions (nicht abgelaufen)
      prisma.session.count({ where: { expiresAt: { gt: now } } }).catch(() => 0),

      // Letzte erfolgreiche Logins (aus AuditLog mit action LIKE login)
      prisma.auditLog.findMany({
        where: { action: { contains: 'login', mode: 'insensitive' }, success: true },
        orderBy: { timestamp: 'desc' },
        take: 5,
        select: { id: true, timestamp: true, actorEmail: true, ipAddress: true, userAgent: true },
      }).catch(() => [] as never[]),

      // DNSBL-Hits in den letzten 24h
      prisma.dnsblHit.count({ where: { hitAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }).catch(() => 0),

      // Coremail-App-Version
      getAppVersion(),
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

    // ── Server-Metriken aus dem Node-Prozess ────────────────────────────────
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const load = os.loadavg();
    const server = {
      version:        appVersion,
      hostname:       os.hostname(),
      platform:       os.platform(),
      arch:           os.arch(),
      nodeVersion:    process.version,
      pid:            process.pid,
      uptimeSeconds:  Math.floor(process.uptime()),
      startedAt:      PROCESS_STARTED_AT.toISOString(),
      memory: {
        heapUsed:    mem.heapUsed,
        heapTotal:   mem.heapTotal,
        // V8 heap_size_limit = --max-old-space-size; das ist die echte Obergrenze
        heapLimit:   heapStats.heap_size_limit,
        rss:         mem.rss,
        systemTotal: os.totalmem(),
        systemFree:  os.freemem(),
      },
      cpu: {
        cores:  os.cpus().length,
        model:  os.cpus()[0]?.model ?? 'unknown',
        load1:  Math.round(load[0]! * 100) / 100,
        load5:  Math.round(load[1]! * 100) / 100,
        load15: Math.round(load[2]! * 100) / 100,
      },
    };

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
      server,
      activeSessions,
      recentLogins,
      securityHits24h,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    log.error({ err }, 'Dashboard-Fehler');
    res.status(500).json({ error: 'Dashboard nicht verfügbar' });
  }
});
