import { CronJob } from 'cron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, stat } from 'node:fs/promises';
import { prisma } from '@coremail/storage';
import { runRetentionPolicies } from '../retention/worker.js';
import { createLogger } from '@coremail/core';
import { exportZip } from '../export/zip.js';
import { exportMbox } from '../export/mbox.js';
import { uploadToS3, getSignedDownloadUrl } from '../upload/s3.js';

const log = createLogger('backup:scheduler');

// v3.18.26: Map cron-string → running CronJob; aktualisiert bei Schedule-CRUD
const activeJobs = new Map<string, CronJob>();
// v3.18.26: Master-CronJob für DB-Reload alle Minuten (erkennt UI-Änderungen)
let scheduleReloader: CronJob | null = null;

/**
 * v3.18.26: Scheduler liest jetzt aus DB-Tabelle `BackupSchedule` statt nur
 * aus Env-Variable. Env-BACKUP_SCHEDULE bleibt als Fallback für Bootstrapping
 * (falls noch keine Schedules in der DB existieren). Reloader prüft alle 60s
 * ob sich Schedules geändert haben und passt aktive CronJobs an.
 */
export function startBackupScheduler() {
  const retentionSchedule = process.env['RETENTION_SCHEDULE'] ?? '0 3 * * *';
  log.info({ retentionSchedule }, 'Starting backup scheduler — loading from DB');

  // Initial laden
  void reloadSchedules();

  // Reloader: alle 60s DB neu lesen, Schedules synchronisieren
  scheduleReloader = new CronJob('* * * * *', () => { void reloadSchedules(); }, null, true, 'UTC');

  // Retention-Policy bleibt aus Env (eigener Worker)
  const retentionJob = new CronJob(
    retentionSchedule,
    async () => {
      log.info('Starting scheduled retention policy run');
      try {
        const result = await runRetentionPolicies();
        log.info(result, 'Retention policy run complete');
      } catch (err) {
        log.error({ err }, 'Retention policy run failed');
      }
    },
    null,
    true,
    'UTC'
  );

  return { scheduleReloader, retentionJob };
}

/**
 * v3.18.26: Aktive Cron-Jobs mit DB-Inhalt synchronisieren.
 */
async function reloadSchedules(): Promise<void> {
  try {
    const dbSchedules = await prisma.backupSchedule.findMany({ where: { enabled: true } });
    const dbIds = new Set(dbSchedules.map((s) => s.id));

    // Entfernte oder deaktivierte Schedules: stop + remove
    for (const [id, job] of activeJobs) {
      if (!dbIds.has(id)) {
        job.stop();
        activeJobs.delete(id);
        log.info({ scheduleId: id }, 'Schedule deactivated — stopped CronJob');
      }
    }

    // Neue oder geänderte Schedules: starten
    for (const schedule of dbSchedules) {
      const existing = activeJobs.get(schedule.id);
      const currentCron = existing?.cronTime?.source as string | undefined;
      if (existing && currentCron === schedule.cron) continue; // unchanged

      if (existing) {
        existing.stop();
        activeJobs.delete(schedule.id);
      }

      try {
        const job = new CronJob(
          schedule.cron,
          async () => {
            log.info({ scheduleId: schedule.id, name: schedule.name }, 'Schedule-triggered backup starting');
            try {
              if (schedule.scope === 'full') {
                await runFullBackup({ triggeredBy: 'CRON', scheduleId: schedule.id });
              } else if (schedule.scope === 'user' && schedule.targetUserId) {
                await runSingleMailboxBackup({
                  userId: schedule.targetUserId,
                  format: (schedule.format === 'mbox' ? 'mbox' : 'zip'),
                  triggeredBy: 'CRON',
                  scheduleId: schedule.id,
                });
              }
              await prisma.backupSchedule.update({
                where: { id: schedule.id },
                data: { lastRunAt: new Date(), lastStatus: 'COMPLETED' },
              });
            } catch (err) {
              log.error({ err, scheduleId: schedule.id }, 'Scheduled backup failed');
              await prisma.backupSchedule.update({
                where: { id: schedule.id },
                data: { lastRunAt: new Date(), lastStatus: 'FAILED' },
              }).catch(() => undefined);
            }
          },
          null,
          true,
          'UTC',
        );
        activeJobs.set(schedule.id, job);
        log.info({ scheduleId: schedule.id, cron: schedule.cron, name: schedule.name }, 'Schedule registered');
      } catch (err) {
        // ungültige Cron-Expression — DB-Update + skip
        log.error({ err, scheduleId: schedule.id, cron: schedule.cron }, 'Invalid cron expression');
        await prisma.backupSchedule.update({
          where: { id: schedule.id },
          data: { lastStatus: 'INVALID_CRON' },
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    log.error({ err }, 'reloadSchedules failed');
  }
}

interface RunOpts {
  triggeredBy?: string;
  scheduleId?: string;
}

/**
 * v3.18.26 fix: Schreibt EINEN Master-Job upfront mit status=RUNNING, dann
 * pro User Child-Jobs. Frontend sieht sofort einen RUNNING-Job.
 */
export async function runFullBackup(opts: RunOpts = {}): Promise<{ jobId: string }> {
  const startedAt = new Date();
  const masterJob = await prisma.backupJob.create({
    data: {
      scope: 'full',
      format: 'zip',
      status: 'RUNNING',
      triggeredBy: opts.triggeredBy ?? 'MANUAL',
      ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
      startedAt,
    },
  });

  setImmediate(async () => {
    try {
      const users = await prisma.user.findMany({
        where: { active: true },
        select: { id: true, email: true },
      });
      const dateStr = new Date().toISOString().slice(0, 10);
      let total = 0;
      let totalSize = 0n;
      let totalMessages = 0;

      for (let i = 0; i < users.length; i++) {
        const user = users[i]!;
        // Progress-Update am Master-Job
        await prisma.backupJob.update({
          where: { id: masterJob.id },
          data: {
            progress: Math.round(((i + 1) / users.length) * 100),
            progressMeta: { phase: 'user-export', current: i + 1, total: users.length, currentUser: user.email },
          },
        }).catch(() => undefined);

        try {
          const outPath = join(tmpdir(), `coremail-backup-${user.id}-${Date.now()}.zip`);
          const { fileCount } = await exportZip(user.id, null, outPath);
          const s3Key = `full-backup/${dateStr}/${user.email.replace('@', '_at_')}.zip`;
          await uploadToS3(outPath, s3Key, 'application/zip');
          const fileSize = (await stat(outPath).catch(() => null))?.size ?? 0;
          await unlink(outPath).catch(() => undefined);

          await prisma.backupJob.create({
            data: {
              userId: user.id,
              scope: 'user',
              format: 'zip',
              status: 'COMPLETED',
              downloadUrl: s3Key,
              startedAt,
              completedAt: new Date(),
              durationMs: Date.now() - startedAt.getTime(),
              sizeBytes: BigInt(fileSize),
              messageCount: fileCount,
              triggeredBy: opts.triggeredBy ?? 'MANUAL',
              ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
            },
          });
          total++;
          totalSize += BigInt(fileSize);
          totalMessages += fileCount;
        } catch (err) {
          log.error({ err, userId: user.id }, 'User backup failed');
          const errorClass = classifyError(err);
          await prisma.backupJob.create({
            data: {
              userId: user.id,
              scope: 'user',
              format: 'zip',
              status: 'FAILED',
              errorMsg: err instanceof Error ? err.message : String(err),
              errorClass,
              startedAt,
              completedAt: new Date(),
              triggeredBy: opts.triggeredBy ?? 'MANUAL',
              ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
            },
          });
        }
      }

      const finishedAt = new Date();
      await prisma.backupJob.update({
        where: { id: masterJob.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          completedAt: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          sizeBytes: totalSize,
          messageCount: totalMessages,
          progressMeta: { phase: 'done', current: total, total: users.length },
        },
      });
      log.info({ userCount: total, masterJobId: masterJob.id }, 'Full backup complete');
    } catch (err) {
      log.error({ err, masterJobId: masterJob.id }, 'Full backup failed');
      await prisma.backupJob.update({
        where: { id: masterJob.id },
        data: {
          status: 'FAILED',
          errorMsg: err instanceof Error ? err.message : String(err),
          errorClass: classifyError(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  });

  return { jobId: masterJob.id };
}

/**
 * v3.18.26: Per-Mailbox-Backup (Admin-Aktion oder Schedule).
 * Synchron returnable jobId, async Worker macht den Rest.
 */
export async function runSingleMailboxBackup(opts: {
  userId: string;
  format: 'mbox' | 'zip';
  folderIds?: string[] | null;
  triggeredBy?: string;
  scheduleId?: string;
}): Promise<{ jobId: string }> {
  const startedAt = new Date();
  const job = await prisma.backupJob.create({
    data: {
      userId: opts.userId,
      scope: 'user',
      format: opts.format,
      status: 'RUNNING',
      triggeredBy: opts.triggeredBy ?? 'MANUAL',
      ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
      startedAt,
    },
  });

  setImmediate(async () => {
    try {
      const outPath = join(tmpdir(), `coremail-mbox-${opts.userId}-${Date.now()}.${opts.format === 'mbox' ? 'mbox' : 'zip'}`);
      const folderIds = opts.folderIds ?? null;
      let fileCount = 0;

      if (opts.format === 'mbox') {
        await exportMbox(opts.userId, folderIds, outPath);
      } else {
        const r = await exportZip(opts.userId, folderIds, outPath);
        fileCount = r.fileCount;
      }

      const s3Key = `mailbox/${opts.userId}/${Date.now()}.${opts.format === 'mbox' ? 'mbox' : 'zip'}`;
      const contentType = opts.format === 'mbox' ? 'application/mbox' : 'application/zip';
      await uploadToS3(outPath, s3Key, contentType);
      const fileSize = (await stat(outPath).catch(() => null))?.size ?? 0;
      await unlink(outPath).catch(() => undefined);
      const downloadUrl = await getSignedDownloadUrl(s3Key);

      const finishedAt = new Date();
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          downloadUrl,
          completedAt: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          sizeBytes: BigInt(fileSize),
          messageCount: fileCount,
          expiresAt: new Date(Date.now() + 3600 * 1000),
        },
      });
    } catch (err) {
      log.error({ err, jobId: job.id }, 'Single-mailbox backup failed');
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorMsg: err instanceof Error ? err.message : String(err),
          errorClass: classifyError(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  });

  return { jobId: job.id };
}

/**
 * Klassifiziert Fehler nach typischen Backup-Failure-Modes für RTO-Reporting.
 */
function classifyError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('econn') || msg.includes('etimedout') || msg.includes('network')) return 'NETWORK';
  if (msg.includes('nosuchbucket') || msg.includes('s3') || msg.includes('storage') || msg.includes('enospc')) return 'STORAGE';
  if (msg.includes('access denied') || msg.includes('permission') || msg.includes('eacces')) return 'PERMISSION';
  if (msg.includes('parse') || msg.includes('corrupt') || msg.includes('invalid')) return 'CORRUPT';
  return 'UNKNOWN';
}

/**
 * v3.18.26 BC-Layer: alte Funktion mit gleicher Signatur wie vorher (für
 * Imports in restore/server.ts die noch nicht migriert sind).
 */
export async function runUserBackup(
  userId: string,
  format: 'mbox' | 'zip',
  folderIds: string[] | null,
): Promise<{ jobId: string; downloadUrl: string }> {
  const { jobId } = await runSingleMailboxBackup({ userId, format, folderIds, triggeredBy: 'API' });
  return { jobId, downloadUrl: '' };
}
