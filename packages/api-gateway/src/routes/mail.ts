import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';

const log = createLogger('api:mail');
export const mailRouter: RouterType = Router();
mailRouter.use(requireAuth);

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

// POST /api/v1/mail/send — compose and send
const SendSchema = z.object({
  to: z.array(z.string().email()),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  inReplyTo: z.string().optional(),
});

mailRouter.post('/send', async (req: Request, res: Response) => {
  const parsed = SendSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { to, cc = [], bcc = [], subject, bodyHtml = '', bodyText = '', inReplyTo } = parsed.data;
  const redis = getRedisClient();

  await redis.lpush('smtp:outbound:api', JSON.stringify({
    from: req.apiUser!.email || req.apiUser!.userId,
    to, cc, bcc, subject, bodyHtml, bodyText, inReplyTo,
    userId: req.apiUser!.userId,
  }));

  log.info({ userId: req.apiUser!.userId, to }, 'Message enqueued for sending');
  res.json({ ok: true });
});

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
