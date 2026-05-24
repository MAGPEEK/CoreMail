import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '@coremail/core';
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

// ─────────────────────────────────────────────────────────────────────────────
// Mail Rules (Outlook-Style Inbox Rules, v3.18.0)
// ─────────────────────────────────────────────────────────────────────────────

const RuleConditionSchema = z.object({
  field: z.enum([
    'from', 'to', 'cc', 'bcc', 'subject', 'body', 'recipient',
    'hasAttachment', 'size', 'importance', 'sentOnlyToMe',
  ]),
  operator: z.enum([
    'contains', 'notContains', 'equals', 'notEquals',
    'startsWith', 'endsWith', 'regex',
    'greaterThan', 'lessThan', 'is',
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const RuleActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('moveTo'),        folderId: z.string().min(1) }),
  z.object({ type: z.literal('copyTo'),        folderId: z.string().min(1) }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('hardDelete') }),
  z.object({ type: z.literal('markRead') }),
  z.object({ type: z.literal('markFlagged') }),
  z.object({ type: z.literal('pin') }),
  z.object({ type: z.literal('categorize'),    categoryId: z.string().min(1) }),
  z.object({ type: z.literal('forward'),       address: z.string().email() }),
  z.object({ type: z.literal('redirect'),      address: z.string().email() }),
  z.object({ type: z.literal('markJunk') }),
  z.object({ type: z.literal('setImportance'), value: z.enum(['high', 'normal', 'low']) }),
]);

const RuleSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  conditions: z.array(RuleConditionSchema).default([]),
  exceptions: z.array(RuleConditionSchema).default([]),
  actions:    z.array(RuleActionSchema).min(1, 'Mindestens eine Aktion erforderlich'),
  stopProcessing: z.boolean().default(false),
  matchAll: z.boolean().default(true),
});

// GET /api/v1/user/rules
userRouter.get('/rules', async (req: Request, res: Response) => {
  const rules = await prisma.mailRule.findMany({
    where: { userId: req.apiUser!.userId },
    orderBy: { priority: 'asc' },
  });
  res.json(rules);
});

// POST /api/v1/user/rules
userRouter.post('/rules', async (req: Request, res: Response) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  // Auto-Priority: an Ende einfügen wenn nicht explizit gesetzt
  let priority = parsed.data.priority;
  if (priority === 0) {
    const maxRule = await prisma.mailRule.findFirst({
      where: { userId: req.apiUser!.userId },
      orderBy: { priority: 'desc' },
      select: { priority: true },
    });
    priority = (maxRule?.priority ?? 0) + 1;
  }
  const rule = await prisma.mailRule.create({
    data: {
      userId: req.apiUser!.userId,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      priority,
      conditions: parsed.data.conditions,
      exceptions: parsed.data.exceptions,
      actions: parsed.data.actions,
      stopProcessing: parsed.data.stopProcessing,
      matchAll: parsed.data.matchAll,
    },
  });
  res.status(201).json(rule);
});

// PUT /api/v1/user/rules/:id
userRouter.put('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = RuleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }

  const updated = await prisma.mailRule.update({
    where: { id },
    data: parsed.data as Parameters<typeof prisma.mailRule.update>[0]['data'],
  });
  res.json(updated);
});

// PATCH /api/v1/user/rules/:id/toggle — schneller Enable/Disable
userRouter.patch('/rules/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  const updated = await prisma.mailRule.update({
    where: { id },
    data: { enabled: !rule.enabled },
  });
  res.json(updated);
});

// POST /api/v1/user/rules/reorder — body { ids: string[] } — neue Reihenfolge
userRouter.post('/rules/reorder', async (req: Request, res: Response) => {
  const schema = z.object({ ids: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verifizieren dass alle IDs dem User gehören
  const userRules = await prisma.mailRule.findMany({
    where: { userId: req.apiUser!.userId },
    select: { id: true },
  });
  const userRuleIds = new Set(userRules.map((r) => r.id));
  for (const id of parsed.data.ids) {
    if (!userRuleIds.has(id)) { res.status(403).json({ error: 'Rule not owned by user' }); return; }
  }

  await prisma.$transaction(
    parsed.data.ids.map((id, idx) =>
      prisma.mailRule.update({ where: { id }, data: { priority: idx + 1 } }),
    ),
  );
  res.json({ ok: true });
});

// POST /api/v1/user/rules/:id/run-now — body { folderIds?: string[], limit?: number }
userRouter.post('/rules/:id/run-now', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }

  const user = await prisma.user.findUnique({
    where: { id: req.apiUser!.userId },
    select: { email: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const optsSchema = z.object({
    folderIds: z.array(z.string()).optional(),
    limit:     z.number().int().min(1).max(5000).optional(),
  });
  const opts = optsSchema.safeParse(req.body ?? {});
  if (!opts.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  try {
    const { runRuleOnExisting } = await import('@coremail/storage');
    const passOpts: { folderIds?: string[]; limit?: number } = {};
    if (opts.data.folderIds) passOpts.folderIds = opts.data.folderIds;
    if (opts.data.limit !== undefined) passOpts.limit = opts.data.limit;
    const result = await runRuleOnExisting(id, req.apiUser!.userId, user.email, passOpts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Run-now failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /api/v1/user/rules/:id
userRouter.delete('/rules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  await prisma.mailRule.delete({ where: { id } });
  res.json({ ok: true });
});

// POST /api/v1/user/change-password
userRouter.post('/change-password', async (req: Request, res: Response) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword:     z.string().min(8, 'Mindestens 8 Zeichen'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Ungültige Eingabe';
    res.status(400).json({ error: msg });
    return;
  }

  const user = await prisma.user.findUnique({
    where:  { id: req.apiUser!.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user || !user.passwordHash) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

  // verifyPassword/hashPassword nutzen sha256(password + PEPPER) → bcrypt
  const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!valid) { res.status(400).json({ error: 'Aktuelles Passwort ist falsch' }); return; }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({
    where: { id: req.apiUser!.userId },
    data:  { passwordHash: newHash },
  });
  res.json({ ok: true });
});

// GET /api/v1/user/shared-mailboxes
// Listet alle freigegebenen Postfächer, auf die der User Zugriff hat.
// Aggregiert mehrere Berechtigungen pro Mailbox in ein `permissions[]`-Array.
userRouter.get('/shared-mailboxes', async (req: Request, res: Response) => {
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId: req.apiUser!.userId },
    include: { sharedMailbox: { select: { id: true, email: true, displayName: true, active: true } } },
  });
  // Aggregieren: ein Eintrag pro shared mailbox mit allen perms
  const map = new Map<string, { id: string; email: string; displayName: string; active: boolean; permissions: string[] }>();
  for (const p of perms) {
    if (!p.sharedMailbox.active) continue;
    const existing = map.get(p.sharedMailbox.id);
    if (existing) {
      existing.permissions.push(p.permission);
    } else {
      map.set(p.sharedMailbox.id, {
        id:          p.sharedMailbox.id,
        email:       p.sharedMailbox.email,
        displayName: p.sharedMailbox.displayName,
        active:      p.sharedMailbox.active,
        permissions: [p.permission],
      });
    }
  }
  res.json([...map.values()].sort((a, b) => a.email.localeCompare(b.email)));
});

// ── Helper: prüft Lese-Zugriff auf eine Shared-Mailbox + holt Mailbox-Record ──
async function getReadableSharedMailbox(userId: string, sharedMailboxId: string) {
  const perm = await prisma.sharedMailboxPerm.findFirst({
    where: {
      userId,
      sharedMailboxId,
      permission: { in: ['FULL_ACCESS', 'READ_ONLY'] },
    },
    include: {
      sharedMailbox: {
        select: { id: true, email: true, displayName: true, active: true },
      },
    },
  });
  if (!perm || !perm.sharedMailbox.active) return null;
  // Die Mailbox-Tabelle ist 1:1 mit SharedMailbox via sharedBoxId
  const mailbox = await prisma.mailbox.findFirst({
    where: { sharedBoxId: sharedMailboxId },
    select: { id: true },
  });
  if (!mailbox) return null;
  return { mailboxId: mailbox.id, shared: perm.sharedMailbox, permission: perm.permission };
}

// GET /api/v1/user/shared-mailboxes/:id — Detail (inkl. permissions[])
userRouter.get('/shared-mailboxes/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId: req.apiUser!.userId, sharedMailboxId: id },
    include: { sharedMailbox: { select: { id: true, email: true, displayName: true, active: true } } },
  });
  if (perms.length === 0 || !perms[0]!.sharedMailbox.active) {
    res.status(404).json({ error: 'Nicht gefunden oder kein Zugriff' });
    return;
  }
  const sm = perms[0]!.sharedMailbox;
  res.json({
    id: sm.id, email: sm.email, displayName: sm.displayName, active: sm.active,
    permissions: perms.map((p) => p.permission),
  });
});

// GET /api/v1/user/shared-mailboxes/:id/folders
userRouter.get('/shared-mailboxes/:id/folders', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const access = await getReadableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Kein Lese-Zugriff auf diese Mailbox' }); return; }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: access.mailboxId },
    select: {
      id: true, name: true, displayName: true, parentId: true,
      totalCount: true, unreadCount: true, isFavorite: true, sortOrder: true, color: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(folders);
});

// GET /api/v1/user/shared-mailboxes/:id/folders/:folderId/messages?limit&offset
userRouter.get('/shared-mailboxes/:id/folders/:folderId/messages', async (req: Request, res: Response) => {
  const { id, folderId } = req.params as { id: string; folderId: string };
  const q = req.query as Record<string, string>;
  const limit  = Math.min(parseInt(q['limit']  ?? '50', 10), 200);
  const offset = parseInt(q['offset'] ?? '0', 10);

  const access = await getReadableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Kein Lese-Zugriff auf diese Mailbox' }); return; }

  // Folder muss zur Shared-Mailbox gehören
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailboxId: access.mailboxId },
    select: { id: true },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return; }

  const [total, messages] = await Promise.all([
    prisma.message.count({ where: { folderId, deletedAt: null } }),
    prisma.message.findMany({
      where: { folderId, deletedAt: null },
      select: {
        id: true, subject: true, fromAddr: true, fromName: true,
        toAddrs: true, date: true, flags: true, rawSize: true,
        bodyText: true,
      },
      orderBy: { date: 'desc' },
      skip: offset, take: limit,
    }),
  ]);
  res.json({ total, messages });
});

// GET /api/v1/user/shared-mailboxes/:id/messages/:messageId — komplette Nachricht
userRouter.get('/shared-mailboxes/:id/messages/:messageId', async (req: Request, res: Response) => {
  const { id, messageId } = req.params as { id: string; messageId: string };
  const access = await getReadableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Kein Lese-Zugriff auf diese Mailbox' }); return; }

  const message = await prisma.message.findFirst({
    where: { id: messageId, folder: { mailboxId: access.mailboxId }, deletedAt: null },
    include: {
      folder:      { select: { id: true, name: true, displayName: true } },
      attachments: { select: { id: true, filename: true, mimeType: true, size: true } },
    },
  });
  if (!message) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
  res.json(message);
});

// ── Folder-CRUD für Shared Mailboxes (nur mit FULL_ACCESS) ───────────────────

/** Wie getReadableSharedMailbox, aber erfordert FULL_ACCESS für Schreiboperationen. */
async function getWritableSharedMailbox(userId: string, sharedMailboxId: string) {
  const perm = await prisma.sharedMailboxPerm.findFirst({
    where: { userId, sharedMailboxId, permission: 'FULL_ACCESS' },
    include: { sharedMailbox: { select: { id: true, active: true } } },
  });
  if (!perm || !perm.sharedMailbox.active) return null;
  const mailbox = await prisma.mailbox.findFirst({
    where: { sharedBoxId: sharedMailboxId }, select: { id: true },
  });
  if (!mailbox) return null;
  return { mailboxId: mailbox.id };
}

// Geschützte System-Ordner, die nicht umbenannt/gelöscht werden dürfen
const PROTECTED_FOLDER_NAMES = new Set(['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Outbox']);

// POST /api/v1/user/shared-mailboxes/:id/folders — Ordner anlegen
userRouter.post('/shared-mailboxes/:id/folders', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const { displayName, parentId, color } = req.body as { displayName?: string; parentId?: string; color?: string };
  if (!displayName || displayName.trim().length === 0) {
    res.status(400).json({ error: 'displayName erforderlich' }); return;
  }
  // `name` ist der interne IMAP-Name — wir nutzen den displayName und ersetzen problematische Zeichen
  const safeName = displayName.trim().replace(/[/\\\0]/g, '_').slice(0, 100);

  // Parent muss zur gleichen Mailbox gehören
  if (parentId) {
    const parent = await prisma.folder.findFirst({
      where: { id: parentId, mailboxId: access.mailboxId },
      select: { id: true },
    });
    if (!parent) { res.status(400).json({ error: 'Übergeordneter Ordner gehört nicht zu dieser Mailbox' }); return; }
  }

  try {
    const folder = await prisma.folder.create({
      data: {
        mailboxId: access.mailboxId,
        name: safeName,
        displayName: displayName.trim(),
        ...(parentId ? { parentId } : {}),
        ...(color ? { color } : {}),
      },
      select: {
        id: true, name: true, displayName: true, parentId: true,
        totalCount: true, unreadCount: true, isFavorite: true, sortOrder: true, color: true,
      },
    });
    res.status(201).json(folder);
  } catch (err) {
    if (String(err).includes('Unique constraint')) {
      res.status(409).json({ error: 'Ordner mit diesem Namen existiert bereits' });
      return;
    }
    throw err;
  }
});

// PATCH /api/v1/user/shared-mailboxes/:id/folders/:folderId — Umbenennen/Verschieben/Farbe
userRouter.patch('/shared-mailboxes/:id/folders/:folderId', async (req: Request, res: Response) => {
  const { id, folderId } = req.params as { id: string; folderId: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailboxId: access.mailboxId },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return; }

  const { displayName, parentId, color, isFavorite, sortOrder } = req.body as {
    displayName?: string; parentId?: string | null; color?: string | null;
    isFavorite?: boolean; sortOrder?: number;
  };

  // System-Ordner darf nicht umbenannt oder reparented werden
  if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
    if (displayName !== undefined || parentId !== undefined) {
      res.status(403).json({ error: `Standard-Ordner „${folder.name}" kann nicht umbenannt oder verschoben werden` });
      return;
    }
  }

  // Cycle-Check: parentId darf nicht in eigener Unterbaum sein
  if (parentId) {
    if (parentId === folderId) { res.status(400).json({ error: 'Ordner kann sich nicht selbst sein' }); return; }
    let cursor: string | null = parentId;
    const visited = new Set<string>([folderId]);
    while (cursor) {
      if (visited.has(cursor)) { res.status(400).json({ error: 'Cycle in Ordner-Hierarchie' }); return; }
      visited.add(cursor);
      const next: { parentId: string | null; mailboxId: string } | null = await prisma.folder.findUnique({
        where: { id: cursor }, select: { parentId: true, mailboxId: true },
      });
      if (!next) break;
      if (next.mailboxId !== access.mailboxId) {
        res.status(400).json({ error: 'Übergeordneter Ordner gehört nicht zu dieser Mailbox' });
        return;
      }
      cursor = next.parentId;
    }
  }

  const updated = await prisma.folder.update({
    where: { id: folderId },
    data: {
      ...(displayName !== undefined ? { displayName, name: displayName.trim().replace(/[/\\\0]/g, '_').slice(0, 100) } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(isFavorite !== undefined ? { isFavorite } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
    select: {
      id: true, name: true, displayName: true, parentId: true,
      totalCount: true, unreadCount: true, isFavorite: true, sortOrder: true, color: true,
    },
  });
  res.json(updated);
});

// DELETE /api/v1/user/shared-mailboxes/:id/folders/:folderId
userRouter.delete('/shared-mailboxes/:id/folders/:folderId', async (req: Request, res: Response) => {
  const { id, folderId } = req.params as { id: string; folderId: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailboxId: access.mailboxId },
    include: { _count: { select: { children: true } } },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return; }
  if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
    res.status(403).json({ error: `Standard-Ordner „${folder.name}" kann nicht gelöscht werden` });
    return;
  }
  if (folder._count.children > 0) {
    res.status(409).json({ error: 'Ordner hat Unter-Ordner — bitte erst diese entfernen' });
    return;
  }

  await prisma.folder.delete({ where: { id: folderId } });
  res.status(204).end();
});

// POST /api/v1/user/shared-mailboxes/:id/folders/:folderId/empty — alle Nachrichten löschen
userRouter.post('/shared-mailboxes/:id/folders/:folderId/empty', async (req: Request, res: Response) => {
  const { id, folderId } = req.params as { id: string; folderId: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailboxId: access.mailboxId }, select: { id: true },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return; }

  const result = await prisma.message.deleteMany({ where: { folderId } });
  res.json({ deleted: result.count });
});

// ── GET /api/v1/user/preferences ─────────────────────────────────────────────
// Persönliche Benutzereinstellungen (inkl. inactivityTimeoutMinutes)
userRouter.get('/preferences', async (req: Request, res: Response) => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId: req.apiUser!.userId },
    select: { inactivityTimeoutMinutes: true },
  });
  // Global-Fallback aus ServerSettings
  const global = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { inactivityTimeoutMinutes: true },
  });
  res.json({
    inactivityTimeoutMinutes:       settings?.inactivityTimeoutMinutes ?? null,
    inactivityTimeoutMinutesGlobal: global?.inactivityTimeoutMinutes ?? 30,
  });
});

// ── PUT /api/v1/user/preferences ─────────────────────────────────────────────
userRouter.put('/preferences', async (req: Request, res: Response) => {
  const PreferencesSchema = z.object({
    // null = globale Einstellung verwenden; 0 = deaktiviert; 1-1440 = eigene Vorgabe
    inactivityTimeoutMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  });
  const parsed = PreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }

  const data: { inactivityTimeoutMinutes?: number | null } = {};
  if ('inactivityTimeoutMinutes' in parsed.data) {
    data.inactivityTimeoutMinutes = parsed.data.inactivityTimeoutMinutes ?? null;
  }

  await prisma.userSettings.upsert({
    where: { userId: req.apiUser!.userId },
    create: { userId: req.apiUser!.userId, ...data },
    update: data,
  });

  res.json({ ok: true });
});
