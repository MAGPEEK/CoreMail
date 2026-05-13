import express from 'express';
import { z } from 'zod';
import { connectDatabase } from '@coremail/storage';
import { getRedisClient, createLogger, verifyAccessToken } from '@coremail/core';
import { runUserBackup, runFullBackup, startBackupScheduler } from './scheduler/index.js';
import { listRestorableMessages, restoreMessage, importMbox } from './restore/index.js';
import { listBackups } from './upload/s3.js';
import { prisma } from '@coremail/storage';

const log = createLogger('backup-service');
const app = express();
const PORT = parseInt(process.env['BACKUP_PORT'] ?? '3004', 10);

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
app.post('/backup/admin/full', requireAdmin, async (_req, res) => {
  res.status(202).json({ message: 'Full backup started' });
  runFullBackup().catch((err) => log.error({ err }, 'Manual full backup failed'));
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
  getRedisClient();

  startBackupScheduler();

  app.listen(PORT, () => log.info({ port: PORT }, 'Backup service listening'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
