import { CronJob } from 'cron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { prisma } from '@coremail/storage';
import { runRetentionPolicies } from '../retention/worker.js';
import { createLogger } from '@coremail/core';
import { exportZip } from '../export/zip.js';
import { exportMbox } from '../export/mbox.js';
import { uploadToS3 } from '../upload/s3.js';

const log = createLogger('backup:scheduler');

/**
 * Full system backup: exports all users' mailboxes + contacts + calendar
 * and uploads to S3 with date-based key prefix.
 *
 * Schedule: configurable via BACKUP_SCHEDULE env (default: daily at 02:00)
 */
export function startBackupScheduler() {
  const backupSchedule = process.env['BACKUP_SCHEDULE'] ?? '0 2 * * *';
  const retentionSchedule = process.env['RETENTION_SCHEDULE'] ?? '0 3 * * *';
  log.info({ backupSchedule, retentionSchedule }, 'Starting backup & retention schedulers');

  // Full backup job
  const backupJob = new CronJob(
    backupSchedule,
    async () => {
      log.info('Starting scheduled full backup');
      try {
        await runFullBackup();
      } catch (err) {
        log.error({ err }, 'Scheduled backup failed');
      }
    },
    null,
    true,
    'UTC'
  );

  // Retention policy job (Phase 9)
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

  return { backupJob, retentionJob };
}

export async function runFullBackup(): Promise<void> {
  
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, email: true },
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  const results: { userId: string; email: string; s3Key: string; fileCount: number }[] = [];

  for (const user of users) {
    try {
      const outPath = join(tmpdir(), `coremail-backup-${user.id}-${Date.now()}.zip`);

      const { fileCount } = await exportZip(user.id, null, outPath);
      const s3Key = `full-backup/${dateStr}/${user.email.replace('@', '_at_')}.zip`;
      await uploadToS3(outPath, s3Key, 'application/zip');
      await unlink(outPath).catch(() => undefined);

      results.push({ userId: user.id, email: user.email, s3Key, fileCount });

      // Record in DB
      await prisma.backupJob.create({
        data: {
          userId: user.id,
          scope: 'user',
          format: 'zip',
          status: 'COMPLETED',
          downloadUrl: s3Key,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      log.error({ err, userId: user.id }, 'User backup failed');
    }
  }

  log.info({ userCount: results.length }, 'Full backup complete');

  // Apply retention policy: delete backups older than BACKUP_RETENTION_DAYS (default: 30)
  await applyRetentionPolicy();
}

async function applyRetentionPolicy() {
  const retentionDays = parseInt(process.env['BACKUP_RETENTION_DAYS'] ?? '30', 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  
  const { count } = await prisma.backupJob.deleteMany({
    where: { completedAt: { lt: cutoff }, scope: { not: 'full' } },
  });

  if (count > 0) log.info({ count, cutoffDate: cutoff.toISOString() }, 'Retention policy applied');
}

/**
 * On-demand user backup — called from API when user requests self-service export.
 */
export async function runUserBackup(
  userId: string,
  format: 'mbox' | 'zip',
  folderIds: string[] | null
): Promise<{ jobId: string; downloadUrl: string }> {
  

  const job = await prisma.backupJob.create({
    data: { userId, scope: 'user', format, status: 'PENDING' },
  });

  // Run async (don't await — return job ID immediately)
  setImmediate(async () => {
    try {
      const outPath = join(tmpdir(), `coremail-user-${userId}-${Date.now()}.${format === 'mbox' ? 'mbox' : 'zip'}`);

      let s3Key: string;
      if (format === 'mbox') {
        await exportMbox(userId, folderIds, outPath);
        s3Key = `user-export/${userId}/${Date.now()}.mbox`;
        await uploadToS3(outPath, s3Key, 'application/mbox');
      } else {
        await exportZip(userId, folderIds, outPath);
        s3Key = `user-export/${userId}/${Date.now()}.zip`;
        await uploadToS3(outPath, s3Key, 'application/zip');
      }

      await unlink(outPath).catch(() => undefined);

      // Generate pre-signed URL (1 hour TTL)
      const { getSignedDownloadUrl } = await import('../upload/s3.js');
      const downloadUrl = await getSignedDownloadUrl(s3Key);

      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          downloadUrl,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600 * 1000),
        },
      });
    } catch (err) {
      log.error({ err, jobId: job.id }, 'User backup job failed');
      await prisma.backupJob.update({ where: { id: job.id }, data: { status: 'FAILED' } }).catch(() => undefined);
    }
  });

  return { jobId: job.id, downloadUrl: '' };
}
