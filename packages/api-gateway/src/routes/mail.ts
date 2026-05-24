import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { Readable } from 'stream';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { Queue } from 'bullmq';
import { prisma, downloadBuffer, parseRawMessage, uploadBuffer, rawMessageKey, outboundAttachKey } from '@coremail/storage';
import { getRedisClient, createBullMqConnection, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';

const log = createLogger('api:mail');
export const mailRouter: RouterType = Router();

// ── rspamd Bayes-Lernen ───────────────────────────────────────────────────────
const RSPAMD_URL = process.env['RSPAMD_URL'] ?? 'http://rspamd:11334';

/** Sendet eine Mail an rspamd /learnspam oder /learnham (fire and forget). */
async function rspamdLearn(action: 'learnspam' | 'learnham', raw: Buffer): Promise<void> {
  await fetch(`${RSPAMD_URL}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Für alle übergebenen Message-IDs: Rohinhalt aus MinIO laden (oder rekonstruieren)
 * und an rspamd learnspam/learnham senden. Fehler werden geloggt, nicht propagiert.
 */
async function rspamdLearnBatch(ids: string[], action: 'learnspam' | 'learnham', userId: string): Promise<void> {
  for (const id of ids) {
    try {
      const msg = await prisma.message.findFirst({
        where: { id, folder: { mailbox: { userId } } },
        include: { attachments: true },
      });
      if (!msg) continue;

      let raw: Buffer;
      if (msg.storagePath) {
        raw = await downloadBuffer(msg.storagePath);
      } else {
        // Minimalrekonstruktion für Bayes-Training
        const from = msg.fromName
          ? `"${msg.fromName.replace(/"/g, '\\"')}" <${msg.fromAddr}>`
          : `<${msg.fromAddr}>`;
        raw = Buffer.from(
          `From: ${from}\r\nTo: ${msg.toAddrs.join(', ')}\r\n` +
          `Subject: ${msg.subject ?? ''}\r\nDate: ${msg.date.toUTCString()}\r\n\r\n` +
          (msg.bodyText || msg.bodyHtml || ''),
        );
      }

      await rspamdLearn(action, raw);
      log.debug({ id, action }, 'rspamd learning successful');
    } catch (err) {
      log.warn({ err, id, action }, 'rspamd learning failed — skipped');
    }
  }
}
mailRouter.use(requireAuth);

// ── Multer (Anhänge, max 25 MB/Datei, max 20 Dateien) ────────────────────────
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
}).array('attachments', 20);

// ── BullMQ Outbound-Queue (gleiche wie smtp-server) ───────────────────────────
let _outboundQueue: Queue | null = null;
function getOutboundQueue(): Queue {
  if (!_outboundQueue) {
    // BullMQ v5 erfordert maxRetriesPerRequest: null — createBullMqConnection() liefert das.
    // getRedisClient() (shared, maxRetriesPerRequest: 3) crasht den Prozess wenn BullMQ
    // interne Blocking-Commands ausführt → unhandled rejection → NetworkError im Browser.
    // BullMQ v5: Kein ':' im Queue-Namen erlaubt — smtp-server nutzt 'smtp-outbound'
    _outboundQueue = new Queue('smtp-outbound', {
      connection: createBullMqConnection(),
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return _outboundQueue;
}

// ── Nodemailer: MIME-Rohmessage aufbauen ──────────────────────────────────────
// WICHTIG: newline: 'crlf' — SMTP-Protokoll (RFC 5321) erfordert CRLF (\r\n).
// nodemailer's smtp-connection normalisiert Buffer-Inhalte NICHT automatisch
// (nur String-Inhalte). Mit 'unix' (LF-only) kann der empfangende MTA den
// Header/Body-Separator (\r\n\r\n) nicht erkennen → roher MIME-Text im Body.
async function buildRawMime(options: nodemailer.SendMailOptions): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'crlf' });
  const info = await transport.sendMail(options);
  const stream = info.message as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

// Hilfsfunktion: kommagetrennte Adressen parsen
function parseAddrs(val: unknown): string[] {
  if (!val) return [];
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

const SYSTEM_FOLDER_NAMES = new Set(['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive', 'Outbox']);

// GET /api/v1/mail/folders — list all folders
mailRouter.get('/folders', async (req: Request, res: Response) => {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json([]); return; }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: {
      id: true, name: true, displayName: true, parentId: true,
      totalCount: true, unreadCount: true,
      isFavorite: true, sortOrder: true, color: true,
      retentionTagId: true,
      retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(folders.map((f) => ({ ...f, isSystem: SYSTEM_FOLDER_NAMES.has(f.name) })));
});

// POST /api/v1/mail/folders — create user folder
const CreateFolderSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[^/\\]+$/, 'Ungültiger Ordnername'),
  parentId: z.string().nullable().optional(),
  color: z.string().optional(),
});
mailRouter.post('/folders', async (req: Request, res: Response) => {
  const parsed = CreateFolderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  if (SYSTEM_FOLDER_NAMES.has(parsed.data.name)) {
    res.status(400).json({ error: 'Reservierter Systemordner-Name' }); return;
  }

  const exists = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: parsed.data.name },
  });
  if (exists) { res.status(409).json({ error: 'Ordner existiert bereits' }); return; }

  if (parsed.data.parentId) {
    const parent = await prisma.folder.findFirst({
      where: { id: parsed.data.parentId, mailboxId: mailbox.id },
    });
    if (!parent) { res.status(404).json({ error: 'Übergeordneter Ordner nicht gefunden' }); return; }
  }

  const folder = await prisma.folder.create({
    data: {
      mailboxId: mailbox.id,
      name: parsed.data.name,
      displayName: parsed.data.name,
      ...(parsed.data.parentId ? { parentId: parsed.data.parentId } : {}),
      ...(parsed.data.color ? { color: parsed.data.color } : {}),
    },
  });
  res.json(folder);
});

// PATCH /api/v1/mail/folders/:id — rename / favorite / sort / color
const PatchFolderSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[^/\\]+$/).optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  color: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
});
mailRouter.patch('/folders/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchFolderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  if (parsed.data.name && SYSTEM_FOLDER_NAMES.has(folder.name)) {
    res.status(400).json({ error: 'Systemordner kann nicht umbenannt werden' }); return;
  }
  if (parsed.data.name && parsed.data.name !== folder.name) {
    const collision = await prisma.folder.findFirst({
      where: { mailboxId: folder.mailboxId, name: parsed.data.name, id: { not: id } },
    });
    if (collision) { res.status(409).json({ error: 'Name bereits vergeben' }); return; }
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)       updates['name'] = parsed.data.name;
  if (parsed.data.name !== undefined)       updates['displayName'] = parsed.data.name;
  if (parsed.data.isFavorite !== undefined) updates['isFavorite'] = parsed.data.isFavorite;
  if (parsed.data.sortOrder !== undefined)  updates['sortOrder'] = parsed.data.sortOrder;
  if (parsed.data.color !== undefined)      updates['color'] = parsed.data.color;
  if (parsed.data.parentId !== undefined)   updates['parentId'] = parsed.data.parentId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.folder.update({ where: { id }, data: updates as any });
  res.json(updated);
});

// DELETE /api/v1/mail/folders/:id — delete user folder (must be empty or include ?force=true)
mailRouter.delete('/folders/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const force = req.query['force'] === 'true';

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (SYSTEM_FOLDER_NAMES.has(folder.name)) {
    res.status(400).json({ error: 'Systemordner kann nicht gelöscht werden' }); return;
  }

  if (!force) {
    const count = await prisma.message.count({ where: { folderId: id, deletedAt: null } });
    if (count > 0) {
      res.status(409).json({ error: 'Ordner nicht leer', count }); return;
    }
  }

  await prisma.folder.delete({ where: { id } });
  res.json({ ok: true });
});

// PATCH /api/v1/mail/folders/:id/retention-tag — assign / clear PERSONAL retention tag
// Body: { tagId: string | null }
const FolderRetentionTagSchema = z.object({ tagId: z.string().nullable() });
mailRouter.patch('/folders/:id/retention-tag', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = FolderRetentionTagSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verify folder belongs to authenticated user's mailbox
  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  // If tagId given, verify it's an assignable PERSONAL tag and enabled
  if (parsed.data.tagId) {
    const tag = await prisma.retentionTag.findFirst({
      where: { id: parsed.data.tagId, type: 'PERSONAL', enabled: true },
    });
    if (!tag) { res.status(404).json({ error: 'Retention tag not found or not assignable' }); return; }
  }

  const updated = await prisma.folder.update({
    where: { id },
    data: { retentionTagId: parsed.data.tagId },
    include: { retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } } },
  });
  res.json({
    id: updated.id,
    retentionTagId: updated.retentionTagId,
    retentionTag: updated.retentionTag,
  });
});

// PATCH /api/v1/mail/messages/:id/retention-tag — assign / clear PERSONAL retention tag on a single message
// Body: { tagId: string | null }
mailRouter.patch('/messages/:id/retention-tag', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = FolderRetentionTagSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verify message belongs to a folder in the user's mailbox
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  if (parsed.data.tagId) {
    const tag = await prisma.retentionTag.findFirst({
      where: { id: parsed.data.tagId, type: 'PERSONAL', enabled: true },
    });
    if (!tag) { res.status(404).json({ error: 'Retention tag not found or not assignable' }); return; }
  }

  const updated = await prisma.message.update({
    where: { id },
    data: { retentionTagId: parsed.data.tagId, modSeq: BigInt(Date.now()) },
    include: { retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } } },
  });
  res.json({
    id: updated.id,
    retentionTagId: updated.retentionTagId,
    retentionTag: updated.retentionTag,
  });
});

// POST /api/v1/mail/folders/:id/empty — delete all messages in folder (hard-delete for Trash/Junk, soft for others)
mailRouter.post('/folders/:id/empty', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const hardDelete = folder.name === 'Trash' || folder.name === 'Junk';

  if (hardDelete) {
    const result = await prisma.message.deleteMany({ where: { folderId: id } });
    await prisma.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });
    res.json({ ok: true, deleted: result.count });
    return;
  }

  // Soft: in Papierkorb verschieben
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  const trash = await prisma.folder.findFirst({ where: { mailboxId: mailbox!.id, name: 'Trash' } });
  if (!trash) { res.status(500).json({ error: 'Papierkorb nicht gefunden' }); return; }

  const messages = await prisma.message.findMany({
    where: { folderId: id, deletedAt: null },
    select: { id: true },
  });
  await prisma.message.updateMany({
    where: { folderId: id, deletedAt: null },
    data: { folderId: trash.id },
  });
  await prisma.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });
  res.json({ ok: true, moved: messages.length });
});

// POST /api/v1/mail/messages/bulk — bulk actions across multiple messages
const BulkActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(['read', 'unread', 'flag', 'unflag', 'pin', 'unpin', 'move', 'delete', 'archive', 'spam', 'notSpam']),
  folderId: z.string().optional(), // for move
});
mailRouter.post('/messages/bulk', async (req: Request, res: Response) => {
  const parsed = BulkActionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const { ids, action } = parsed.data;
  const userId = req.apiUser!.userId;

  // Authorize: nur eigene Nachrichten
  const messages = await prisma.message.findMany({
    where: { id: { in: ids }, folder: { mailbox: { userId } } },
    select: { id: true, folderId: true, flags: true },
  });
  if (!messages.length) { res.status(404).json({ error: 'Keine Nachrichten gefunden' }); return; }
  const ownedIds = messages.map((m) => m.id);

  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  const resolveSysFolder = async (name: string) =>
    prisma.folder.findFirst({ where: { mailboxId: mailbox!.id, name } });

  switch (action) {
    case 'read':
    case 'unread': {
      const shouldRead = action === 'read';
      const tasks = messages.map((m) => {
        const flags = shouldRead
          ? [...new Set([...m.flags, '\\Seen'])]
          : m.flags.filter((f) => f !== '\\Seen');
        return prisma.message.update({
          where: { id: m.id },
          data: { flags, modSeq: BigInt(Date.now()) },
        });
      });
      await prisma.$transaction(tasks);
      break;
    }
    case 'flag':
    case 'unflag': {
      const shouldFlag = action === 'flag';
      const tasks = messages.map((m) => {
        const flags = shouldFlag
          ? [...new Set([...m.flags, '\\Flagged'])]
          : m.flags.filter((f) => f !== '\\Flagged');
        return prisma.message.update({
          where: { id: m.id },
          data: { flags, modSeq: BigInt(Date.now()) },
        });
      });
      await prisma.$transaction(tasks);
      break;
    }
    case 'pin':
    case 'unpin': {
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { pinnedAt: action === 'pin' ? new Date() : null, modSeq: BigInt(Date.now()) },
      });
      break;
    }
    case 'move': {
      if (!parsed.data.folderId) { res.status(400).json({ error: 'folderId erforderlich' }); return; }
      const target = await prisma.folder.findFirst({
        where: { id: parsed.data.folderId, mailbox: { userId } },
      });
      if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { folderId: target.id, modSeq: BigInt(Date.now()) },
      });
      break;
    }
    case 'archive': {
      const archive = await resolveSysFolder('Archive');
      if (!archive) { res.status(404).json({ error: 'Archiv-Ordner nicht gefunden' }); return; }
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { folderId: archive.id, modSeq: BigInt(Date.now()) },
      });
      break;
    }
    case 'delete': {
      const trash = await resolveSysFolder('Trash');
      // Schon im Papierkorb? → hard delete
      const inTrash = messages.filter((m) => m.folderId === trash?.id).map((m) => m.id);
      const notInTrash = messages.filter((m) => m.folderId !== trash?.id).map((m) => m.id);
      if (inTrash.length) {
        await prisma.message.deleteMany({ where: { id: { in: inTrash } } });
      }
      if (notInTrash.length && trash) {
        await prisma.message.updateMany({
          where: { id: { in: notInTrash } },
          data: { folderId: trash.id, modSeq: BigInt(Date.now()) },
        });
      }
      break;
    }
    case 'spam': {
      const junk = await resolveSysFolder('Junk');
      if (!junk) { res.status(404).json({ error: 'Junk-Ordner nicht gefunden' }); return; }
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { folderId: junk.id, modSeq: BigInt(Date.now()) },
      });
      // Absender in USER-JUNK-Sperrliste aufnehmen → storeInboundMessage leitet
      // künftige Mails dieses Absenders automatisch in den Junk-Ordner.
      // Scope 'USER-JUNK' wird vom security-filter NICHT als SMTP-Reject behandelt,
      // sondern ausschließlich beim Speichern geprüft (kein Bounce für den Absender).
      void (async () => {
        try {
          const msgs = await prisma.message.findMany({
            where: { id: { in: ownedIds } },
            select: { fromAddr: true },
          });
          const senders = [...new Set(msgs.map((m) => m.fromAddr.toLowerCase()))];
          for (const sender of senders) {
            const exists = await prisma.blacklist.findFirst({
              where: { scope: 'USER-JUNK', scopeId: req.apiUser!.userId, pattern: sender },
            });
            if (!exists) {
              await prisma.blacklist.create({
                data: {
                  scope: 'USER-JUNK',
                  scopeId: req.apiUser!.userId,
                  pattern: sender,
                  patternType: 'EXACT',
                  comment: `Manuell als Junk markiert am ${new Date().toISOString().slice(0, 10)}`,
                },
              });
            }
          }
        } catch (err) {
          log.warn({ err }, 'USER-JUNK Blacklist-Eintrag fehlgeschlagen — ignoriert');
        }
      })();
      // rspamd Bayes-Lernen (fire and forget) — verbessert Spam-Erkennung über Zeit
      void rspamdLearnBatch(ownedIds, 'learnspam', req.apiUser!.userId);
      break;
    }
    case 'notSpam': {
      const inbox = await resolveSysFolder('INBOX');
      if (!inbox) { res.status(404).json({ error: 'Posteingang nicht gefunden' }); return; }
      // Zurück in INBOX UND spamScore auf 0 setzen (sonst zeigt Reader-Banner
      // weiterhin "Diese Nachricht wurde als Spam erkannt", obwohl sie als
      // Ham markiert wurde)
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { folderId: inbox.id, modSeq: BigInt(Date.now()), spamScore: 0 },
      });
      // Absender aus USER-JUNK-Sperrliste entfernen (False Positive)
      void (async () => {
        try {
          const msgs = await prisma.message.findMany({
            where: { id: { in: ownedIds } },
            select: { fromAddr: true },
          });
          const senders = [...new Set(msgs.map((m) => m.fromAddr.toLowerCase()))];
          await prisma.blacklist.deleteMany({
            where: { scope: 'USER-JUNK', scopeId: req.apiUser!.userId, pattern: { in: senders } },
          });
        } catch (err) {
          log.warn({ err }, 'USER-JUNK Blacklist-Entfernung fehlgeschlagen — ignoriert');
        }
      })();
      // rspamd Bayes-Lernen: Als Ham markieren
      void rspamdLearnBatch(ownedIds, 'learnham', req.apiUser!.userId);
      break;
    }
  }

  res.json({ ok: true, affected: ownedIds.length });
});

// POST /api/v1/mail/messages/:id/snooze — hide until date
const SnoozeSchema = z.object({ until: z.string().datetime() });
mailRouter.post('/messages/:id/snooze', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = SnoozeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  await prisma.message.update({
    where: { id },
    data: { snoozeUntil: new Date(parsed.data.until), modSeq: BigInt(Date.now()) },
  });
  res.json({ ok: true });
});

// DELETE /api/v1/mail/messages/:id/snooze — clear snooze
mailRouter.delete('/messages/:id/snooze', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
  await prisma.message.update({
    where: { id },
    data: { snoozeUntil: null, modSeq: BigInt(Date.now()) },
  });
  res.json({ ok: true });
});

// GET /api/v1/mail/messages/:id/raw — RFC 822 raw EML / source view
mailRouter.get('/messages/:id/raw', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
    include: { attachments: true },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  // Originales RFC 822 MIME aus MinIO (für große Nachrichten, die dort abgelegt sind)
  if (msg.storagePath) {
    try {
      const raw = await downloadBuffer(msg.storagePath);
      res.setHeader('Content-Type', 'message/rfc822');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(msg.subject || 'message')}.eml"`);
      res.send(raw);
      return;
    } catch {
      // MinIO-Fehler → Fallback auf Rekonstruktion
    }
  }

  // ── RFC 822 Rekonstruktion aus DB-Feldern ─────────────────────────────────
  // Gemäß RFC 822 §3: Header-Zeilen + Leerzeile + Body
  // Gemäß RFC 2045: MIME-Version + Content-Type
  const boundary = `=_CoreMail_${crypto.randomUUID().replace(/-/g, '')}`;
  const hasHtml  = !!msg.bodyHtml;
  const hasText  = !!msg.bodyText;
  const multipart = hasHtml && hasText;

  const headerLines = [
    `From: ${msg.fromName ? `"${msg.fromName.replace(/"/g, '\\"')}" ` : ''}<${msg.fromAddr}>`,
    `To: ${msg.toAddrs.join(', ')}`,
    msg.ccAddrs.length  ? `Cc: ${msg.ccAddrs.join(', ')}`   : '',
    msg.bccAddrs?.length ? `Bcc: ${msg.bccAddrs.join(', ')}` : '',
    `Subject: ${msg.subject ?? ''}`,
    `Date: ${msg.date.toUTCString().replace('GMT', '+0000')}`,
    msg.messageId ? `Message-ID: ${msg.messageId}` : '',
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : '',
    msg.replyTo   ? `Reply-To: ${msg.replyTo}`      : '',
    'MIME-Version: 1.0',
    'X-Mailer: CoreMail (reconstructed)',
    multipart
      ? `Content-Type: multipart/alternative; boundary="${boundary}"`
      : hasHtml
        ? 'Content-Type: text/html; charset=utf-8'
        : 'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: 8bit`,
  ].filter(Boolean).join('\r\n');

  let body: string;
  if (multipart) {
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.bodyText,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.bodyHtml,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    body = hasHtml ? msg.bodyHtml : msg.bodyText;
  }

  const rawEml = `${headerLines}\r\n\r\n${body}`;
  res.setHeader('Content-Type', 'message/rfc822; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(msg.subject || 'message')}.eml"`);
  res.send(rawEml);
});

// GET /api/v1/mail/folders/:folderId/messages
mailRouter.get('/folders/:folderId/messages', async (req: Request, res: Response) => {
  const { folderId } = req.params as { folderId: string };
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10), 200);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

  
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const now = new Date();
  // Snooze: nur im Posteingang Mails verbergen, die noch in der Zukunft "schlummern"
  const snoozeFilter = folder.name === 'INBOX'
    ? { OR: [{ snoozeUntil: null }, { snoozeUntil: { lte: now } }] }
    : {};

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { folderId, deletedAt: null, ...snoozeFilter },
      orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { date: 'desc' }],
      take: limit,
      skip: offset,
      select: {
        id: true, uid: true, subject: true, fromAddr: true, fromName: true, toAddrs: true,
        date: true, flags: true, rawSize: true, pinnedAt: true, snoozeUntil: true,
        attachments: { select: { id: true, filename: true, mimeType: true, size: true } },
        categories: { select: { category: { select: { id: true, name: true, color: true } } } },
      },
    }),
    prisma.message.count({ where: { folderId, deletedAt: null, ...snoozeFilter } }),
  ]);

  // Kategorien-Beziehung flach mappen
  const flat = messages.map((m) => ({
    ...m,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    categories: (m as any).categories?.map((c: any) => c.category) ?? [],
  }));

  res.json({ messages: flat, total, limit, offset });
});

// GET /api/v1/mail/messages/:id — full message
mailRouter.get('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const msg = await prisma.message.findFirst({
    where: { id, deletedAt: null, folder: { mailbox: { userId: req.apiUser!.userId } } },
    include: { attachments: true },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  // Mark as read
  if (!msg.flags.includes('\\Seen')) {
    await prisma.message.update({
      where: { id },
      data: { flags: { push: '\\Seen' }, modSeq: BigInt(Date.now()) },
    });
    await prisma.folder.update({
      where: { id: msg.folderId },
      data: { unreadCount: { decrement: 1 } },
    });
  }

  res.json(msg);
});

// PATCH /api/v1/mail/messages/:id — update flags / move
const PatchMessageSchema = z.object({
  flags: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  read: z.boolean().optional(),
  flagged: z.boolean().optional(),
});

mailRouter.patch('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchMessageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  const updates: Record<string, unknown> = { modSeq: BigInt(Date.now()) };
  let newFlags = [...msg.flags];

  if (parsed.data.read !== undefined) {
    newFlags = parsed.data.read
      ? [...new Set([...newFlags, '\\Seen'])]
      : newFlags.filter((f) => f !== '\\Seen');
  }
  if (parsed.data.flagged !== undefined) {
    newFlags = parsed.data.flagged
      ? [...new Set([...newFlags, '\\Flagged'])]
      : newFlags.filter((f) => f !== '\\Flagged');
  }
  if (parsed.data.flags) newFlags = parsed.data.flags;
  updates['flags'] = newFlags;

  if (parsed.data.folderId) {
    const targetFolder = await prisma.folder.findFirst({
      where: { id: parsed.data.folderId, mailbox: { userId: req.apiUser!.userId } },
    });
    if (!targetFolder) { res.status(404).json({ error: 'Target folder not found' }); return; }
    updates['folderId'] = parsed.data.folderId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await prisma.message.update({ where: { id }, data: updates as any });
  res.json({ ok: true });
});

// DELETE /api/v1/mail/messages/:id — soft delete
mailRouter.delete('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hard = req.query['hard'] === 'true';

  
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  if (hard) {
    await prisma.message.delete({ where: { id } });
  } else {
    // Move to Trash
    const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
    const trash = await prisma.folder.findFirst({ where: { mailboxId: mailbox!.id, name: 'Trash' } });
    if (trash) {
      await prisma.message.update({ where: { id }, data: { folderId: trash.id } });
    } else {
      await prisma.message.update({ where: { id }, data: { deletedAt: new Date() } });
    }
  }

  await prisma.folder.update({
    where: { id: msg.folderId },
    data: { totalCount: { decrement: 1 } },
  }).catch(() => undefined);

  res.json({ ok: true });
});

// POST /api/v1/mail/send — compose and send (multipart/form-data with optional attachments)
mailRouter.post(
  '/send',
  // Multer-Middleware: verarbeitet multipart/form-data; bei application/json kein Eingriff
  (req: Request, res: Response, next: NextFunction) => {
    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('application/json')) { next(); return; }
    uploadMiddleware(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload-Fehler: ${err.message}` }); return;
      }
      if (err) { res.status(400).json({ error: String(err) }); return; }
      next();
    });
  },
  async (req: Request, res: Response) => {
    // Felder aus JSON-Body ODER multipart-Formular lesen
    let to: string[];
    let cc: string[];
    let bcc: string[];
    let subject: string;
    let bodyHtml: string;
    let bodyText: string;
    let inReplyTo: string | undefined;
    let scheduledAt: Date | null = null;

    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('application/json')) {
      const schema = z.object({
        to: z.array(z.string()),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        bodyHtml: z.string().optional(),
        bodyText: z.string().optional(),
        inReplyTo: z.string().optional(),
        scheduledAt: z.string().datetime().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
      to       = parsed.data.to;
      cc       = parsed.data.cc ?? [];
      bcc      = parsed.data.bcc ?? [];
      subject  = parsed.data.subject;
      bodyHtml = parsed.data.bodyHtml ?? '';
      bodyText = parsed.data.bodyText ?? '';
      inReplyTo = parsed.data.inReplyTo;
      if (parsed.data.scheduledAt) scheduledAt = new Date(parsed.data.scheduledAt);
    } else {
      // multipart — Felder kommen als Strings (Arrays als Komma-getrennte Liste)
      to       = parseAddrs(req.body['to'] as unknown);
      cc       = parseAddrs(req.body['cc'] as unknown);
      bcc      = parseAddrs(req.body['bcc'] as unknown);
      subject  = String(req.body['subject'] ?? '');
      bodyHtml = String(req.body['bodyHtml'] ?? '');
      bodyText = String(req.body['bodyText'] ?? '');
      inReplyTo = req.body['inReplyTo'] ? String(req.body['inReplyTo']) : undefined;
      if (req.body['scheduledAt']) {
        const d = new Date(String(req.body['scheduledAt']));
        if (!isNaN(d.getTime())) scheduledAt = d;
      }
    }

    if (!to.length) { res.status(400).json({ error: 'Kein Empfänger angegeben' }); return; }

    // Schedule-Send Validierung: Zeitpunkt muss in der Zukunft liegen (>30s),
    // nicht weiter als 1 Jahr (sonst wahrscheinlich Fehler)
    const now = Date.now();
    if (scheduledAt) {
      const delayMs = scheduledAt.getTime() - now;
      if (delayMs < 30_000) {
        res.status(400).json({ error: 'Geplanter Versand muss mindestens 30 Sekunden in der Zukunft liegen' });
        return;
      }
      if (delayMs > 365 * 24 * 60 * 60 * 1000) {
        res.status(400).json({ error: 'Geplanter Versand darf nicht mehr als 1 Jahr in der Zukunft liegen' });
        return;
      }
    }

    // Absender laden (inkl. DKIM-Schlüssel der Domain)
    const user = await prisma.user.findUnique({
      where: { id: req.apiUser!.userId },
      include: { domain: true },
    });
    if (!user) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

    const files       = (req.files as Express.Multer.File[] | undefined) ?? [];
    const jobId       = crypto.randomUUID();
    const msgId       = `<${crypto.randomUUID()}@${user.domain.name}>`;
    const sendDate    = new Date();
    const displayName = (user.displayName ?? '').trim();

    // ── Anhänge in MinIO hochladen (kein base64-Blob im Redis-Job) ───────────
    // Dadurch bleibt der BullMQ-Job klein; der Worker lädt die Anhänge beim
    // Aufbau der RFC-5322-Nachricht aus MinIO herunter.
    const queueAttachments = await Promise.all(
      files.map(async (f) => {
        const minioPath = outboundAttachKey(jobId, f.originalname);
        await uploadBuffer(minioPath, f.buffer, f.mimetype);
        return {
          filename:    f.originalname,
          minioPath,
          contentType: f.mimetype,
          size:        f.size,
        };
      })
    );

    // ── BullMQ-Job: strukturierte Nachricht (v3.17.30+) ──────────────────────
    // Kein rawMessage (base64-Blob) mehr — der Worker baut den RFC-5322-Buffer
    // selbst auf. DKIM-Signierung erfolgt über nodemailer-Transport-Option.
    const smtpRecipients = [...to, ...cc, ...bcc];

    // BullMQ-Job: bei scheduledAt mit `delay` einreihen — der Worker startet
    // den Versand erst zum geplanten Zeitpunkt. delay wird intern in ms gemessen.
    const queueJobId = `api-${jobId}`;
    const jobOptions: { jobId: string; delay?: number } = { jobId: queueJobId };
    if (scheduledAt) {
      jobOptions.delay = scheduledAt.getTime() - now;
    }
    try {
      await getOutboundQueue().add('send', {
        messageId:    jobId,
        from:         user.email,
        to:           smtpRecipients,
        senderUserId: user.id,
        ...(user.domain.dkimPrivateKey ? {
          dkimDomain:     user.domain.name,
          dkimSelector:   user.domain.dkimSelector ?? 'mail',
          dkimPrivateKey: user.domain.dkimPrivateKey,
        } : {}),
        message: {
          from:      user.email,
          fromName:  displayName,          // leer → nodemailer lässt Quoted-String weg
          to,
          cc,
          bcc,                             // nur im SMTP-Envelope, nicht im Header
          subject,
          html:      bodyHtml,
          text:      bodyText,
          messageId: msgId,
          // Bei Schedule-Send: Date-Header auf scheduledAt setzen damit der
          // Empfänger den geplanten Versandzeitpunkt sieht (nicht den Erstell-Zeitpunkt)
          date:      (scheduledAt ?? sendDate).toISOString(),
          ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
          attachments: queueAttachments,
        },
      }, jobOptions);
    } catch (queueErr) {
      log.error({ err: queueErr }, 'Outbound-Queue-Add fehlgeschlagen');
      res.status(500).json({ error: 'Nachricht konnte nicht in die Warteschlange eingereiht werden' });
      return;
    }

    // ── MAIL_FLOW — ACCEPTED-Log ──────────────────────────────────────────────
    void prisma.systemLog.create({
      data: {
        level:    'INFO',
        service:  'api-gateway',
        category: 'MAIL_FLOW',
        message:  `Sent: ${user.email} → ${smtpRecipients.join(', ')}`,
        userId:   user.id,
        metadata: {
          sender:    user.email,
          recipient: smtpRecipients.join(', '),
          subject,
          status:    'ACCEPTED',
          messageId: jobId,
          direction: 'OUTBOUND',
        },
      },
    }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW-Log fehlgeschlagen'));

    // ── Kopie in Gesendete Elemente speichern ────────────────────────────────
    // RFC-5322-Buffer wird hier separat aufgebaut (mit In-Memory-Anhängen, nicht MinIO)
    // damit die Sent-Kopie sofort verfügbar ist, ohne auf den Worker zu warten.
    void (async () => {
      try {
        const mailbox = await prisma.mailbox.findFirst({
          where: { userId: user.id },
          include: { folders: true },
        });
        const sentFolder = mailbox?.folders.find((f: { name: string }) => f.name === 'Sent');
        if (!sentFolder || !mailbox) return;

        // Raw-Buffer für Sent-Kopie mit In-Memory-Anhängen
        const sentAttachments: nodemailer.SendMailOptions['attachments'] = files.map((f) => ({
          filename:    f.originalname,
          content:     f.buffer,
          contentType: f.mimetype,
        }));
        const fromAddress: nodemailer.SendMailOptions['from'] = displayName
          ? { name: displayName, address: user.email }
          : user.email;

        const rawBuffer = await buildRawMime({
          messageId: msgId,
          from:      fromAddress,
          to,
          subject,
          date:      sendDate,
          ...(cc.length             ? { cc }                                  : {}),
          ...(bcc.length            ? { bcc }                                 : {}),
          ...(bodyHtml              ? { html: bodyHtml }                      : {}),
          ...(bodyText              ? { text: bodyText }                      : {}),
          ...(inReplyTo             ? { inReplyTo, references: inReplyTo }    : {}),
          ...(sentAttachments.length ? { attachments: sentAttachments }        : {}),
        });

        const parsed = await parseRawMessage(rawBuffer);
        const updatedMbx = await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { uidNext: { increment: 1 }, highestModSeq: { increment: 1 } },
        });
        const uid    = updatedMbx.uidNext - 1;
        const modSeq = updatedMbx.highestModSeq;

        const LARGE = 256 * 1024;
        let storagePath: string | null = null;
        if (rawBuffer.length > LARGE) {
          const storageId = crypto.randomUUID();
          storagePath = rawMessageKey(storageId);
          await uploadBuffer(storagePath, rawBuffer, 'message/rfc822');
        }

        await prisma.message.create({
          data: {
            folderId:  sentFolder.id,
            uid, modSeq,
            flags:     ['\\Seen'],
            subject:   parsed.subject,
            fromAddr:  parsed.fromAddr,
            fromName:  parsed.fromName,
            toAddrs:   parsed.toAddrs,
            ccAddrs:   parsed.ccAddrs,
            bccAddrs:  parsed.bccAddrs,
            replyTo:   parsed.replyTo,
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            date:      parsed.date,
            bodyText:  storagePath ? '' : parsed.bodyText,
            bodyHtml:  storagePath ? '' : parsed.bodyHtml,
            rawSize:   rawBuffer.length,
            storagePath,
            changeKey: modSeq.toString(),
            // Schedule-Send-Metadaten: ermöglicht Banner + Cancel-Button im Reader
            ...(scheduledAt ? {
              scheduledAt,
              scheduledStatus: 'PENDING',
              scheduledJobId:  queueJobId,
            } : {}),
          },
        });
        await prisma.folder.update({
          where: { id: sentFolder.id },
          data: { totalCount: { increment: 1 }, changeKey: modSeq.toString() },
        });
      } catch (e) {
        log.warn({ err: e }, 'Sent-Kopie konnte nicht gespeichert werden');
      }
    })();

    log.info(
      { userId: user.id, to, attachments: files.length, scheduled: !!scheduledAt },
      scheduledAt ? 'Geplante Nachricht in Queue eingereiht' : 'Nachricht in Queue eingereiht',
    );
    res.json({
      ok: true,
      jobId,
      ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString(), scheduled: true } : { scheduled: false }),
    });
  },
);

// POST /api/v1/mail/messages/:id/cancel-scheduled — geplanten Versand abbrechen
mailRouter.post('/messages/:id/cancel-scheduled', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
    select: { id: true, scheduledStatus: true, scheduledJobId: true, folderId: true },
  });
  if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
  if (msg.scheduledStatus !== 'PENDING') {
    res.status(409).json({ error: `Nicht abbrechbar — Status: ${msg.scheduledStatus ?? '(nicht geplant)'}` });
    return;
  }

  // BullMQ-Job entfernen (delay-Job kann via remove() gestoppt werden)
  let jobRemoved = false;
  if (msg.scheduledJobId) {
    try {
      const job = await getOutboundQueue().getJob(msg.scheduledJobId);
      if (job) {
        await job.remove();
        jobRemoved = true;
      }
    } catch (err) {
      log.warn({ err, jobId: msg.scheduledJobId }, 'BullMQ-Job-Remove fehlgeschlagen — Message wird trotzdem als CANCELLED markiert');
    }
  }

  await prisma.message.update({
    where: { id },
    data: {
      scheduledStatus: 'CANCELLED',
      // scheduledAt/scheduledJobId für Audit-Trail behalten
      modSeq: BigInt(Date.now()),
    },
  });

  res.json({ ok: true, jobRemoved });
});

// GET /api/v1/mail/search?q=foo&categoryId=...
mailRouter.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const categoryId = req.query['categoryId'] ? String(req.query['categoryId']) : null;
  if (q.length < 2 && !categoryId) { res.json({ messages: [], total: 0 }); return; }

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json({ messages: [], total: 0 }); return; }

  const folderIds = (await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: { id: true },
  })).map((f: { id: string }) => f.id);

  const where: Record<string, unknown> = {
    folderId: { in: folderIds },
    deletedAt: null,
  };
  if (q.length >= 2) {
    where['OR'] = [
      { subject:  { contains: q, mode: 'insensitive' } },
      { fromAddr: { contains: q, mode: 'insensitive' } },
      { fromName: { contains: q, mode: 'insensitive' } },
      { bodyText: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (categoryId) {
    where['categories'] = { some: { categoryId, category: { userId: req.apiUser!.userId } } };
  }

  const messages = await prisma.message.findMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: where as any,
    orderBy: { date: 'desc' },
    take: 100,
    select: {
      id: true, subject: true, fromAddr: true, fromName: true, date: true, flags: true, folderId: true,
      categories: { select: { category: { select: { id: true, name: true, color: true } } } },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flat = messages.map((m: any) => ({
    ...m,
    categories: m.categories?.map((c: any) => c.category) ?? [],
  }));

  res.json({ messages: flat, total: flat.length });
});

// GET /api/v1/mail/delegated-mailboxes
// Gibt alle Postfächer zurück auf die der aktuelle User Zugriff hat
mailRouter.get('/delegated-mailboxes', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const delegates = await prisma.mailboxDelegate.findMany({
    where: { granteeId: userId },
    include: {
      mailbox: {
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          folders: { select: { id: true, name: true, displayName: true, totalCount: true, unreadCount: true } },
        },
      },
    },
    orderBy: { grantedAt: 'asc' },
  });
  res.json(delegates.map((d) => ({
    id: d.id,
    permission: d.permission,
    grantedAt: d.grantedAt,
    mailboxOwner: d.mailbox.user,
    mailboxId: d.mailbox.id,
    folders: d.mailbox.folders,
  })));
});
