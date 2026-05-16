/**
 * Internal Storage API — accessed only by other CoreMail services.
 *
 * Security hardening (2026-05-16):
 *   - Alle req.body-Übergaben an Prisma verwenden explizite Whitelist-Felder.
 *   - Kein req.body direkt in data: { ...req.body } — verhindert Mass-Assignment.
 *   - Query-Parameter werden validiert und mit sicheren Defaults begrenzt.
 *   - Dieser Service ist NICHT aus dem Docker-Netzwerk erreichbar (kein Port-Expose).
 *   - Alle Prisma-Raw-Queries nutzen Tagged-Template-Literals → parametrisiert, SQLi-sicher.
 */
import express from 'express';
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { getMinioClient } from './minio/index.js';
import { runMigrations } from './prisma/migrate.js';

const log = createLogger('storage-api');
const app = express();
const PORT = parseInt(process.env['STORAGE_PORT'] ?? '3001', 10);

// Body-Limit: 10 MB (für Mails mit Inline-Bildern im JSON-Body)
app.use(express.json({ limit: '10mb' }));

// ── ID-Validierung ───────────────────────────────────────────────────────────
// Alle IDs in URL-Parametern sind CUIDs (cuid2-Format: 24+ alphanumerische Zeichen).
// Ungültige IDs werden früh abgelehnt bevor sie Prisma erreichen.
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{20,32}$/i.test(id);
}

function validateId(id: unknown, res: express.Response): boolean {
  if (!isValidId(id)) {
    res.status(400).json({ error: 'invalid id' });
    return false;
  }
  return true;
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Mailboxes ────────────────────────────────────────────────────────────────
app.get('/mailboxes/:userId', async (req, res) => {
  try {
    if (!validateId(req.params['userId'], res)) return;
    const mailbox = await prisma.mailbox.findFirst({
      where: { userId: req.params['userId'] },
      include: { folders: true },
    });
    if (!mailbox) return res.status(404).json({ error: 'not found' });
    res.json(mailbox);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/mailboxes', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    // Whitelist: nur diese Felder dürfen bei der Mailbox-Anlage gesetzt werden
    const userId = body['userId'];
    if (typeof userId !== 'string' || !isValidId(userId)) {
      return res.status(400).json({ error: 'invalid userId' });
    }
    const mailbox = await prisma.mailbox.create({ data: { userId } });
    res.status(201).json(mailbox);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Folders ──────────────────────────────────────────────────────────────────
app.get('/folders/:mailboxId', async (req, res) => {
  try {
    if (!validateId(req.params['mailboxId'], res)) return;
    const folders = await prisma.folder.findMany({
      where: { mailboxId: req.params['mailboxId'] },
      include: { children: true },
    });
    res.json(folders);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/folders/by-name/:mailboxId/:name', async (req, res) => {
  try {
    if (!validateId(req.params['mailboxId'], res)) return;
    // Ordnernamen auf 255 Zeichen begrenzen
    const name = String(req.params['name'] ?? '').slice(0, 255);
    const folder = await prisma.folder.findFirst({
      where: { mailboxId: req.params['mailboxId'], name },
    });
    if (!folder) return res.status(404).json({ error: 'not found' });
    res.json(folder);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/folders', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    // Whitelist der erlaubten Felder für eine neue Ordner-Anlage
    const mailboxId   = body['mailboxId'];
    const name        = body['name'];
    const displayName = body['displayName'];
    const parentId    = body['parentId'];

    if (!isValidId(mailboxId)) return res.status(400).json({ error: 'invalid mailboxId' });
    if (typeof name !== 'string' || name.trim() === '')
      return res.status(400).json({ error: 'name required' });
    if (typeof displayName !== 'string' || displayName.trim() === '')
      return res.status(400).json({ error: 'displayName required' });
    if (parentId !== undefined && parentId !== null && !isValidId(parentId))
      return res.status(400).json({ error: 'invalid parentId' });

    const folder = await prisma.folder.create({
      data: {
        mailboxId: mailboxId as string,
        name: name.slice(0, 255),
        displayName: displayName.slice(0, 255),
        ...(parentId ? { parentId: parentId as string } : {}),
      },
    });
    res.status(201).json(folder);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────
app.get('/messages/:folderId', async (req, res) => {
  try {
    if (!validateId(req.params['folderId'], res)) return;
    // Limit und Offset validieren — keine negativen Werte, max 200 auf einmal
    const rawLimit  = parseInt((req.query['limit']  as string | undefined) ?? '50', 10);
    const rawOffset = parseInt((req.query['offset'] as string | undefined) ?? '0',  10);
    const limit  = Math.min(Math.max(isNaN(rawLimit)  ? 50  : rawLimit,  1), 200);
    const offset = Math.max(isNaN(rawOffset) ? 0  : rawOffset, 0);

    const messages = await prisma.message.findMany({
      where: { folderId: req.params['folderId'], deletedAt: null },
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true, uid: true, flags: true, subject: true,
        fromAddr: true, toAddrs: true, date: true, rawSize: true,
        changeKey: true,
      },
    });
    res.json(messages);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/messages/by-id/:id', async (req, res) => {
  try {
    if (!validateId(req.params['id'], res)) return;
    const msg = await prisma.message.findUnique({
      where: { id: req.params['id'] },
      include: { attachments: true },
    });
    if (!msg || msg.deletedAt) return res.status(404).json({ error: 'not found' });
    res.json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/messages', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Pflichtfelder validieren
    if (!isValidId(body['folderId']))
      return res.status(400).json({ error: 'invalid folderId' });

    // Whitelist: nur bekannte, sichere Felder an Prisma weitergeben.
    // Verhindert Mass-Assignment (z.B. setzen von internen Feldern wie id, deletedAt).
    const folderId    = body['folderId'] as string;
    const uid         = typeof body['uid'] === 'number' ? body['uid'] : 0;
    const modSeq      = typeof body['modSeq'] === 'number' ? BigInt(body['modSeq']) : BigInt(0);
    const flags       = Array.isArray(body['flags']) ? (body['flags'] as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    const subject     = typeof body['subject'] === 'string' ? body['subject'].slice(0, 2000) : '';
    const fromAddr    = typeof body['fromAddr'] === 'string' ? body['fromAddr'].slice(0, 1000) : '';
    const toAddrs     = Array.isArray(body['toAddrs']) ? (body['toAddrs'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const ccAddrs     = Array.isArray(body['ccAddrs']) ? (body['ccAddrs'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const date        = body['date'] ? new Date(body['date'] as string) : new Date();
    const bodyText    = typeof body['bodyText'] === 'string' ? body['bodyText'] : '';
    const bodyHtml    = typeof body['bodyHtml'] === 'string' ? body['bodyHtml'] : '';
    const rawSize     = typeof body['rawSize'] === 'number' ? body['rawSize'] : 0;
    const storagePath = typeof body['storagePath'] === 'string' ? body['storagePath'].slice(0, 2000) : '';
    const changeKey   = typeof body['changeKey'] === 'string' ? body['changeKey'].slice(0, 255) : '';

    if (isNaN(date.getTime())) return res.status(400).json({ error: 'invalid date' });

    const msg = await prisma.message.create({
      data: {
        folderId, uid, modSeq, flags, subject, fromAddr,
        toAddrs, ccAddrs, date, bodyText, bodyHtml,
        rawSize, storagePath, changeKey,
      },
      include: { attachments: true },
    });

    // Ordnerzähler aktualisieren
    await prisma.folder.update({
      where: { id: msg.folderId },
      data: {
        totalCount:  { increment: 1 },
        unreadCount: { increment: msg.flags.includes('\\Seen') ? 0 : 1 },
      },
    });

    // uidNext erhöhen — $executeRaw mit Template-Literal ist parametrisiert (SQLi-sicher)
    await prisma.$executeRaw`
      UPDATE "Mailbox" m
      SET "uidNext" = "uidNext" + 1
      FROM "Folder" f
      WHERE f.id = ${msg.folderId} AND f."mailboxId" = m.id`;

    res.status(201).json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── PATCH /messages/:id — Whitelist für erlaubte Update-Felder ─────────────
// Nur diese Felder darf ein Service über PATCH ändern.
// Kritische Felder (id, folderId, uid, bodyText, storagePath etc.) sind explizit ausgeschlossen.
const ALLOWED_MESSAGE_PATCH = new Set<string>([
  'flags',       // Gelesen/Markiert/Beantwortet — IMAP und EWS
  'changeKey',   // EWS-Synchronisations-Token
  'modSeq',      // CONDSTORE-Sequenznummer
  'deletedAt',   // Soft-Delete (nur null erlaubt zum Wiederherstellen)
]);

app.patch('/messages/:id', async (req, res) => {
  try {
    if (!validateId(req.params['id'], res)) return;

    const body = req.body as Record<string, unknown>;
    const safeData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_MESSAGE_PATCH.has(key)) continue;

      // Typ-Prüfung pro Feld
      if (key === 'flags') {
        if (!Array.isArray(value)) continue;
        safeData['flags'] = (value as unknown[]).filter((f): f is string => typeof f === 'string');
      } else if (key === 'deletedAt') {
        // null = Wiederherstellen, ansonsten: Zeitstempel setzen
        safeData['deletedAt'] = value === null ? null : new Date();
      } else if (key === 'changeKey') {
        if (typeof value !== 'string') continue;
        safeData['changeKey'] = value.slice(0, 255);
      } else if (key === 'modSeq') {
        if (typeof value !== 'number' && typeof value !== 'bigint') continue;
        safeData['modSeq'] = BigInt(value as number);
      }
    }

    if (Object.keys(safeData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const msg = await prisma.message.update({
      where: { id: req.params['id'] },
      data: safeData,
    });
    res.json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Soft-delete (oder Hard-delete wenn ?hard=true)
app.delete('/messages/:id', async (req, res) => {
  try {
    if (!validateId(req.params['id'], res)) return;
    const hard = req.query['hard'] === 'true';
    if (hard) {
      await prisma.message.delete({ where: { id: req.params['id'] } });
    } else {
      await prisma.message.update({
        where: { id: req.params['id'] },
        data: { deletedAt: new Date() },
      });
    }
    res.status(204).send();
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── MinIO Attachment Proxy ────────────────────────────────────────────────────
app.get('/attachments/:key(*)', async (req, res) => {
  try {
    const minio  = getMinioClient();
    const bucket = process.env['MINIO_BUCKET'] ?? 'mail-attachments';
    const key    = req.params['key'];
    // Path-Traversal in MinIO-Keys verhindern
    if (!key || key.includes('..') || key.startsWith('/')) {
      return res.status(400).json({ error: 'invalid key' });
    }
    const stream = await minio.getObject(bucket, key);
    stream.pipe(res);
  } catch (err) {
    log.error(err);
    res.status(404).json({ error: 'not found' });
  }
});

// ── Users (read-only, für Auth-Delegation) ───────────────────────────────────
app.get('/users/by-email/:email', async (req, res) => {
  try {
    // E-Mail-Format Basisprüfung
    const email = String(req.params['email'] ?? '');
    if (!email.includes('@') || email.length > 320) {
      return res.status(400).json({ error: 'invalid email' });
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, email: true, displayName: true, passwordHash: true,
        role: true, domainId: true, quotaBytes: true, usedBytes: true,
        active: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── 404 + Fehler-Handler ──────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal' });
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await runMigrations();
    app.listen(PORT, '127.0.0.1', () =>
      log.info(`storage-api listening on 127.0.0.1:${PORT} (loopback only)`)
    );
  } catch (err) {
    log.error(err, 'startup failed');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  log.info('shutting down');
  await prisma.$disconnect();
  process.exit(0);
});

start();
