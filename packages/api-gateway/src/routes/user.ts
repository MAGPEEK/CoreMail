import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const userRouter: RouterType = Router();
userRouter.use(requireAuth);

// GET /api/v1/user/profile
userRouter.get('/profile', async (req: Request, res: Response) => {
  
  const user = await prisma.user.findUnique({
    where: { id: req.apiUser!.userId },
    select: { id: true, email: true, displayName: true, role: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(user);
});

// PUT /api/v1/user/profile
userRouter.put('/profile', async (req: Request, res: Response) => {
  const schema = z.object({ displayName: z.string().min(1).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const updated = await prisma.user.update({
    where: { id: req.apiUser!.userId },
    data: {
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
    },
    select: { id: true, email: true, displayName: true, role: true },
  });
  res.json(updated);
});

// GET /api/v1/user/signature
userRouter.get('/signature', async (req: Request, res: Response) => {
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.apiUser!.userId } });
  res.json({
    signature: settings?.signature ?? '',
    autoNew:   settings?.signatureAutoNew  ?? true,
    autoReply: settings?.signatureAutoReply ?? false,
  });
});

// PUT /api/v1/user/signature
userRouter.put('/signature', async (req: Request, res: Response) => {
  const schema = z.object({
    signature: z.string(),
    autoNew:   z.boolean().optional(),
    autoReply: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  await prisma.userSettings.upsert({
    where:  { userId: req.apiUser!.userId },
    update: {
      signature:          parsed.data.signature,
      ...(parsed.data.autoNew   !== undefined ? { signatureAutoNew:   parsed.data.autoNew   } : {}),
      ...(parsed.data.autoReply !== undefined ? { signatureAutoReply: parsed.data.autoReply } : {}),
    },
    create: {
      userId:             req.apiUser!.userId,
      signature:          parsed.data.signature,
      signatureAutoNew:   parsed.data.autoNew   ?? true,
      signatureAutoReply: parsed.data.autoReply ?? false,
    },
  });
  res.json({ ok: true });
});

// GET /api/v1/user/oof — Out Of Office
userRouter.get('/oof', async (req: Request, res: Response) => {
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.apiUser!.userId } });
  res.json({
    enabled:              settings?.oofEnabled              ?? false,
    internalMessage:      settings?.oofInternal             ?? '',
    externalMessage:      settings?.oofExternal             ?? '',
    externalEnabled:      settings?.oofExternalEnabled      ?? true,
    externalOnlyContacts: settings?.oofExternalOnlyContacts ?? false,
    useTimeRange:         settings?.oofUseTimeRange         ?? false,
    startDate:            settings?.oofStart                ?? null,
    endDate:              settings?.oofEnd                  ?? null,
  });
});

// PUT /api/v1/user/oof
userRouter.put('/oof', async (req: Request, res: Response) => {
  const schema = z.object({
    enabled:              z.boolean(),
    internalMessage:      z.string().optional().default(''),
    externalMessage:      z.string().optional().default(''),
    externalEnabled:      z.boolean().optional().default(true),
    externalOnlyContacts: z.boolean().optional().default(false),
    useTimeRange:         z.boolean().optional().default(false),
    startDate:            z.string().optional(),
    endDate:              z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const d = parsed.data;
  const oofStart = d.startDate ? new Date(d.startDate) : null;
  const oofEnd   = d.endDate   ? new Date(d.endDate)   : null;

  await prisma.userSettings.upsert({
    where:  { userId: req.apiUser!.userId },
    update: {
      oofEnabled:              d.enabled,
      oofInternal:             d.internalMessage,
      oofExternal:             d.externalMessage,
      oofExternalEnabled:      d.externalEnabled,
      oofExternalOnlyContacts: d.externalOnlyContacts,
      oofUseTimeRange:         d.useTimeRange,
      oofStart,
      oofEnd,
    },
    create: {
      userId:                  req.apiUser!.userId,
      oofEnabled:              d.enabled,
      oofInternal:             d.internalMessage,
      oofExternal:             d.externalMessage,
      oofExternalEnabled:      d.externalEnabled,
      oofExternalOnlyContacts: d.externalOnlyContacts,
      oofUseTimeRange:         d.useTimeRange,
      oofStart,
      oofEnd,
    },
  });

  // Kalender-Event für Abwesenheit anlegen/aktualisieren wenn Zeitraum gesetzt
  if (d.enabled && d.useTimeRange && oofStart && oofEnd) {
    const mailbox = await prisma.mailbox.findUnique({ where: { userId: req.apiUser!.userId } });
    if (mailbox) {
      const calendar = await prisma.calendar.findFirst({ where: { userId: req.apiUser!.userId } });
      if (calendar) {
        const uid = `oof-${req.apiUser!.userId}`;
        const ical = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTART:${oofStart.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
          `DTEND:${oofEnd.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
          'SUMMARY:Abwesenheit',
          'TRANSP:TRANSPARENT',
          'CLASS:PUBLIC',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n');

        const existing = await prisma.calendarEvent.findFirst({ where: { calendarId: calendar.id, uid } });
        if (existing) {
          await prisma.calendarEvent.update({
            where: { id: existing.id },
            data: { icalData: ical, summary: 'Abwesenheit', dtStart: oofStart, dtEnd: oofEnd },
          });
        } else {
          await prisma.calendarEvent.create({
            data: { calendarId: calendar.id, uid, icalData: ical, summary: 'Abwesenheit', dtStart: oofStart, dtEnd: oofEnd },
          });
        }
      }
    }
  }

  res.json({ ok: true });
});

// GET /api/v1/user/storage — Speichernutzung pro Ordner
userRouter.get('/storage', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { quotaBytes: true } });
  const mailbox = await prisma.mailbox.findUnique({ where: { userId }, include: { folders: { select: { id: true, name: true, displayName: true } } } });

  if (!mailbox) { res.json({ quotaBytes: user?.quotaBytes ?? 0, usedBytes: 0, folders: [] }); return; }

  // Größe pro Ordner aggregieren
  const sizes = await prisma.message.groupBy({
    by: ['folderId'],
    where: { folder: { mailboxId: mailbox.id }, deletedAt: null },
    _sum: { rawSize: true },
    _count: { id: true },
  });

  const sizeMap = new Map(sizes.map(s => [s.folderId, { size: s._sum.rawSize ?? 0, count: s._count.id }]));
  const totalUsed = sizes.reduce((acc, s) => acc + (s._sum.rawSize ?? 0), 0);

  const folders = mailbox.folders.map(f => ({
    id:           f.id,
    name:         f.name,
    displayName:  f.displayName,
    sizeBytes:    sizeMap.get(f.id)?.size  ?? 0,
    messageCount: sizeMap.get(f.id)?.count ?? 0,
  })).filter(f => f.messageCount > 0).sort((a, b) => b.sizeBytes - a.sizeBytes);

  res.json({ quotaBytes: user?.quotaBytes ?? 0, usedBytes: totalUsed, folders });
});

// DELETE /api/v1/user/folders/:id/empty — Ordner leeren (Soft-Delete aller Nachrichten)
userRouter.delete('/folders/:id/empty', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId  = req.apiUser!.userId;

  const mailbox = await prisma.mailbox.findUnique({ where: { userId } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  const folder = await prisma.folder.findFirst({ where: { id, mailboxId: mailbox.id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const now = new Date();
  await prisma.message.updateMany({ where: { folderId: id, deletedAt: null }, data: { deletedAt: now } });
  await prisma.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });

  res.json({ ok: true });
});

// GET /api/v1/user/rules — mail rules
userRouter.get('/rules', async (req: Request, res: Response) => {
  
  const rules = await prisma.mailRule.findMany({
    where: { userId: req.apiUser!.userId },
    orderBy: { priority: 'asc' },
  });
  res.json(rules);
});

const RuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  conditions: z.array(z.object({
    field: z.enum(['from', 'to', 'subject', 'body', 'hasAttachment', 'size']),
    operator: z.enum(['contains', 'equals', 'startsWith', 'endsWith', 'greaterThan', 'lessThan', 'is']),
    value: z.string(),
  })),
  actions: z.array(z.object({
    type: z.enum(['move', 'copy', 'delete', 'markRead', 'markFlagged', 'forward', 'reject']),
    value: z.string().optional(),
  })),
});

// POST /api/v1/user/rules
userRouter.post('/rules', async (req: Request, res: Response) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  
  const rule = await prisma.mailRule.create({
    data: {
      userId: req.apiUser!.userId,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      conditions: parsed.data.conditions,
      actions: parsed.data.actions,
    },
  });
  res.status(201).json(rule);
});

// PUT /api/v1/user/rules/:id
userRouter.put('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = RuleSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.mailRule.update({ where: { id }, data: parsed.data as any });
  res.json(updated);
});

// DELETE /api/v1/user/rules/:id
userRouter.delete('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  await prisma.mailRule.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /api/v1/user/shared-mailboxes
userRouter.get('/shared-mailboxes', async (req: Request, res: Response) => {
  
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId: req.apiUser!.userId },
    include: { sharedMailbox: { select: { id: true, email: true, displayName: true } } },
  });
  res.json(perms.map((p: { sharedMailbox: { id: string; email: string; displayName: string }; permission: string }) => ({ ...p.sharedMailbox, permission: p.permission })));
});
