/**
 * v3.18.23 D3: backup admin router
 *
 * Thin wrapper over the backup-service REST API. Exposes
 * /api/v1/admin/backups/* and forwards to http://backup-service:3004/backup/admin/*.
 * The Authorization header is passed through (backup-service has its own
 * requireAdmin check).
 *
 * The endpoints in the backup-service:
 *   POST /backup/admin/full            — trigger a full backup job
 *   GET  /backup/admin/list?limit=     — list S3 backup objects
 *   GET  /backup/admin/jobs?limit=     — list BackupJob records from the DB
 *   POST /backup/admin/import/:userId  — import MBOX for a user (multipart text)
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { requireArea, requireRole } from '../../middleware/auth.js'; // also loads the `apiUser` request augmentation
import { audit, auditContext } from '../../lib/audit.js';

const BACKUP_URL = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';

/**
 * Routes that hand out or write MAILBOX CONTENT (8.0.x): per-mailbox backup,
 * job / archive downloads (a full backup contains every mailbox) and MBOX
 * import. They are ORGANIZATION_MANAGEMENT / COMPLIANCE_MANAGEMENT only —
 * SERVER_MANAGEMENT keeps the operational part (full backup trigger, schedules,
 * job list, deleting jobs/archives). Paths are relative to /api/v1/admin/backups.
 */
export function isMailboxDataRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  if (req.method === 'POST') return /^\/(mailbox|import)\/[^/]+\/?$/.test(req.path);
  if (req.method === 'GET' || req.method === 'HEAD') {
    return /^\/download\/[^/]+\/?$/.test(req.path) || /^\/archive\/download\/?$/.test(req.path);
  }
  return false;
}

/** COMPLIANCE_MANAGEMENT has no 'servers' area: it reaches the mailbox-data routes and the lists needed to pick a job. */
const complianceBackupAccess = (role: string, req: Request): boolean =>
  role === 'COMPLIANCE_MANAGEMENT'
  && (isMailboxDataRoute(req) || ((req.method === 'GET' || req.method === 'HEAD') && /^\/(jobs|list|users)\/?$/.test(req.path)));

const mailboxDataGuard = requireRole('COMPLIANCE_MANAGEMENT'); // ORGANIZATION_MANAGEMENT always passes

export const adminBackupsRouter: RouterType = Router();
adminBackupsRouter.use(requireArea('servers', complianceBackupAccess));
adminBackupsRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (isMailboxDataRoute(req)) mailboxDataGuard(req, res, next);
  else next();
});

/** Generic upstream failure — never echo the internal error (URLs, ports, stack). */
function upstreamUnavailable(res: Response): void {
  if (!res.headersSent) res.status(502).json({ error: 'backup-service unavailable' });
  else res.end();
}

async function forward(
  req: Request,
  res: Response,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  upstreamPath: string,
  bodyText?: string,
  contentType?: string,
): Promise<void> {
  try {
    const url = `${BACKUP_URL}${upstreamPath}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType ?? 'application/json',
      // Pass Authorization through — backup-service checks it itself
      ...(req.get('Authorization') ? { Authorization: req.get('Authorization')! } : {}),
    };
    const init: RequestInit = { method, headers };
    if (bodyText !== undefined) init.body = bodyText;

    const upstream = await fetch(url, init);
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.send(text);
  } catch {
    upstreamUnavailable(res);
  }
}

// GET /api/v1/admin/backups/jobs — list of all backup jobs from the DB
adminBackupsRouter.get('/jobs', async (req, res) => {
  const limit = String(req.query['limit'] ?? '100');
  await forward(req, res, 'GET', `/backup/admin/jobs?limit=${encodeURIComponent(limit)}`);
});

// GET /api/v1/admin/backups/list — S3 backup objects
adminBackupsRouter.get('/list', async (req, res) => {
  const limit = String(req.query['limit'] ?? '100');
  await forward(req, res, 'GET', `/backup/admin/list?limit=${encodeURIComponent(limit)}`);
});

// POST /api/v1/admin/backups/full — trigger a full backup job
adminBackupsRouter.post('/full', async (req: Request, res: Response) => {
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.full.trigger',
    targetType: 'backup',
    ...auditContext(req),
  });
  await forward(req, res, 'POST', '/backup/admin/full');
});

// v3.18.26 — per-mailbox backup
adminBackupsRouter.post('/mailbox/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.mailbox.trigger',
    targetType: 'user',
    targetId: userId,
    ...auditContext(req),
  });
  const body = JSON.stringify(req.body ?? {});
  await forward(req, res, 'POST', `/backup/admin/mailbox/${encodeURIComponent(userId)}`, body);
});

// v3.18.26 — user list for the mailbox picker
adminBackupsRouter.get('/users', async (req: Request, res: Response) => {
  await forward(req, res, 'GET', '/backup/admin/users');
});

// v3.18.26 — backup schedules CRUD
adminBackupsRouter.get('/schedules', async (req: Request, res: Response) => {
  await forward(req, res, 'GET', '/backup/admin/schedules');
});

adminBackupsRouter.post('/schedules', async (req: Request, res: Response) => {
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.schedule.create',
    targetType: 'backup_schedule',
    changes: req.body as Record<string, unknown>,
    ...auditContext(req),
  });
  await forward(req, res, 'POST', '/backup/admin/schedules', JSON.stringify(req.body ?? {}));
});

adminBackupsRouter.put('/schedules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.schedule.update',
    targetType: 'backup_schedule',
    targetId: id,
    changes: req.body as Record<string, unknown>,
    ...auditContext(req),
  });
  await forward(req, res, 'PUT', `/backup/admin/schedules/${encodeURIComponent(id)}`, JSON.stringify(req.body ?? {}));
});

adminBackupsRouter.delete('/schedules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.schedule.delete',
    targetType: 'backup_schedule',
    targetId: id,
    ...auditContext(req),
  });
  await forward(req, res, 'DELETE', `/backup/admin/schedules/${encodeURIComponent(id)}`);
});

// v3.18.28: download (stream proxy to the backup-service)
adminBackupsRouter.get('/download/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  try {
    const upstream = await fetch(`${BACKUP_URL}/backup/admin/download/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: { ...(req.get('Authorization') ? { Authorization: req.get('Authorization')! } : {}) },
    });
    if (!upstream.ok) {
      const txt = await upstream.text();
      res.status(upstream.status).send(txt);
      return;
    }
    const ct = upstream.headers.get('content-type');
    const cd = upstream.headers.get('content-disposition');
    const cl = upstream.headers.get('content-length');
    if (ct) res.setHeader('Content-Type', ct);
    if (cd) res.setHeader('Content-Disposition', cd);
    if (cl) res.setHeader('Content-Length', cl);
    if (!upstream.body) { res.status(502).end(); return; }
    // Web stream → Node stream
    const reader = upstream.body.getReader();
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
      await pump();
    };
    await pump();
  } catch {
    upstreamUnavailable(res);
  }
});

// v3.18.29: backup archive download (by S3 key) — stream proxy
adminBackupsRouter.get('/archive/download', async (req: Request, res: Response) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  // The generic audit middleware records the GET (AUDIT_SENSITIVE_GET), but not the key.
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.archive.download',
    targetType: 'backup_archive',
    targetId: key,
    ...auditContext(req),
  });
  try {
    const upstream = await fetch(`${BACKUP_URL}/backup/admin/archive/download?key=${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { ...(req.get('Authorization') ? { Authorization: req.get('Authorization')! } : {}) },
    });
    if (!upstream.ok) {
      const txt = await upstream.text();
      res.status(upstream.status).send(txt);
      return;
    }
    const ct = upstream.headers.get('content-type');
    const cd = upstream.headers.get('content-disposition');
    const cl = upstream.headers.get('content-length');
    if (ct) res.setHeader('Content-Type', ct);
    if (cd) res.setHeader('Content-Disposition', cd);
    if (cl) res.setHeader('Content-Length', cl);
    if (!upstream.body) { res.status(502).end(); return; }
    const reader = upstream.body.getReader();
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(value);
      await pump();
    };
    await pump();
  } catch {
    upstreamUnavailable(res);
  }
});

// v3.18.29: delete backup archive object
adminBackupsRouter.delete('/archive', async (req: Request, res: Response) => {
  const key = typeof req.query['key'] === 'string' ? req.query['key'] : '';
  if (!key) { res.status(400).json({ error: 'key query param required' }); return; }
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.archive.delete',
    targetType: 'backup_archive',
    targetId: key,
    ...auditContext(req),
  });
  await forward(req, res, 'DELETE', `/backup/admin/archive?key=${encodeURIComponent(key)}`);
});

// v3.18.28: delete backup job
adminBackupsRouter.delete('/jobs/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.job.delete',
    targetType: 'backup_job',
    targetId: id,
    ...auditContext(req),
  });
  await forward(req, res, 'DELETE', `/backup/admin/jobs/${encodeURIComponent(id)}`);
});

adminBackupsRouter.post('/schedules/:id/run-now', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action: 'backup.schedule.run_now',
    targetType: 'backup_schedule',
    targetId: id,
    ...auditContext(req),
  });
  await forward(req, res, 'POST', `/backup/admin/schedules/${encodeURIComponent(id)}/run-now`);
});

// POST /api/v1/admin/backups/import/:userId — import MBOX for a user
// Body is expected as text/mbox (up to 500MB).
adminBackupsRouter.post('/import/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  // Body not yet consumed by express.json() because of mount order — backup
  // router comes AFTER express.json()? — see server.ts. We read the raw body
  // via req on('data') since MBOX is text/plain and potentially large.
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    audit({
      actorId: req.apiUser!.userId,
      actorEmail: req.apiUser!.email,
      action: 'backup.mbox.import',
      targetType: 'user',
      targetId: userId,
      changes: { sizeBytes: body.length },
      ...auditContext(req),
    });
    void forward(req, res, 'POST', `/backup/admin/import/${encodeURIComponent(userId)}`, body, 'application/mbox');
  });
  req.on('error', () => {
    if (!res.headersSent) res.status(400).json({ error: 'failed to read import body' });
  });
});
