import express from 'express';
import { z } from 'zod';
import { connectDatabase } from '@coremail/storage';
import { getRedisClient, createLogger, verifyAccessToken, initJwtKeys } from '@coremail/core';
import { runUserBackup, runFullBackup, runSingleMailboxBackup, startBackupScheduler } from './scheduler/index.js';
import { runRetentionPolicies } from './retention/worker.js';
import { listRestorableMessages, restoreMessage, importMbox } from './restore/index.js';
import { listBackups, ensureBackupBucket, streamObject, deleteObject } from './upload/s3.js';
import { prisma } from '@coremail/storage';

const log = createLogger('backup-service');
const app = express();
const PORT = parseInt(process.env['BACKUP_PORT'] ?? '3004', 10);

// v3.18.30 KRITISCHER FIX: BigInt-Felder (BackupJob.sizeBytes) crashen
// JSON.stringify(). Globaler Replacer wandelt BigInt → String. Verhindert
// dass der gesamte backup-service bei jedem /jobs-Call crasht und supervisord
// ihn neu startet — was die Symptom „keine User in Dropdown" + „kein Status
// bei laufenden Jobs" verursacht hat.
//
// Monkey-Patch des res.json — alternativ könnte man pro Endpoint manuell
// serialisieren, aber das ist fehleranfällig. Global ist sauberer.
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

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  requireAuth(req, res, () => {
    const r = (req as express.Request & { role: string }).role;
    const adminRoles = ['ADMIN', 'ORGANIZATION_MANAGEMENT'];
    if (!adminRoles.includes(r)) { res.status(403).json({ error: 'Admin role required' }); return; }
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
// v3.18.26: liefert Job-ID damit Frontend sofort den RUNNING-Job sehen kann
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

// v3.18.26 — Backup-Schedules CRUD (DB-getrieben statt Env-Variable)

// GET /backup/admin/schedules — Alle Schedules listen
app.get('/backup/admin/schedules', requireAdmin, async (_req, res) => {
  const schedules = await prisma.backupSchedule.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json(schedules);
});

// POST /backup/admin/schedules — Neue Schedule anlegen
app.post('/backup/admin/schedules', requireAdmin, async (req, res) => {
  const body = req.body as {
    name?: string; cron?: string; scope?: string; format?: string;
    targetUserId?: string; retentionDays?: number; enabled?: boolean;
  };
  if (!body.name || !body.cron) {
    res.status(400).json({ error: 'name and cron required' });
    return;
  }
  // Cron-Validierung: einfacher Smoke-Test via CronJob-Konstruktor
  try {
    const { CronJob } = await import('cron');
    new CronJob(body.cron, () => undefined, null, false, 'UTC');
  } catch {
    res.status(400).json({ error: 'Invalid cron expression' });
    return;
  }
  const actorId = (req as express.Request & { userId: string }).userId;
  const created = await prisma.backupSchedule.create({
    data: {
      name: body.name,
      cron: body.cron,
      scope: body.scope ?? 'full',
      format: body.format ?? 'zip',
      ...(body.targetUserId ? { targetUserId: body.targetUserId } : {}),
      retentionDays: body.retentionDays ?? 30,
      enabled: body.enabled !== false,
      createdBy: actorId,
    },
  });
  res.status(201).json(created);
});

// PUT /backup/admin/schedules/:id — Schedule bearbeiten
app.put('/backup/admin/schedules/:id', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as {
    name?: string; cron?: string; scope?: string; format?: string;
    targetUserId?: string | null; retentionDays?: number; enabled?: boolean;
  };
  if (body.cron) {
    try {
      const { CronJob } = await import('cron');
      new CronJob(body.cron, () => undefined, null, false, 'UTC');
    } catch {
      res.status(400).json({ error: 'Invalid cron expression' });
      return;
    }
  }
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined)         updates['name'] = body.name;
  if (body.cron !== undefined)         updates['cron'] = body.cron;
  if (body.scope !== undefined)        updates['scope'] = body.scope;
  if (body.format !== undefined)       updates['format'] = body.format;
  if (body.targetUserId !== undefined) updates['targetUserId'] = body.targetUserId;
  if (body.retentionDays !== undefined) updates['retentionDays'] = body.retentionDays;
  if (body.enabled !== undefined)      updates['enabled'] = body.enabled;
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

// POST /backup/admin/schedules/:id/run-now — Schedule manuell triggern
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

// v3.18.28 — Download eines Backup-Jobs als Stream (verwendet S3-internes GetObject)
app.get('/backup/admin/download/:jobId', requireAdmin, async (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job?.downloadUrl) { res.status(404).json({ error: 'Backup nicht gefunden' }); return; }
  try {
    const { stream, contentLength, contentType } = await streamObject(job.downloadUrl);
    const filename = job.downloadUrl.split('/').pop() ?? `backup-${jobId}.bin`;
    res.setHeader('Content-Type', contentType ?? (job.format === 'mbox' ? 'application/mbox' : 'application/zip'));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    stream.pipe(res);
    stream.on('error', (err) => {
      log.error({ err, jobId }, 'Stream error during download');
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
  } catch (err) {
    log.error({ err, jobId }, 'Download failed');
    res.status(500).json({ error: 'Download failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// v3.18.29 — Backup-Archive Download (per S3-Key, nicht JobID — für Archive-Tab
// wo Objekte ohne DB-Reference angezeigt werden, z.B. alte Backups vor
// BackupJob-Tracking oder externe Imports in den Bucket).
app.get('/backup/admin/archive/download', requireAdmin, async (req, res) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  try {
    const { stream, contentLength, contentType } = await streamObject(key);
    const filename = key.split('/').pop() ?? 'backup.bin';
    res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    stream.pipe(res);
    stream.on('error', (err) => {
      log.error({ err, key }, 'Archive stream error');
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
  } catch (err) {
    log.error({ err, key }, 'Archive download failed');
    res.status(500).json({ error: 'Download failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// v3.18.29 — Backup-Archive löschen (S3-Object). Sucht zusätzlich nach
// passenden BackupJob-Records und nullt ihre downloadUrl (damit der Job in
// der UI nicht mit broken-Link erscheint).
app.delete('/backup/admin/archive', requireAdmin, async (req, res) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  try {
    await deleteObject(key);
    // BackupJob-Records mit dieser downloadUrl ausnullen (Cosmetic, optional)
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

// v3.18.28 — Backup-Job löschen (DB + S3-Object)
app.delete('/backup/admin/jobs/:id', requireAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const job = await prisma.backupJob.findUnique({ where: { id } });
  if (!job) { res.status(404).json({ error: 'Job nicht gefunden' }); return; }
  // S3-Object löschen wenn vorhanden (best-effort, kein Throw bei Fehlern)
  if (job.downloadUrl) {
    try { await deleteObject(job.downloadUrl); }
    catch (err) { log.warn({ err, jobId: id, s3Key: job.downloadUrl }, 'S3 delete failed — continuing with DB delete'); }
  }
  await prisma.backupJob.delete({ where: { id } });
  log.info({ jobId: id }, 'Backup job deleted');
  res.json({ ok: true });
});

// GET /backup/admin/users — Liste aller User für Mailbox-Backup-Picker
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
  
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 200);
  const jobs = await prisma.backupJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(jobs);
});

// ─── Internal retention endpoint (called by api-gateway) ─────────────────────

// POST /internal/retention/run — trigger retention policy run
app.post('/internal/retention/run', async (_req, res) => {
  try {
    const result = await runRetentionPolicies();
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Manual retention run failed');
    res.status(500).json({ error: 'Retention run failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// POST /backup/admin/import/:userId — import MBOX for a specific user (admin)
app.post('/backup/admin/import/:userId', requireAdmin, express.text({ type: 'application/mbox', limit: '500mb' }), async (req, res) => {
  const { userId } = req.params as { userId: string };
  const { folderId } = req.body as { folderId?: string };

  if (!folderId || typeof req.body !== 'string') {
    res.status(400).json({ error: 'folderId and MBOX body required' });
    return;
  }

  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { unlink } = await import('node:fs/promises');

  const tmpDir = await mkdtemp(join(tmpdir(), 'coremail-import-'));
  const mboxPath = join(tmpDir, 'import.mbox');
  await writeFile(mboxPath, req.body as unknown as string);

  try {
    const result = await importMbox(userId, folderId, mboxPath);
    res.json(result);
  } finally {
    await unlink(mboxPath).catch(() => undefined);
  }
});

async function start() {
  await connectDatabase();
  // v5.3.0: RS256 JWT-Keys initialisieren (verifyAccessToken in Auth-Middleware)
  await initJwtKeys(prisma);
  getRedisClient();

  // v3.18.26 Bugfix: Backup-Bucket idempotent erstellen — sonst crasht
  // listBackups() bei jedem ersten Start mit NoSuchBucket.
  await ensureBackupBucket();

  // v3.18.34: Orphan-Cleanup. Wenn der Container während eines Backups neu-
  // gestartet wird, bleibt der master-job im Status RUNNING/PENDING/RETRYING/
  // PROCESSING in der DB hängen und das Frontend zeigt „läuft endlos". Beim
  // Start prüfen wir, ob solche Jobs älter als 60s sind (sicher: kein neu
  // gerade gestarteter Job wird versehentlich markiert) und markieren sie als
  // FAILED mit klarem Fehlertext.
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

  // v3.18.34: Watchdog. Wenn ein laufender Job > 30 Min. nicht fertig wird,
  // ist mit hoher Wahrscheinlichkeit ein Deadlock — auto-FAIL.
  const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;   // alle 5 Minuten prüfen
  const STUCK_AFTER_MS       = 30 * 60 * 1000;  // 30 Minuten = stuck
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

  app.listen(PORT, () => log.info({ port: PORT }, 'Backup service listening'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
