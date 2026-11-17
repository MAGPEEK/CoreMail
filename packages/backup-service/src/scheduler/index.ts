import { CronJob } from 'cron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, stat } from 'node:fs/promises';
import { prisma, notifyUserInbox } from '@coremail/storage';
import { runRetentionPolicies, type RetentionRunResult } from '../retention/worker.js';
import { createLogger, getRedisClient } from '@coremail/core';
import { exportZip } from '../export/zip.js';
import { exportMbox } from '../export/mbox.js';
import { uploadToS3, getSignedDownloadUrl, deleteObject } from '../upload/s3.js';
import {
  scheduleSignature, retentionCutoff, retentionWindow, newestArchivePerMailbox, fullBackupUserKey, failureNotice,
  type ScheduleData,
} from './schedule-input.js';
import { claimSlot, withLock, LOCK_KEYS, type LockRedis, type LockResult } from './locks.js';
import { runInBackground, classifyError, type JobOutcome } from './run-helpers.js';
import { runSystemBackup } from './system-backup.js';
import { JobHeartbeat } from './job-progress.js';

export { classifyError, type JobOutcome } from './run-helpers.js';
export { runSystemBackup } from './system-backup.js';

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
  start: () => Promise<{ done: Promise<unknown> } | null>,
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
 * v3.18.26: the scheduler reads the DB table `BackupSchedule`. (The env
 * variables BACKUP_SCHEDULE / BACKUP_RETENTION_DAYS never started a backup by
 * themselves; since 9.3 they are the defaults of "Empfohlene Sicherung
 * einrichten" in the BCP.) The reloader checks every 60s whether schedules
 * changed and adjusts active CronJobs.
 */
export function startBackupScheduler() {
  const retentionSchedule = process.env['RETENTION_SCHEDULE'] ?? '0 3 * * *';
  log.info({ retentionSchedule }, 'Starting backup scheduler — loading from DB');

  // Initial load
  void reloadSchedules().then(() => warnWithoutSchedules());

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

/** 9.3: a clear start-up warning when no automatic mailbox backup is configured. */
async function warnWithoutSchedules(): Promise<void> {
  try {
    const n = await prisma.backupSchedule.count({ where: { enabled: true, scope: 'full' } });
    if (n === 0) {
      log.warn('No automatic full backup is configured — BCP → Backup & Restore → Zeitpläne → "Empfohlene Sicherung einrichten"');
    }
  } catch { /* informational only */ }
}

/** Signature each registered CronJob was created with (9.1.x: scope/format/target changes re-register). */
const activeSignatures = new Map<string, string>();

const RETENTION_SINCE_KEY = 'backup:retention:enforced-since';

/**
 * First time schedule retention was enforced on this installation (Redis, set once).
 * If the key is lost it is set again to "now" — that only ever keeps more backups.
 */
async function retentionEnforcedSince(now: Date): Promise<Date> {
  const redis = getRedisClient() as unknown as {
    set(k: string, v: string, nx: 'NX'): Promise<unknown>; get(k: string): Promise<string | null>;
  };
  await redis.set(RETENTION_SINCE_KEY, now.toISOString(), 'NX');
  const raw = await redis.get(RETENTION_SINCE_KEY);
  const since = raw ? new Date(raw) : now;
  return Number.isNaN(since.getTime()) ? now : since;
}

/** Every stored object of a job: the archive plus companions (9.3: system backup manifest). */
export function jobObjectKeys(job: { downloadUrl: string | null; progressMeta?: unknown }): string[] {
  const keys = job.downloadUrl ? [job.downloadUrl] : [];
  const meta = job.progressMeta && typeof job.progressMeta === 'object' ? job.progressMeta as { extraKeys?: unknown } : {};
  if (Array.isArray(meta.extraKeys)) {
    for (const k of meta.extraKeys) if (typeof k === 'string' && k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * 9.1.x: BackupSchedule.retentionDays was stored but never applied. After a
 * schedule run, backups of THAT schedule older than retentionDays are removed
 * (stored object + job row). Manual backups are never touched. Best effort.
 */
export async function purgeExpiredScheduleBackups(scheduleId: string, retentionDays: number, now: Date = new Date()): Promise<number> {
  const window = retentionWindow(await retentionEnforcedSince(now), retentionCutoff(retentionDays, now));
  if (!window) return 0;
  // The newest completed archive of every mailbox in the schedule is always kept
  // (full schedules store one archive per user in child jobs).
  const completed = await prisma.backupJob.findMany({
    where: { scheduleId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true, downloadUrl: true },
    take: 5000,
  });
  const keep = newestArchivePerMailbox(completed);
  const expired = (await prisma.backupJob.findMany({
    where: { scheduleId, status: { in: ['COMPLETED', 'FAILED', 'EXPIRED'] }, createdAt: window },
    select: { id: true, downloadUrl: true, progressMeta: true },
    take: 500,
  })).filter((j) => !keep.has(j.id));
  let removed = 0;
  for (const j of expired) {
    let ok = true;
    for (const key of jobObjectKeys(j)) {
      try { await deleteObject(key); }
      catch (err) { log.warn({ err, jobId: j.id, key }, 'Expired backup object could not be deleted — kept'); ok = false; break; }
    }
    if (!ok) continue;
    await prisma.backupJob.delete({ where: { id: j.id } }).catch(() => undefined);
    removed++;
  }
  if (removed > 0) log.info({ scheduleId, removed, retentionDays }, 'Expired scheduled backups removed');
  return removed;
}

type ScheduleRow = ScheduleData & { id: string };

/** Starts the backup of a schedule (scope full / user / system); null for an invalid row. */
export async function startScheduleBackup(schedule: ScheduleRow, triggeredBy: 'CRON' | 'MANUAL'): Promise<{ jobId: string; done: Promise<JobOutcome> } | null> {
  if (schedule.scope === 'full') return runFullBackup({ triggeredBy, scheduleId: schedule.id });
  if (schedule.scope === 'system') return runSystemBackup({ triggeredBy, scheduleId: schedule.id });
  if (schedule.scope === 'user' && schedule.targetUserId) {
    return runSingleMailboxBackup({
      userId: schedule.targetUserId,
      format: schedule.format === 'mbox' ? 'mbox' : 'zip',
      triggeredBy,
      scheduleId: schedule.id,
    });
  }
  return null;
}

/** lastStatus of a schedule for a finished run: COMPLETED, PARTIAL (some mailboxes failed) or FAILED. */
export function scheduleStatusOf(o: Pick<JobOutcome, 'status' | 'failed'>): 'COMPLETED' | 'PARTIAL' | 'FAILED' {
  if (o.status === 'FAILED') return 'FAILED';
  return o.failed > 0 ? 'PARTIAL' : 'COMPLETED';
}

/**
 * After a schedule run finished: record lastRunAt / lastStatus / lastJobId (9.3:
 * the status of the FINISHED job — it used to be set to COMPLETED as soon as
 * the job was queued), expire old backups of the schedule and notify the
 * admins when a scheduled (cron) run failed.
 */
export async function finishScheduleRun(schedule: ScheduleRow, outcome: JobOutcome, triggeredBy: 'CRON' | 'MANUAL'): Promise<void> {
  const status = scheduleStatusOf(outcome);
  await prisma.backupSchedule.update({
    where: { id: schedule.id },
    data: { lastRunAt: new Date(), lastStatus: status, lastJobId: outcome.jobId },
  }).catch((err: unknown) => log.warn({ err, scheduleId: schedule.id }, 'Schedule status update failed'));
  if (status !== 'FAILED') {
    try {
      const cur = await prisma.backupSchedule.findUnique({ where: { id: schedule.id }, select: { retentionDays: true } });
      if (cur) await purgeExpiredScheduleBackups(schedule.id, cur.retentionDays);
    } catch (err) {
      log.warn({ err, scheduleId: schedule.id }, 'Backup retention cleanup failed');
    }
  }
  if (status !== 'COMPLETED' && triggeredBy === 'CRON') await notifyBackupFailure(schedule, outcome);
}

const NOTIFY_THROTTLE_SEC = 6 * 3600;

/**
 * 9.3: failure notice into the INBOX of every active ORGANIZATION_MANAGEMENT /
 * SERVER_MANAGEMENT admin (internal notification, no SMTP), at most once per
 * schedule every 6 hours.
 */
export async function notifyBackupFailure(schedule: Pick<ScheduleRow, 'id' | 'name' | 'scope'>, outcome: JobOutcome): Promise<number> {
  try {
    const redis = getRedisClient() as unknown as { set(k: string, v: string, ex: 'EX', s: number, nx: 'NX'): Promise<string | null> };
    if ((await redis.set(`backup:notify:${schedule.id}`, '1', 'EX', NOTIFY_THROTTLE_SEC, 'NX')) !== 'OK') return 0;
    const admins = await prisma.user.findMany({
      where: { active: true, role: { in: ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'] } },
      select: { id: true },
      take: 20,
    });
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }).catch(() => null);
    const host = settings?.publicHostname ?? 'CoreMail';
    const notice = failureNotice(schedule, outcome, host);
    for (const a of admins) {
      await notifyUserInbox({
        recipientUserId: a.id,
        fromName: 'CoreMail Backup',
        fromAddr: `postmaster@${host}`,
        subject: notice.subject,
        bodyText: notice.bodyText,
      });
    }
    log.warn({ scheduleId: schedule.id, admins: admins.length, status: outcome.status }, 'Backup failure notice sent to admins');
    return admins.length;
  } catch (err) {
    log.error({ err, scheduleId: schedule.id }, 'Backup failure notice could not be sent');
    return 0;
  }
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
        activeSignatures.delete(id);
        log.info({ scheduleId: id }, 'Schedule deactivated — stopped CronJob');
      }
    }

    // New or changed schedules: start
    for (const schedule of dbSchedules) {
      const existing = activeJobs.get(schedule.id);
      const signature = scheduleSignature(schedule as unknown as ScheduleData);
      if (existing && activeSignatures.get(schedule.id) === signature) continue; // unchanged

      if (existing) {
        existing.stop();
        activeJobs.delete(schedule.id);
        activeSignatures.delete(schedule.id);
      }

      try {
        const job = new CronJob(
          schedule.cron,
          async () => {
            try {
              // v7.1.0: only one instance runs this fire; no overlap with a still-running run
              const outcome = await scheduleTick(lockRedis(), schedule.id, async () => {
                log.info({ scheduleId: schedule.id, name: schedule.name }, 'Schedule-triggered backup starting');
                const row = schedule as unknown as ScheduleRow;
                const started = await startScheduleBackup(row, 'CRON');
                if (!started) {
                  await prisma.backupSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date(), lastStatus: 'INVALID' } }).catch(() => undefined);
                  return null;
                }
                await prisma.backupSchedule.update({ where: { id: schedule.id }, data: { lastJobId: started.jobId, lastStatus: 'RUNNING' } }).catch(() => undefined);
                return { done: started.done.then((o) => finishScheduleRun(row, o, 'CRON')) };
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
              await notifyBackupFailure(schedule as unknown as ScheduleRow, {
                jobId: '—', status: 'FAILED', total: 1, failed: 1, errorMsg: err instanceof Error ? err.message : String(err),
              });
            }
          },
          null,
          true,
          'UTC',
        );
        activeJobs.set(schedule.id, job);
        activeSignatures.set(schedule.id, signature);
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

/** Status of a full backup: all mailboxes failed → FAILED; some failed → COMPLETED with an error text. */
export function fullBackupOutcome(jobId: string, total: number, failed: number): JobOutcome {
  if (total > 0 && failed === total) {
    return { jobId, status: 'FAILED', total, failed, errorMsg: `Alle ${total} Postfach-Sicherungen fehlgeschlagen` };
  }
  return { jobId, status: 'COMPLETED', total, failed, errorMsg: failed > 0 ? `${failed} von ${total} Postfach-Sicherungen fehlgeschlagen` : null };
}

/**
 * v3.18.26 fix: writes ONE master job upfront with status=RUNNING, then
 * child jobs per user. The frontend immediately sees a RUNNING job.
 */
export async function runFullBackup(opts: RunOpts = {}): Promise<{ jobId: string; done: Promise<JobOutcome> }> {
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

  const work = async (): Promise<JobOutcome> => {
    const hb = new JobHeartbeat(async (meta, progress) => {
      await prisma.backupJob.update({ where: { id: masterJob.id }, data: { progressMeta: meta as never, ...(progress !== undefined ? { progress } : {}) } });
    }, { phase: 'user-export' }).start();
    try {
      const users = await prisma.user.findMany({
        where: { active: true },
        select: { id: true, email: true },
      });
      let total = 0;
      let failed = 0;
      let totalSize = 0n;
      let totalMessages = 0;

      for (let i = 0; i < users.length; i++) {
        const user = users[i]!;
        // Progress update on the master job
        await hb.update(
          { phase: 'user-export', current: i + 1, total: users.length, currentUser: user.email },
          Math.round((i / Math.max(1, users.length)) * 100),
        );

        const childStarted = new Date();
        try {
          const outPath = join(tmpdir(), `coremail-backup-${user.id}-${Date.now()}.zip`);
          const { messageCount } = await exportZip(user.id, null, outPath);
          const s3Key = fullBackupUserKey(startedAt, masterJob.id, user.email);
          const fileSize = (await stat(outPath).catch(() => null))?.size ?? 0;
          // Stored encrypted under <s3Key>.enc; the plaintext temp file is removed even on failure
          const stored = await uploadToS3(outPath, s3Key, 'application/zip').finally(() => unlink(outPath).catch(() => undefined));

          await prisma.backupJob.create({
            data: {
              userId: user.id,
              scope: 'user',
              format: 'zip',
              status: 'COMPLETED',
              downloadUrl: stored.key,
              startedAt: childStarted,
              completedAt: new Date(),
              durationMs: Date.now() - childStarted.getTime(),
              sizeBytes: BigInt(fileSize),
              messageCount,
              triggeredBy: opts.triggeredBy ?? 'MANUAL',
              progressMeta: { phase: 'done', parentJobId: masterJob.id } as never,
              ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
            },
          });
          total++;
          totalSize += BigInt(fileSize);
          totalMessages += messageCount;
        } catch (err) {
          failed++;
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
              startedAt: childStarted,
              completedAt: new Date(),
              triggeredBy: opts.triggeredBy ?? 'MANUAL',
              progressMeta: { phase: 'failed', parentJobId: masterJob.id } as never,
              ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
            },
          });
        }
      }

      const outcome = fullBackupOutcome(masterJob.id, users.length, failed);
      const finishedAt = new Date();
      const meta = hb.stop();
      await prisma.backupJob.update({
        where: { id: masterJob.id },
        data: {
          status: outcome.status,
          progress: 100,
          completedAt: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          sizeBytes: totalSize,
          messageCount: totalMessages,
          errorMsg: outcome.errorMsg,
          ...(failed > 0 ? { errorClass: outcome.status === 'FAILED' ? 'UNKNOWN' : 'PARTIAL' } : {}),
          progressMeta: { ...meta, phase: 'done', current: total, total: users.length, failed } as never,
        },
      });
      log.info({ userCount: total, failed, masterJobId: masterJob.id }, 'Full backup complete');
      return outcome;
    } catch (err) {
      hb.stop();
      log.error({ err, masterJobId: masterJob.id }, 'Full backup failed');
      const errorMsg = err instanceof Error ? err.message : String(err);
      await prisma.backupJob.update({
        where: { id: masterJob.id },
        data: {
          status: 'FAILED',
          errorMsg,
          errorClass: classifyError(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
      return { jobId: masterJob.id, status: 'FAILED', total: 0, failed: 0, errorMsg };
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
}): Promise<{ jobId: string; done: Promise<JobOutcome> }> {
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

  const work = async (): Promise<JobOutcome> => {
    const hb = new JobHeartbeat(async (meta) => {
      await prisma.backupJob.update({ where: { id: job.id }, data: { progressMeta: meta as never } });
    }, { phase: 'export' }).start();
    try {
      const outPath = join(tmpdir(), `coremail-mbox-${opts.userId}-${Date.now()}.${opts.format === 'mbox' ? 'mbox' : 'zip'}`);
      const folderIds = opts.folderIds ?? null;
      let messageCount = 0;

      if (opts.format === 'mbox') {
        messageCount = (await exportMbox(opts.userId, folderIds, outPath)).messageCount;
      } else {
        messageCount = (await exportZip(opts.userId, folderIds, outPath)).messageCount;
      }

      const s3Key = `mailbox/${opts.userId}/${Date.now()}.${opts.format === 'mbox' ? 'mbox' : 'zip'}`;
      const contentType = opts.format === 'mbox' ? 'application/mbox' : 'application/zip';
      const fileSize = (await stat(outPath).catch(() => null))?.size ?? 0;
      await hb.update({ phase: 'upload' });
      // Stored encrypted under <s3Key>.enc; the plaintext temp file is removed even on failure
      const stored = await uploadToS3(outPath, s3Key, contentType).finally(() => unlink(outPath).catch(() => undefined));
      const downloadUrl = await getSignedDownloadUrl(stored.key);

      const finishedAt = new Date();
      const meta = hb.stop();
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          downloadUrl,
          completedAt: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          sizeBytes: BigInt(fileSize),
          messageCount,
          progressMeta: { ...meta, phase: 'done' } as never,
        },
      });
      return { jobId: job.id, status: 'COMPLETED', total: 1, failed: 0, errorMsg: null };
    } catch (err) {
      hb.stop();
      log.error({ err, jobId: job.id }, 'Single-mailbox backup failed');
      const errorMsg = err instanceof Error ? err.message : String(err);
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorMsg,
          errorClass: classifyError(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
      return { jobId: job.id, status: 'FAILED', total: 1, failed: 1, errorMsg };
    }
  };
  const done = runInBackground(work, job.id);
  return { jobId: job.id, done };
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
