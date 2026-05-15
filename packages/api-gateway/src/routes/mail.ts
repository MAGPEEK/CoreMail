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

// GET /api/v1/mail/folders — list all folders
mailRouter.get('/folders', async (req: Request, res: Response) => {
  
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json([]); return; }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: { id: true, name: true, parentId: true, totalCount: true, unreadCount: true },
    orderBy: { name: 'asc' },
  });
  res.json(folders);
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

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { folderId, deletedAt: null },
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true, uid: true, subject: true, fromAddr: true, toAddrs: true,
        date: true, flags: true, rawSize: true,
        attachments: { select: { id: true, filename: true, mimeType: true, size: true } },
      },
    }),
    prisma.message.count({ where: { folderId, deletedAt: null } }),
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
