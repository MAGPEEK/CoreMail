/**
 * v3.18.23 D3: Backup-Admin-Router
 *
 * Dünner Wrapper über die backup-service-REST-API. Stellt
 * /api/v1/admin/backups/* bereit, leitet an http://backup-service:3004/backup/admin/*
 * weiter. Authorization-Header wird durchgereicht (backup-service hat eigenen
 * requireAdmin-Check).
 *
 * Die Endpoints im backup-service:
 *   POST /backup/admin/full            — vollständigen Backup-Job triggern
 *   GET  /backup/admin/list?limit=     — S3-Backup-Objekte listen
 *   GET  /backup/admin/jobs?limit=     — BackupJob-Records aus DB listen
 *   POST /backup/admin/import/:userId  — MBOX für User importieren (multipart text)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
// Side-effect import: lädt die Express-Request-Augmentation für `apiUser`
import '../../middleware/auth.js';
import { audit, auditContext } from '../../lib/audit.js';

const BACKUP_URL = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';

export const adminBackupsRouter: RouterType = Router();
adminBackupsRouter.use(requireAdmin);

async function forward(
  req: Request,
  res: Response,
  method: 'GET' | 'POST',
  upstreamPath: string,
  bodyText?: string,
  contentType?: string,
): Promise<void> {
  try {
    const url = `${BACKUP_URL}${upstreamPath}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType ?? 'application/json',
      // Authorization durchreichen — backup-service prüft selbst
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
  } catch (err) {
    res.status(502).json({
      error: 'backup-service unavailable',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

// GET /api/v1/admin/backups/jobs — Liste aller Backup-Jobs aus DB
adminBackupsRouter.get('/jobs', async (req, res) => {
  const limit = String(req.query['limit'] ?? '100');
  await forward(req, res, 'GET', `/backup/admin/jobs?limit=${encodeURIComponent(limit)}`);
});

// GET /api/v1/admin/backups/list — S3-Backup-Objekte
adminBackupsRouter.get('/list', async (req, res) => {
  const limit = String(req.query['limit'] ?? '100');
  await forward(req, res, 'GET', `/backup/admin/list?limit=${encodeURIComponent(limit)}`);
});

// POST /api/v1/admin/backups/full — vollständigen Backup-Job triggern
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

// POST /api/v1/admin/backups/import/:userId — MBOX für User importieren
// Body wird als text/mbox erwartet (bis 500MB).
adminBackupsRouter.post('/import/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  // Body wurde von express.json() noch nicht konsumiert weil Mount-Reihenfolge
  // Backup-Router NACH express.json() liegt? — siehe server.ts. Wir lesen den
  // raw body via req on('data') auf, da MBOX text/plain ist und potenziell groß.
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
  req.on('error', (err) => {
    res.status(400).json({ error: 'failed to read import body', details: err.message });
  });
});
