import { initRuntimeLogLevel } from '@coremail/core';
import express from 'express';
import { z } from 'zod';
import { connectDatabase } from '@coremail/storage';
import {
  getRedisClient, createLogger, verifyAccessToken,
  installProcessGuards, installAsyncErrorHandling, errorMiddleware, requireInternal, resolveBindHost,
} from '@coremail/core';
import { parseLimit, isBackupAdmin, isSafeArchiveKey } from './http-utils.js';
import { runUserBackup, runFullBackup, runSingleMailboxBackup, startBackupScheduler, runRetentionLocked } from './scheduler/index.js';
import { listRestorableMessages, restoreMessage, importMbox } from './restore/index.js';
import { listBackups, ensureBackupBucket, openBackupDownload, deleteObject, backupKeyring } from './upload/s3.js';
import { BackupDecryptError, BackupKeyConfigError } from './crypto/backup-crypto.js';
import { prepareImportFile } from './restore/import-file.js';
import { parseScheduleInput, type ScheduleData } from './scheduler/schedule-input.js';
import { pipeline } from 'node:stream/promises';
import { prisma } from '@coremail/storage';

const log = createLogger('backup-service');
installProcessGuards(log);
installAsyncErrorHandling(express);
const app = express();
// 9.1: routes match case-sensitively, like the RBAC path checks in http-utils.ts
// (Express matches case-insensitively by default: /backup/admin/DOWNLOAD/x would
// otherwise reach the download handler). Must be set before the first route.
app.set('case sensitive routing', true);
const PORT = parseInt(process.env['BACKUP_PORT'] ?? '3004', 10);

// v3.18.30 CRITICAL FIX: BigInt fields (BackupJob.sizeBytes) crash
// JSON.stringify(). A global replacer converts BigInt → String. Prevents
// the whole backup-service from crashing on every /jobs call and supervisord
// restarting it — which caused the symptoms "no users in dropdown" + "no status
// for running jobs".
//
// Monkey-patch of res.json — alternatively one could serialize manually per
// endpoint, but that is error-prone. Global is cleaner.
const _origJson = express.response.json;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(express.response as any).json = function (this: express.Response, body: unknown): express.Response {
  const safe = JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return _origJson.call(this, safe);
};

app.use(express.json());

// Auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) { res.status(401).json({ error: 'Authorization required' }); return; }
  const payload = verifyAccessToken(header.slice(7));
  if (!payload) { res.status(401).json({ error: 'Invalid token' }); return; }
  (req as express.Request & { userId: string; role: string }).userId = payload.sub;
  (req as express.Request & { userId: string; role: string }).role = payload.role;
  next();
}

// v6 RBAC: backups belong to the "servers" area of the api-gateway matrix
// (ORGANIZATION_MANAGEMENT + SERVER_MANAGEMENT write, VIEW_ONLY_ORG read).
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  requireAuth(req, res, () => {
    if (!isBackupAdmin((req as express.Request & { role: string }).role, req.method, req.path)) {
      res.status(403).json({ error: 'Admin role required' }); return;
    }
    next();
  });
}

type AuthedRequest = express.Request & { userId: string; role: string };

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'backup-service' }));

// ─── User self-service backup ───────────────────────────────────────────────

// POST /backup/user/export — start async export job
app.post('/backup/user/export', requireAuth, async (req, res) => {
  const schema = z.object({
    format: z.enum(['mbox', 'zip']).default('zip'),
    folderIds: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const userId = (req as AuthedRequest).userId;
  const { jobId } = await runUserBackup(userId, parsed.data.format, parsed.data.folderIds ?? null);
  res.status(202).json({ jobId, message: 'Export started. Poll /backup/user/jobs/:id for status.' });
});

// GET /backup/user/jobs/:id — poll job status
app.get('/backup/user/jobs/:id', requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  
  const jobId = req.params['id'];
  if (!jobId) { res.status(400).json({ error: 'Missing id' }); return; }
  const job = await prisma.backupJob.findFirst({ where: { id: jobId, userId } });
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /backup/user/restore — list messages eligible for restore
app.get('/backup/user/restore', requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const messages = await listRestorableMessages(userId);
  res.json(messages);
});

// POST /backup/user/restore/:messageId — restore a soft-deleted message
app.post('/backup/user/restore/:messageId', requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  try {
    await restoreMessage(userId, req.params['messageId']!);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Not found' });
  }
});

// ─── Admin backup ────────────────────────────────────────────────────────────

// POST /backup/admin/full — trigger immediate full backup
// v3.18.26: returns the job ID so the frontend can see the RUNNING job immediately
app.post('/backup/admin/full', requireAdmin, async (_req, res) => {
  try {
    const { jobId } = await runFullBackup({ triggeredBy: 'MANUAL' });
    res.status(202).json({ message: 'Full backup started', jobId });
  } catch (err) {
    log.error({ err }, 'Manual full backup failed to start');
    res.status(500).json({ error: 'Failed to start backup', detail: err instanceof Error ? err.message : String(err) });
  }
});

// v3.18.26 — POST /backup/admin/mailbox/:userId — single-mailbox backup
app.post('/backup/admin/mailbox/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string };
  const format = ((req.body as { format?: string })?.format ?? 'zip') as 'mbox' | 'zip';
  if (format !== 'mbox' && format !== 'zip') {
    res.status(400).json({ error: 'format must be mbox or zip' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  try {
    const { jobId } = await runSingleMailboxBackup({ userId, format, triggeredBy: 'MANUAL' });
    res.status(202).json({ message: 'Mailbox backup started', jobId, userEmail: user.email });
  } catch (err) {
    log.error({ err, userId }, 'Manual mailbox backup failed to start');
    res.status(500).json({ error: 'Failed to start backup', detail: err instanceof Error ? err.message : String(err) });
  }
});

/** Cron smoke test via the CronJob constructor (same parser the scheduler uses). */
async function validCron(cron: string): Promise<boolean> {
  try {
    const { CronJob } = await import('cron');
    new CronJob(cron, () => undefined, null, false, 'UTC');
    return true;
  } catch {
    return false;
  }
}

// 9.1.x — GET /backup/admin/encryption — key state for the BCP (never the key itself)
app.get('/backup/admin/encryption', requireAdmin, (_req, res) => {
  try {
    const ring = backupKeyring();
    res.json({
      encrypted: true,
      keySource: ring.current.source, // 'env' = BACKUP_ENCRYPTION_KEY, 'derived' = from JWT_SECRET + PEPPER
      keyId: ring.current.id.toString('hex'),
      decryptKeys: ring.keys.length,
    });
  } catch (err) {
    res.json({ encrypted: false, keySource: null, error: err instanceof Error ? err.message : String(err) });
  }
});

// v3.18.26 — backup schedules CRUD (DB-driven instead of env variable)

// GET /backup/admin/schedules — list all schedules
app.get('/backup/admin/schedules', requireAdmin, async (_req, res) => {
  const schedules = await prisma.backupSchedule.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json(schedules);
});

// POST /backup/admin/schedules — create a new schedule
app.post('/backup/admin/schedules', requireAdmin, async (req, res) => {
  // 9.1.x: scope/format/target/retention validated (scope 'user' without a target never ran)
  const parsed = parseScheduleInput(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const body = parsed.data as ScheduleData;
  if (!(await validCron(body.cron))) { res.status(400).json({ error: 'Invalid cron expression' }); return; }
  if (body.targetUserId && !(await prisma.user.findUnique({ where: { id: body.targetUserId }, select: { id: true } }))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const actorId = (req as express.Request & { userId: string }).userId;
  const created = await prisma.backupSchedule.create({
    data: {
      name: body.name,
      cron: body.cron,
      scope: body.scope,
      format: body.format,
      ...(body.targetUserId ? { targetUserId: body.targetUserId } : {}),
      retentionDays: body.retentionDays,
      enabled: body.enabled,
      createdBy: actorId,
    },
  });
  res.status(201).json(created);
});

// PUT /backup/admin/schedules/:id — edit a schedule
app.put('/backup/admin/schedules/:id', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const current = await prisma.backupSchedule.findUnique({ where: { id } });
  if (!current) { res.status(404).json({ error: 'Schedule not found' }); return; }
  const parsed = parseScheduleInput(req.body, current as unknown as ScheduleData);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const body = parsed.data;
  if (body.cron !== undefined && !(await validCron(body.cron))) { res.status(400).json({ error: 'Invalid cron expression' }); return; }
  if (body.targetUserId && !(await prisma.user.findUnique({ where: { id: body.targetUserId }, select: { id: true } }))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) updates[k] = v;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.backupSchedule.update({ where: { id }, data: updates as any });
  res.json(updated);
});

// DELETE /backup/admin/schedules/:id
app.delete('/backup/admin/schedules/:id', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  await prisma.backupSchedule.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

// POST /backup/admin/schedules/:id/run-now — trigger a schedule manually
app.post('/backup/admin/schedules/:id/run-now', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const schedule = await prisma.backupSchedule.findUnique({ where: { id } });
  if (!schedule) { res.status(404).json({ error: 'Schedule not found' }); return; }
  try {
    if (schedule.scope === 'full') {
      const { jobId } = await runFullBackup({ triggeredBy: 'MANUAL', scheduleId: id });
      res.json({ message: 'Triggered', jobId });
    } else if (schedule.scope === 'user' && schedule.targetUserId) {
      const { jobId } = await runSingleMailboxBackup({
        userId: schedule.targetUserId,
        format: schedule.format === 'mbox' ? 'mbox' : 'zip',
        triggeredBy: 'MANUAL',
        scheduleId: id,
      });
      res.json({ message: 'Triggered', jobId });
    } else {
      res.status(400).json({ error: 'Schedule has invalid scope/targetUserId combination' });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to trigger' });
  }
});

// v3.18.28 — download a backup job as a stream (uses S3-internal GetObject)
app.get('/backup/admin/download/:jobId', requireAdmin, async (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job?.downloadUrl) { res.status(404).json({ error: 'Backup nicht gefunden' }); return; }
  await sendBackup(res, job.downloadUrl, { jobId });
});

/**
 * Streams a stored backup to the client. Encrypted backups (`.enc`)
 * are decrypted on the fly; a wrong key / foreign file is answered with 500
 * before any byte is sent, a corrupted frame later aborts the connection (the
 * client never receives an apparently complete file).
 */
async function sendBackup(res: express.Response, key: string, ctx: Record<string, string>): Promise<void> {
  let dl: Awaited<ReturnType<typeof openBackupDownload>>;
  try {
    dl = await openBackupDownload(key);
  } catch (err) {
    log.error({ err, ...ctx }, 'Download failed');
    const detail = err instanceof BackupDecryptError || err instanceof BackupKeyConfigError ? err.message : undefined;
    res.status(500).json({ error: 'Download failed', ...(detail ? { detail } : {}) });
    return;
  }
  res.setHeader('Content-Type', dl.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${dl.filename}"`);
  if (dl.contentLength) res.setHeader('Content-Length', String(dl.contentLength));
  pipeline(dl.stream, res).catch((err: unknown) => {
    log.error({ err, ...ctx }, 'Stream error during download');
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    else res.destroy();
  });
}

// v3.18.29 — backup archive download (by S3 key, not job ID — for the archive tab
// where objects without a DB reference are shown, e.g. old backups from before
// BackupJob tracking or external imports into the bucket).
app.get('/backup/admin/archive/download', requireAdmin, async (req, res) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  if (!isSafeArchiveKey(key)) { res.status(400).json({ error: 'Invalid archive key' }); return; }
  await sendBackup(res, key, { key });
});

// v3.18.29 — delete a backup archive (S3 object). Additionally looks for
// matching BackupJob records and nulls their downloadUrl (so the job does not
// appear in the UI with a broken link).
app.delete('/backup/admin/archive', requireAdmin, async (req, res) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  if (!isSafeArchiveKey(key)) { res.status(400).json({ error: 'Invalid archive key' }); return; }
  try {
    await deleteObject(key);
    // Null out BackupJob records with this downloadUrl (cosmetic, optional)
    await prisma.backupJob.updateMany({
      where: { downloadUrl: key },
      data: { downloadUrl: null, status: 'EXPIRED' },
    }).catch(() => undefined);
    log.info({ key }, 'Archive object deleted');
    res.json({ ok: true });
  } catch (err) {
    log.error({ err, key }, 'Archive delete failed');
    res.status(500).json({ error: 'Delete failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// v3.18.28 — delete a backup job (DB + S3 object)
app.delete('/backup/admin/jobs/:id', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const job = await prisma.backupJob.findUnique({ where: { id } });
  if (!job) { res.status(404).json({ error: 'Job nicht gefunden' }); return; }
  // Delete the S3 object if present (best-effort, no throw on errors)
  if (job.downloadUrl) {
    try { await deleteObject(job.downloadUrl); }
    catch (err) { log.warn({ err, jobId: id, s3Key: job.downloadUrl }, 'S3 delete failed — continuing with DB delete'); }
  }
  await prisma.backupJob.delete({ where: { id } });
  log.info({ jobId: id }, 'Backup job deleted');
  res.json({ ok: true });
});

// GET /backup/admin/users — list of all users for the mailbox backup picker
app.get('/backup/admin/users', requireAdmin, async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, email: true, displayName: true },
    orderBy: { email: 'asc' },
  });
  res.json(users);
});

// GET /backup/admin/list — list all backups in S3
app.get('/backup/admin/list', requireAdmin, async (req, res) => {
  const prefix = (req.query['prefix'] as string) ?? '';
  const backups = await listBackups(prefix);
  res.json(backups);
});

// GET /backup/admin/jobs — list all backup jobs
app.get('/backup/admin/jobs', requireAdmin, async (req, res) => {
  
  // v6: `?limit=abc` produced NaN → Prisma validation error → process crash
  const limit = parseLimit(req.query['limit'], 50, 200);
  const jobs = await prisma.backupJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(jobs);
});

// ─── Internal retention endpoint (called by api-gateway) ─────────────────────

// POST /internal/retention/run — trigger retention policy run
// v6: loopback-only, or X-Internal-Token when INTERNAL_API_TOKEN is set
app.post('/internal/retention/run', requireInternal(), async (_req, res) => {
  try {
    // v7.1.0: never overlaps a scheduled or manual run on any instance
    const out = await runRetentionLocked();
    if (!out.ran) { res.status(409).json({ error: 'A retention run is already in progress' }); return; }
    res.json(out.value);
  } catch (err) {
    log.error({ err }, 'Manual retention run failed');
    res.status(500).json({ error: 'Retention run failed' });
  }
});

// POST /backup/admin/import/:userId — import MBOX for a specific user (admin)
// The body is read as raw bytes (application/mbox or application/octet-stream)
// and may be a legacy plaintext MBOX or an encrypted CoreMail backup (.mbox.enc,
// decrypted + authenticated before anything is imported). The target folder is
// given as ?folderId= (the old text body could never carry it).
app.post('/backup/admin/import/:userId', requireAdmin, express.raw({ type: ['application/mbox', 'application/octet-stream'], limit: '500mb' }), async (req, res) => {
  const { userId } = req.params as { userId: string };
  const folderId = typeof req.query['folderId'] === 'string' ? req.query['folderId'] : '';

  if (!folderId || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'folderId (query) and MBOX body required' });
    return;
  }

  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmpDir = await mkdtemp(join(tmpdir(), 'coremail-import-'));
  try {
    let prepared: Awaited<ReturnType<typeof prepareImportFile>>;
    try {
      prepared = await prepareImportFile(req.body, tmpDir, backupKeyring);
    } catch (err) {
      if (err instanceof BackupDecryptError || err instanceof BackupKeyConfigError) {
        res.status(422).json({ error: 'Encrypted backup could not be decrypted', detail: err.message });
        return;
      }
      throw err;
    }
    const result = await importMbox(userId, folderId, prepared.path);
    res.json({ ...result, encrypted: prepared.encrypted });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// v6: shared error middleware (registered last) — no stack/message leaks
app.use(errorMiddleware(log));

async function start() {
  await connectDatabase();
  void initRuntimeLogLevel('backup-service', { aliases: ['backup'] }); // BCP per-service log level
  // v5.6.0: initJwtKeys() removed (back to HS256)
  getRedisClient();

  // v3.18.26 bugfix: create the backup bucket idempotently — otherwise
  // listBackups() crashes with NoSuchBucket on every first start.
  await ensureBackupBucket();

  // Backups are encrypted — report the key situation at start (warning
  // for the derived fallback key; an invalid BACKUP_ENCRYPTION_KEY makes every
  // backup run fail instead of silently writing plaintext).
  try {
    const kr = backupKeyring();
    log.info({ keySource: kr.current.source, keyId: kr.current.id.toString('hex') }, 'Backup encryption enabled (AES-256-GCM)');
  } catch (err) {
    log.error({ err }, 'Backup encryption key invalid — backups will fail until BACKUP_ENCRYPTION_KEY is fixed');
  }

  // v3.18.34: orphan cleanup. If the container is restarted during a backup,
  // the master job stays stuck in the DB with status RUNNING/PENDING/RETRYING/
  // PROCESSING and the frontend shows "running forever". On
  // start we check whether such jobs are older than 60s (safe: no job that
  // just started gets marked by accident) and mark them as
  // FAILED with a clear error text.
  try {
    const cutoff = new Date(Date.now() - 60 * 1000);
    const orphans = await prisma.backupJob.updateMany({
      where: {
        status: { in: ['RUNNING', 'PENDING', 'RETRYING', 'PROCESSING', 'SCHEDULED'] },
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorClass: 'STORAGE',
        errorMsg: 'Container wurde während Backup neugestartet — Job abgebrochen.',
      },
    });
    if (orphans.count > 0) {
      log.warn({ count: orphans.count }, 'Orphan backup jobs marked as FAILED (container restart cleanup)');
    }
  } catch (err) {
    log.error({ err }, 'Orphan-cleanup failed (non-fatal)');
  }

  // v3.18.34: watchdog. If a running job does not finish within 30 min,
  // it is most likely a deadlock — auto-FAIL.
  const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 minutes
  const STUCK_AFTER_MS       = 30 * 60 * 1000;  // 30 minutes = stuck
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
      const stuck = await prisma.backupJob.updateMany({
        where: {
          status: { in: ['RUNNING', 'PROCESSING', 'RETRYING'] },
          startedAt: { lt: cutoff },
        },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorClass: 'UNKNOWN',
          errorMsg: 'Watchdog: Job > 30 Min. ohne Fortschritt — abgebrochen.',
        },
      });
      if (stuck.count > 0) {
        log.warn({ count: stuck.count }, 'Stuck backup jobs auto-FAILED by watchdog');
      }
    } catch (err) {
      log.error({ err }, 'Watchdog tick failed');
    }
  }, WATCHDOG_INTERVAL_MS);

  startBackupScheduler();

  // v6: internal service — loopback by default (INTERNAL_BIND_HOST overrides)
  const host = resolveBindHost();
  app.listen(PORT, host, () => log.info({ port: PORT, host }, 'Backup service listening'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
