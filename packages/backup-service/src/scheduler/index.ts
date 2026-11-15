import { CronJob } from 'cron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, stat } from 'node:fs/promises';
import { prisma } from '@coremail/storage';
import { runRetentionPolicies, type RetentionRunResult } from '../retention/worker.js';
import { createLogger, getRedisClient } from '@coremail/core';
import { exportZip } from '../export/zip.js';
import { exportMbox } from '../export/mbox.js';
import { uploadToS3, getSignedDownloadUrl } from '../upload/s3.js';
import { claimSlot, withLock, LOCK_KEYS, type LockRedis, type LockResult } from './locks.js';

const log = createLogger('backup:scheduler');

function lockRedis(): LockRedis {
  return getRedisClient() as unknown as LockRedis;
}

/** Retention runs (cron or manual) never overlap cluster-wide. */
export function runRetentionLocked(r: LockRedis = lockRedis(), run: () => Promise<RetentionRunResult> = runRetentionPolicies): Promise<LockResult<RetentionRunResult>> {
  return withLock(r, LOCK_KEYS.retentionRun, run, { onRenewError: (err) => log.warn({ err }, 'Retention lock renewal failed') });
}

/**
 * v7.1.0: one retention run per cron fire across all instances — the instance
 * that claims the fire slot runs it, and only if no run is still in progress.
 */
export async function retentionTick(
  r: LockRedis = lockRedis(),
  run: () => Promise<RetentionRunResult> = runRetentionPolicies,
): Promise<'ran' | 'slot-taken' | 'busy'> {
  if (!(await claimSlot(r, LOCK_KEYS.retentionSlot))) return 'slot-taken';
  const out = await runRetentionLocked(r, run);
  if (out.ran) log.info(out.value, 'Retention policy run complete');
  return out.ran ? 'ran' : 'busy';
}

/**
 * v7.1.0: one backup per schedule fire across all instances, and never two
 * overlapping runs of the same schedule (the lock is held until the backup
 * job has finished, not just until it was queued).
 */
export async function scheduleTick(
  r: LockRedis,
  scheduleId: string,
  start: () => Promise<{ done: Promise<void> } | null>,
): Promise<'ran' | 'slot-taken' | 'busy'> {
  if (!(await claimSlot(r, LOCK_KEYS.scheduleSlot(scheduleId)))) return 'slot-taken';
  const out = await withLock(r, LOCK_KEYS.scheduleRun(scheduleId), async () => {
    const started = await start();
    await started?.done;
  }, { onRenewError: (err) => log.warn({ err, scheduleId }, 'Backup schedule lock renewal failed') });
  return out.ran ? 'ran' : 'busy';
}

// v3.18.26: Map cron string → running CronJob; updated on schedule CRUD
const activeJobs = new Map<string, CronJob>();
// v3.18.26: master CronJob for DB reload every minute (detects UI changes)
let scheduleReloader: CronJob | null = null;

/**
 * v3.18.26: the scheduler now reads from the DB table `BackupSchedule` instead of
 * only the env variable. Env BACKUP_SCHEDULE remains as a fallback for bootstrapping
 * (if no schedules exist in the DB yet). The reloader checks every 60s
 * whether schedules changed and adjusts active CronJobs.
 */
export function startBackupScheduler() {
  const retentionSchedule = process.env['RETENTION_SCHEDULE'] ?? '0 3 * * *';
  log.info({ retentionSchedule }, 'Starting backup scheduler — loading from DB');

  // Initial load
  void reloadSchedules();

  // Reloader: re-read the DB every 60s, synchronize schedules
  scheduleReloader = new CronJob('* * * * *', () => { void reloadSchedules(); }, null, true, 'UTC');

  // Retention policy stays env-driven (separate worker); v7.1.0: cluster-wide lock
  const retentionJob = new CronJob(
    retentionSchedule,
    async () => {
      try {
        const outcome = await retentionTick();
        if (outcome !== 'ran') log.info({ outcome }, 'Scheduled retention run skipped (handled by another instance or still running)');
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
 * v3.18.26: synchronize active cron jobs with DB content.
 */
async function reloadSchedules(): Promise<void> {
  try {
    const dbSchedules = await prisma.backupSchedule.findMany({ where: { enabled: true } });
    const dbIds = new Set(dbSchedules.map((s) => s.id));

    // Removed or disabled schedules: stop + remove
    for (const [id, job] of activeJobs) {
      if (!dbIds.has(id)) {
        job.stop();
        activeJobs.delete(id);
        log.info({ scheduleId: id }, 'Schedule deactivated — stopped CronJob');
      }
    }

    // New or changed schedules: start
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
            try {
              // v7.1.0: only one instance runs this fire; no overlap with a still-running run
              const outcome = await scheduleTick(lockRedis(), schedule.id, async () => {
                log.info({ scheduleId: schedule.id, name: schedule.name }, 'Schedule-triggered backup starting');
                let started: { done: Promise<void> } | null = null;
                if (schedule.scope === 'full') {
                  started = await runFullBackup({ triggeredBy: 'CRON', scheduleId: schedule.id });
                } else if (schedule.scope === 'user' && schedule.targetUserId) {
                  started = await runSingleMailboxBackup({
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
                return started;
              });
              if (outcome !== 'ran') {
                log.info({ scheduleId: schedule.id, outcome }, 'Scheduled backup skipped (handled by another instance or still running)');
              }
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
        // invalid cron expression — DB update + skip
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
 * v3.18.26 fix: writes ONE master job upfront with status=RUNNING, then
 * child jobs per user. The frontend immediately sees a RUNNING job.
 */
export async function runFullBackup(opts: RunOpts = {}): Promise<{ jobId: string; done: Promise<void> }> {
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

  const work = async (): Promise<void> => {
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
        // Progress update on the master job
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
  };
  // v7.1.0: done settles when the backup has finished (scheduler run lock)
  const done = runInBackground(work, masterJob.id);
  return { jobId: masterJob.id, done };
}

/**
 * v3.18.26: per-mailbox backup (admin action or schedule).
 * Synchronously returnable jobId, the async worker does the rest.
 */
export async function runSingleMailboxBackup(opts: {
  userId: string;
  format: 'mbox' | 'zip';
  folderIds?: string[] | null;
  triggeredBy?: string;
  scheduleId?: string;
}): Promise<{ jobId: string; done: Promise<void> }> {
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

  const work = async (): Promise<void> => {
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
  };
  const done = runInBackground(work, job.id);
  return { jobId: job.id, done };
}

/** Runs the job body after the response (setImmediate); never rejects. */
function runInBackground(work: () => Promise<void>, jobId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      work().catch((err: unknown) => log.error({ err, jobId }, 'Backup job crashed')).finally(resolve);
    });
  });
}

/**
 * Classifies errors by typical backup failure modes for RTO reporting.
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
 * v3.18.26 BC layer: old function with the same signature as before (for
 * imports in restore/server.ts that are not migrated yet).
 */
export async function runUserBackup(
  userId: string,
  format: 'mbox' | 'zip',
  folderIds: string[] | null,
): Promise<{ jobId: string; downloadUrl: string }> {
  const { jobId } = await runSingleMailboxBackup({ userId, format, folderIds, triggeredBy: 'API' });
  return { jobId, downloadUrl: '' };
}
