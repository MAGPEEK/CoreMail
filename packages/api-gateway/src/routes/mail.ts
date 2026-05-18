import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { Readable } from 'stream';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { Queue } from 'bullmq';
import { prisma } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';

const log = createLogger('api:mail');
export const mailRouter: RouterType = Router();
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
    _outboundQueue = new Queue('smtp:outbound', {
      connection: getRedisClient(),
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
async function buildRawMime(options: nodemailer.SendMailOptions): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
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
      // TODO: rspamd Bayes-Lernen via /learnspam (Phase 2)
      break;
    }
    case 'notSpam': {
      const inbox = await resolveSysFolder('INBOX');
      if (!inbox) { res.status(404).json({ error: 'Posteingang nicht gefunden' }); return; }
      await prisma.message.updateMany({
        where: { id: { in: ownedIds } },
        data: { folderId: inbox.id, modSeq: BigInt(Date.now()) },
      });
      // TODO: rspamd Bayes-Lernen via /learnham (Phase 2)
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

// GET /api/v1/mail/messages/:id/raw — raw EML / source view
mailRouter.get('/messages/:id/raw', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
    include: { attachments: true },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  // Wenn rohes MIME in MinIO liegt, später aus storage holen.
  // Fallback: reconstructed plain headers + body (best-effort)
  const headers = [
    `From: ${msg.fromName ? `"${msg.fromName}" ` : ''}<${msg.fromAddr}>`,
    `To: ${msg.toAddrs.join(', ')}`,
    msg.ccAddrs.length ? `Cc: ${msg.ccAddrs.join(', ')}` : '',
    `Subject: ${msg.subject}`,
    `Date: ${msg.date.toUTCString()}`,
    msg.messageId ? `Message-ID: ${msg.messageId}` : '',
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : '',
    'MIME-Version: 1.0',
    msg.bodyHtml ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean).join('\r\n');

  const body = msg.bodyHtml || msg.bodyText;
  res.setHeader('Content-Type', 'message/rfc822; charset=utf-8');
  res.send(`${headers}\r\n\r\n${body}`);
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
      },
    }),
    prisma.message.count({ where: { folderId, deletedAt: null, ...snoozeFilter } }),
  ]);

  res.json({ messages, total, limit, offset });
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
    } else {
      // multipart — Felder kommen als Strings (Arrays als Komma-getrennte Liste)
      to       = parseAddrs(req.body['to'] as unknown);
      cc       = parseAddrs(req.body['cc'] as unknown);
      bcc      = parseAddrs(req.body['bcc'] as unknown);
      subject  = String(req.body['subject'] ?? '');
      bodyHtml = String(req.body['bodyHtml'] ?? '');
      bodyText = String(req.body['bodyText'] ?? '');
      inReplyTo = req.body['inReplyTo'] ? String(req.body['inReplyTo']) : undefined;
    }

    if (!to.length) { res.status(400).json({ error: 'Kein Empfänger angegeben' }); return; }

    // Absender laden (inkl. DKIM-Schlüssel der Domain)
    const user = await prisma.user.findUnique({
      where: { id: req.apiUser!.userId },
      include: { domain: true },
    });
    if (!user) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

    // Hochgeladene Anhänge als Nodemailer-Attachment-Objekte
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const attachments: nodemailer.SendMailOptions['attachments'] = files.map((f) => ({
      filename: f.originalname,
      content:  f.buffer,
      contentType: f.mimetype,
    }));

    // Rohe MIME-Nachricht aufbauen
    const mailOptions: nodemailer.SendMailOptions = {
      messageId: `<${crypto.randomUUID()}@${user.domain.name}>`,
      from: `"${user.displayName}" <${user.email}>`,
      to,
      subject,
      ...(cc.length  ? { cc }  : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(bodyHtml   ? { html: bodyHtml } : {}),
      ...(bodyText   ? { text: bodyText } : {}),
      ...(inReplyTo  ? { inReplyTo, references: inReplyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    let rawBuffer: Buffer;
    try {
      rawBuffer = await buildRawMime(mailOptions);
    } catch (err) {
      log.error({ err }, 'MIME-Aufbau fehlgeschlagen');
      res.status(500).json({ error: 'Nachricht konnte nicht aufgebaut werden' }); return;
    }

    // BullMQ-Job: alle Empfänger (To + CC + BCC) als SMTP-Envelope
    const smtpRecipients = [...to, ...cc, ...bcc];
    const jobId = crypto.randomUUID();

    await getOutboundQueue().add('send', {
      messageId: jobId,
      from: user.email,
      to: smtpRecipients,
      rawMessage: rawBuffer.toString('base64'),
      senderUserId: user.id,
      ...(user.domain.dkimPrivateKey ? {
        dkimDomain:      user.domain.name,
        dkimSelector:    user.domain.dkimSelector,
        dkimPrivateKey:  user.domain.dkimPrivateKey,
      } : {}),
    }, { jobId: `api-${jobId}` });

    log.info({ userId: user.id, to, attachments: files.length }, 'Nachricht in Queue eingereiht');
    res.json({ ok: true, jobId });
  },
);

// GET /api/v1/mail/search
mailRouter.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  if (q.length < 2) { res.json({ messages: [], total: 0 }); return; }

  
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json({ messages: [], total: 0 }); return; }

  const folderIds = (await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: { id: true },
  })).map((f: { id: string }) => f.id);

  const messages = await prisma.message.findMany({
    where: {
      folderId: { in: folderIds },
      deletedAt: null,
      OR: [
        { subject: { contains: q, mode: 'insensitive' } },
        { fromAddr: { contains: q, mode: 'insensitive' } },
        { bodyText: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { date: 'desc' },
    take: 50,
    select: { id: true, subject: true, fromAddr: true, date: true, flags: true, folderId: true },
  });

  res.json({ messages, total: messages.length });
});
