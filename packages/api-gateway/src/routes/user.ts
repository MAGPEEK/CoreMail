import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { patchSchema } from '../lib/zod-compat.js';
import { hashPassword, verifyPassword } from '@coremail/core';
import {
  prisma, expunge, countRegexConditions, MAX_REGEX_CONDITIONS_PER_USER, saveOofSettings, getQuotaStatus, hasMfa,
  reservedFolderPrefix, reservedFolderNameError, effectiveProtocolAccess,
} from '@coremail/storage';
import { invalidRegexConditionMessage } from '../lib/rule-validation.js';
import { checkPasswordPolicy, revokeAllSessions } from '@coremail/storage/auth';
import { protocolSubject, requireAuth } from '../middleware/auth.js';
import { allowedAreas, isAdminRole } from '../lib/rbac.js';
import { getReadableSharedMailbox, getWritableSharedMailbox, listForeignMailboxes, foreignMailboxRef } from '../lib/mailbox-access.js';
import { deleteFolderKeepingMail } from '../lib/folder-delete.js';
import { auditForeignWrite, type ForeignAuditAction } from '../lib/foreign-audit.js';

export const userRouter: RouterType = Router();
userRouter.use(requireAuth);

// GET /api/v1/user/client-config
// v3.18.40: returns ALL setup data for external mail/calendar/contacts
// clients (Outlook + CalDAV plugin, Apple Calendar, Thunderbird, eM Client).
// Outlook desktop has no native CalDAV/CardDAV support → calendar + contacts
// require the (free, OSS) „Outlook CalDav Synchronizer" plugin.
// 9.4: only protocols switched on for the account — `protocols` lists them,
// the setup data of a protocol that is off is null.
userRouter.get('/client-config', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const access = await effectiveProtocolAccess(protocolSubject(req.apiUser!));
  const [settings, user, calendars, mfa] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        publicHostname: true, useHttps: true, httpPort: true,
        imapHost: true, imapPort: true, imapSsl: true,
        pop3Host: true, pop3Port: true, pop3Ssl: true,
        smtpHost: true, smtpPort: true, smtpTls: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    }),
    access.dav ? prisma.calendar.findMany({
      where: { userId },
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    }) : Promise.resolve([]),
    prisma.userMfa.findUnique({
      where: { userId },
      select: { totpEnabled: true, webAuthnCredentials: true },
    }).catch(() => null),
  ]);

  const hostname = settings?.publicHostname ?? req.get('host') ?? 'mail.local';
  const proto = settings?.useHttps === false ? 'http' : 'https';
  const port = settings?.httpPort ?? 443;
  const isStandardPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  const portSuffix = isStandardPort ? '' : `:${port}`;
  const baseUrl = `${proto}://${hostname}${portSuffix}`;

  // MFA active → CalDAV/CardDAV/IMAP/SMTP clients need an app password
  // (bearer token does not work in the clients, the normal password is
  // blocked by MFA).
  // 8.1: webAuthnCredentials is a Json array — same rule as the mail login (hasMfa)
  const mfaEnabled = hasMfa({ mfa });

  res.json({
    user: {
      email: user?.email ?? '',
      displayName: user?.displayName ?? '',
    },
    requiresAppPassword: mfaEnabled,
    protocols: {
      imap: access.imap, pop3: access.pop3, smtp: access.smtp, activesync: access.activesync, dav: access.dav,
    },
    mail: {
      imap: access.imap ? {
        host: settings?.imapHost ?? hostname,
        port: settings?.imapPort ?? 993,
        ssl:  settings?.imapSsl ?? true,
      } : null,
      pop3: access.pop3 ? {
        host: settings?.pop3Host ?? hostname,
        port: settings?.pop3Port ?? 995,
        ssl:  settings?.pop3Ssl ?? true,
      } : null,
      smtp: access.smtp ? {
        host: settings?.smtpHost ?? hostname,
        port: settings?.smtpPort ?? 587,
        tls:  settings?.smtpTls ?? true,
      } : null,
    },
    caldav: access.dav ? {
      accountUrl: `${baseUrl}/dav/calendars/${userId}/`,
      calendars: calendars.map((c) => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
        url: `${baseUrl}/dav/calendars/${userId}/${c.id}/`,
      })),
    } : null,
    carddav: access.dav ? {
      // Account URL for client auto-discovery (Apple Contacts, Thunderbird,
      // Outlook CalDav Synchronizer). CoreMail currently has ONE default
      // address book per user under the path „/default/".
      accountUrl: `${baseUrl}/dav/addressbooks/${userId}/`,
      defaultUrl: `${baseUrl}/dav/addressbooks/${userId}/default/`,
    } : null,
  });
});

// GET /api/v1/user/profile
userRouter.get('/profile', async (req: Request, res: Response) => {
  
  const user = await prisma.user.findUnique({
    where: { id: req.apiUser!.userId },
    select: { id: true, email: true, displayName: true, role: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ ...user, isAdmin: isAdminRole(user.role), adminAreas: allowedAreas(user.role) });
});

// GET /api/v1/user/me — v6: caller identity + admin RBAC areas (no DB hit).
// `adminAreas` maps each reachable admin area to 'write' | 'read'
// (see lib/rbac.ts AREA_MATRIX); the BCP hides pages for missing areas.
// Note: based on the role in the access token — a role change applies after
// the next token refresh.
userRouter.get('/me', (req: Request, res: Response) => {
  const u = req.apiUser!;
  res.json({
    userId: u.userId,
    email: u.email,
    role: u.role,
    isAdmin: isAdminRole(u.role),
    adminAreas: allowedAreas(u.role),
  });
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
  if ((oofStart && isNaN(oofStart.getTime())) || (oofEnd && isNaN(oofEnd.getTime()))) {
    res.status(400).json({ error: 'Invalid date' }); return;
  }
  if (d.useTimeRange && oofStart && oofEnd && oofEnd.getTime() <= oofStart.getTime()) {
    res.status(400).json({ error: 'End must be after start' }); return;
  }

  // v8.1: one writer for MWA/JMAP/EAS — maintains the OOF period id
  // (one auto-reply per sender per period).
  await saveOofSettings(req.apiUser!.userId, {
    oofEnabled:              d.enabled,
    oofInternal:             d.internalMessage,
    oofExternal:             d.externalMessage,
    oofExternalEnabled:      d.externalEnabled,
    oofExternalOnlyContacts: d.externalOnlyContacts,
    oofUseTimeRange:         d.useTimeRange,
    oofStart,
    oofEnd,
  });

  // Create/update the out-of-office calendar event when a period is set
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

// GET /api/v1/user/storage — storage usage per folder
userRouter.get('/storage', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { quotaBytes: true } });
  const mailbox = await prisma.mailbox.findUnique({ where: { userId }, include: { folders: { select: { id: true, name: true, displayName: true } } } });

  if (!mailbox) { res.json({ quotaBytes: user?.quotaBytes ?? 0, usedBytes: 0, folders: [] }); return; }

  // Aggregate size per folder
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

  const status = await getQuotaStatus({ kind: 'user', id: userId }).catch(() => null);
  res.json({
    quotaBytes: user?.quotaBytes ?? 0, usedBytes: totalUsed, folders,
    ...(status ? { limits: status.limits, level: status.level } : {}),
  });
});

// GET /api/v1/user/quota — v8.1: mailbox usage + Exchange-style quota levels
// (cached usage, cheap enough for the sidebar). level: ok | warning |
// prohibitSend | prohibitSendReceive; limits in bytes, 0 = unlimited.
userRouter.get('/quota', async (req: Request, res: Response) => {
  const status = await getQuotaStatus({ kind: 'user', id: req.apiUser!.userId });
  if (!status) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ usedBytes: status.usedBytes, level: status.level, ...status.limits });
});

// DELETE /api/v1/user/folders/:id/empty — empty folder (soft-delete all messages)
userRouter.delete('/folders/:id/empty', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId  = req.apiUser!.userId;

  const mailbox = await prisma.mailbox.findUnique({ where: { userId } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  const folder = await prisma.folder.findFirst({ where: { id, mailboxId: mailbox.id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const live = await prisma.message.findMany({ where: { folderId: id, deletedAt: null }, select: { id: true } });
  if (live.length > 0) {
    const mailboxId = mailbox.id;
    await prisma.$transaction((tx) => expunge(tx, live.map((m) => m.id), { mailboxId }));
  }
  await prisma.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mail Rules (Outlook-style inbox rules, v3.18.0)
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

/**
 * Returns a 400 message when a `regex` condition/exception carries a pattern the
 * linear-time rule matcher refuses (ReDoS-safe subset, see storage rule-pattern.ts),
 * otherwise null.
 */
export function invalidRulePatternMessage(
  lists: Array<Array<{ operator: string; value: unknown }> | undefined>,
): string | null {
  for (const list of lists) {
    const msg = invalidRegexConditionMessage(list);
    if (msg) return msg;
  }
  return null;
}

/**
 * v8.1: at most MAX_REGEX_CONDITIONS_PER_USER `regex` conditions/exceptions
 * over all of a user's rules (each one runs on every delivered message).
 * Returns a 400 message when saving `next` (replacing `replacingId`) would
 * exceed it, otherwise null.
 */
export function regexConditionLimitMessage(
  existing: ReadonlyArray<{ id: string; conditions: unknown; exceptions: unknown }>,
  next: ReadonlyArray<ReadonlyArray<unknown> | undefined>,
  replacingId?: string,
): string | null {
  const others = existing.filter((r) => r.id !== replacingId);
  const total = countRegexConditions(others.flatMap((r) => [r.conditions as unknown[], r.exceptions as unknown[]]))
    + countRegexConditions(next);
  return total > MAX_REGEX_CONDITIONS_PER_USER
    ? `Too many regular-expression conditions: at most ${MAX_REGEX_CONDITIONS_PER_USER} per user (all rules together)`
    : null;
}

async function regexLimitError(
  userId: string,
  next: ReadonlyArray<ReadonlyArray<unknown> | undefined>,
  replacingId?: string,
): Promise<string | null> {
  if (countRegexConditions(next) === 0) return null;
  const existing = await prisma.mailRule.findMany({
    where: { userId },
    select: { id: true, conditions: true, exceptions: true },
  });
  return regexConditionLimitMessage(existing, next, replacingId);
}

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
  const patternError = invalidRulePatternMessage([parsed.data.conditions, parsed.data.exceptions]);
  if (patternError) { res.status(400).json({ error: patternError, code: 'INVALID_RULE_PATTERN' }); return; }
  const limitError = await regexLimitError(req.apiUser!.userId, [parsed.data.conditions, parsed.data.exceptions]);
  if (limitError) { res.status(400).json({ error: limitError, code: 'TOO_MANY_REGEX_CONDITIONS' }); return; }
  // Auto priority: append at the end if not set explicitly
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
  const parsed = patchSchema(RuleSchema).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const patternError = invalidRulePatternMessage([parsed.data.conditions, parsed.data.exceptions]);
  if (patternError) { res.status(400).json({ error: patternError, code: 'INVALID_RULE_PATTERN' }); return; }
  const rule = await prisma.mailRule.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  const limitError = await regexLimitError(req.apiUser!.userId, [
    parsed.data.conditions ?? (rule.conditions as unknown[]),
    parsed.data.exceptions ?? (rule.exceptions as unknown[]),
  ], id);
  if (limitError) { res.status(400).json({ error: limitError, code: 'TOO_MANY_REGEX_CONDITIONS' }); return; }

  const updated = await prisma.mailRule.update({
    where: { id },
    data: parsed.data as Parameters<typeof prisma.mailRule.update>[0]['data'],
  });
  res.json(updated);
});

// PATCH /api/v1/user/rules/:id/toggle — quick enable/disable
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

// POST /api/v1/user/rules/reorder — body { ids: string[] } — new order
userRouter.post('/rules/reorder', async (req: Request, res: Response) => {
  const schema = z.object({ ids: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verify that all IDs belong to the user
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
    newPassword:     z.string().min(1).max(128),
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

  // verifyPassword/hashPassword use sha256(password + PEPPER) → bcrypt
  const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!valid) { res.status(400).json({ error: 'Aktuelles Passwort ist falsch' }); return; }

  // v7.0.0: minimum length from ServerSettings.minPasswordLength
  const policyError = await checkPasswordPolicy(parsed.data.newPassword);
  if (policyError) { res.status(400).json({ error: policyError }); return; }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({
    where: { id: req.apiUser!.userId },
    data:  { passwordHash: newHash },
  });
  // v7.0.0: all OTHER sessions are revoked; this session and app passwords stay.
  await revokeAllSessions(req.apiUser!.userId, {
    ...(req.apiUser!.sessionId ? { exceptSessionId: req.apiUser!.sessionId } : {}),
    reason: 'password-change',
  });
  res.json({ ok: true });
});

// GET /api/v1/user/shared-mailboxes
// Lists all shared mailboxes the user has access to.
// Aggregates multiple permissions per mailbox into a `permissions[]` array.
userRouter.get('/shared-mailboxes', async (req: Request, res: Response) => {
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId: req.apiUser!.userId },
    include: { sharedMailbox: { select: { id: true, email: true, displayName: true, active: true } } },
  });
  // Aggregate: one entry per shared mailbox with all perms
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

// Read/full-access checks: lib/mailbox-access.ts (shared with recover deleted items + quota)

// GET /api/v1/user/shared-mailboxes/:id — detail (incl. permissions[])
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

// GET /api/v1/user/shared-mailboxes/:id/quota — 9.1: quota of a shared mailbox
// (same shape as GET /user/quota). Read access (FULL_ACCESS or READ_ONLY) required.
userRouter.get('/shared-mailboxes/:id/quota', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const access = await getReadableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Kein Lese-Zugriff auf diese Mailbox' }); return; }
  const status = await getQuotaStatus({ kind: 'shared', id: access.shared.id });
  if (!status) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  res.json({ usedBytes: status.usedBytes, level: status.level, ...status.limits });
});

// ── 9.3: shared / delegated mailboxes in the webmail folder pane ─────────────
// GET   /api/v1/user/accessible-mailboxes          every mailbox the user may read
//       (listAccessibleMailboxes — FULL_ACCESS / READ_ONLY), with its permissions and
//       whether the user hid it from the folder pane
// PATCH /api/v1/user/accessible-mailboxes/:ref  {hidden}   ref = shared:<id> | delegated:<mailboxId>
// Hiding is a display preference only (UserSettings.hiddenSharedMailboxes); it never
// changes access. Entries of mailboxes the user lost access to are pruned on write.
const MAILBOX_REF_RE = /^(shared|delegated):[A-Za-z0-9_-]{1,64}$/;
const MAX_HIDDEN_MAILBOXES = 500;

async function accessibleMailboxView(userId: string) {
  const [list, settings] = await Promise.all([
    listForeignMailboxes(userId),
    prisma.userSettings.findUnique({ where: { userId }, select: { hiddenSharedMailboxes: true } }),
  ]);
  const sharedIds = list.filter((a) => a.kind === 'shared' && a.sharedMailboxId).map((a) => a.sharedMailboxId as string);
  // Shared mailboxes: every permission row (FULL_ACCESS/READ_ONLY + SEND_AS/SEND_ON_BEHALF)
  const perms = sharedIds.length
    ? await prisma.sharedMailboxPerm.findMany({
      where: { userId, sharedMailboxId: { in: sharedIds } },
      select: { sharedMailboxId: true, permission: true },
    })
    : [];
  const hidden = new Set(settings?.hiddenSharedMailboxes ?? []);
  return list.map((a) => {
    const ref = foreignMailboxRef(a);
    const permissions = a.kind === 'shared'
      ? [...new Set(perms.filter((p) => p.sharedMailboxId === a.sharedMailboxId).map((p) => String(p.permission)))].sort()
      : [a.readOnly ? 'READ_ONLY' : 'FULL_ACCESS'];
    return {
      ref,
      kind: a.kind,
      id: a.kind === 'shared' ? (a.sharedMailboxId ?? '') : a.mailboxId,
      email: a.email,
      displayName: a.displayName,
      readOnly: a.readOnly,
      permissions,
      hidden: hidden.has(ref),
    };
  });
}

userRouter.get('/accessible-mailboxes', async (req: Request, res: Response) => {
  res.json(await accessibleMailboxView(req.apiUser!.userId));
});

userRouter.patch('/accessible-mailboxes/:ref', async (req: Request, res: Response) => {
  const ref = String((req.params as { ref?: string }).ref ?? '');
  const body = z.object({ hidden: z.boolean() }).safeParse(req.body ?? {});
  if (!MAILBOX_REF_RE.test(ref) || !body.success) { res.status(400).json({ error: 'Ungültige Eingabe' }); return; }
  const userId = req.apiUser!.userId;
  const view = await accessibleMailboxView(userId);
  const entry = view.find((v) => v.ref === ref);
  // Hiding needs access (no oracle beyond the user's own list); un-hiding always works.
  if (!entry && body.data.hidden) { res.status(404).json({ error: 'Postfach nicht gefunden' }); return; }

  // view.hidden only covers accessible mailboxes → stale entries are pruned here
  const current = view.filter((v) => v.hidden).map((v) => v.ref);
  const hiddenSharedMailboxes = (body.data.hidden
    ? [...new Set([...current, ref])]
    : current.filter((r) => r !== ref)).slice(0, MAX_HIDDEN_MAILBOXES);
  await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, hiddenSharedMailboxes },
    update: { hiddenSharedMailboxes },
  });
  res.json(entry ? { ...entry, hidden: body.data.hidden } : { ref, hidden: false });
});

// ── Pre-9.3 shared-mailbox content API (compat) ───────────────────────────────
// /api/v1/user/shared-mailboxes/:id/{folders,messages} keep their 9.2 request /
// response shapes and status codes (SemVer: no breaking change in a MINOR release).
// The 9.3 webmail uses /api/v1/mail/shared-mailboxes/:id/… (routes/foreign-mailbox.ts).
// Deviations from 9.2, both safety fixes: DELETE of a non-empty folder moves its
// messages to Trash instead of removing them (409 when there is no Trash), and writes
// are audited (mailbox.foreign.*).

/** Audit a write through the compat routes (targetType sharedMailbox). */
function auditCompat(req: Request, sharedMailboxId: string, mailboxId: string, action: ForeignAuditAction, changes: Record<string, unknown>): void {
  auditForeignWrite(req, { kind: 'shared', id: sharedMailboxId, mailboxId }, action, changes);
}

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

  // Folder must belong to the shared mailbox
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

// GET /api/v1/user/shared-mailboxes/:id/messages/:messageId — full message
userRouter.get('/shared-mailboxes/:id/messages/:messageId', async (req: Request, res: Response) => {
  const { id, messageId } = req.params as { id: string; messageId: string };
  const access = await getReadableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Kein Lese-Zugriff auf diese Mailbox' }); return; }

  const message = await prisma.message.findFirst({
    where: { id: messageId, folder: { mailboxId: access.mailboxId }, deletedAt: null },
    include: {
      folder:      { select: { id: true, name: true, displayName: true } },
      // contentId + inline: the shared reader resolves cid: images like the own reader
      attachments: { select: { id: true, filename: true, mimeType: true, size: true, contentId: true, inline: true } },
    },
  });
  if (!message) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
  res.json(message);
});

// ── Folder CRUD for shared mailboxes (FULL_ACCESS only) ──────────────────────

// Protected system folders that must not be renamed/deleted
const PROTECTED_FOLDER_NAMES = new Set(['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Outbox']);

// POST /api/v1/user/shared-mailboxes/:id/folders — create folder
userRouter.post('/shared-mailboxes/:id/folders', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const { displayName, parentId, color } = req.body as { displayName?: string; parentId?: string; color?: string };
  if (!displayName || displayName.trim().length === 0) {
    res.status(400).json({ error: 'displayName erforderlich' }); return;
  }
  // 9.1: no names under an IMAP namespace prefix ("Shared/", "Other Users/").
  const reserved = reservedFolderPrefix(displayName);
  if (reserved) { res.status(400).json({ error: reservedFolderNameError(reserved), code: 'RESERVED_FOLDER_NAME' }); return; }
  // `name` is the internal IMAP name — we use the displayName and replace problematic characters
  const safeName = displayName.trim().replace(/[/\\\0]/g, '_').slice(0, 100);

  // Parent must belong to the same mailbox
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
    auditCompat(req, id, access.mailboxId, 'mailbox.foreign.folder.create', { folderId: folder.id, name: folder.name, parentId: parentId ?? null });
    res.status(201).json(folder);
  } catch (err) {
    if (String(err).includes('Unique constraint')) {
      res.status(409).json({ error: 'Ordner mit diesem Namen existiert bereits' });
      return;
    }
    throw err;
  }
});

// PATCH /api/v1/user/shared-mailboxes/:id/folders/:folderId — rename/move/color
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

  // 9.1: a new name must not start with an IMAP namespace prefix (renaming away is fine).
  if (typeof displayName === 'string') {
    const reserved = reservedFolderPrefix(displayName);
    if (reserved) { res.status(400).json({ error: reservedFolderNameError(reserved), code: 'RESERVED_FOLDER_NAME' }); return; }
  }

  // System folders must not be renamed or reparented
  if (PROTECTED_FOLDER_NAMES.has(folder.name)) {
    if (displayName !== undefined || parentId !== undefined) {
      res.status(403).json({ error: `Standard-Ordner „${folder.name}" kann nicht umbenannt oder verschoben werden` });
      return;
    }
  }

  // Cycle check: parentId must not be within its own subtree
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
  if (displayName !== undefined || parentId !== undefined) {
    auditCompat(req, id, access.mailboxId, 'mailbox.foreign.folder.update', {
      folderId, from: { name: folder.name, parentId: folder.parentId }, to: { name: updated.name, parentId: updated.parentId },
    });
  }
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

  // 9.3 (A1): the messages go to the mailbox Trash through the message store before
  // the folder row is deleted — pre-9.3 the Message→Folder cascade removed them
  // without tombstone. The contract (204) is unchanged; without a Trash folder a
  // non-empty folder is refused (409) instead of losing its mail.
  const done = await deleteFolderKeepingMail(folder);
  if (!done.ok) { res.status(409).json({ error: 'Papierkorb nicht gefunden' }); return; }
  auditCompat(req, id, access.mailboxId, 'mailbox.foreign.folder.delete', { folderId, name: folder.name, movedToTrash: done.moved, live: done.live });
  res.status(204).end();
});

// POST /api/v1/user/shared-mailboxes/:id/folders/:folderId/empty — delete all messages
userRouter.post('/shared-mailboxes/:id/folders/:folderId/empty', async (req: Request, res: Response) => {
  const { id, folderId } = req.params as { id: string; folderId: string };
  const access = await getWritableSharedMailbox(req.apiUser!.userId, id);
  if (!access) { res.status(403).json({ error: 'Vollzugriff erforderlich' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailboxId: access.mailboxId }, select: { id: true, name: true },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return; }

  // v8.1: expunge tombstones (recoverable for DELETED_ITEM_RETENTION_DAYS)
  const live = await prisma.message.findMany({ where: { folderId, deletedAt: null }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    if (live.length > 0) await expunge(tx, live.map((m) => m.id), { mailboxId: access.mailboxId, where: { folderId, deletedAt: null } });
    await tx.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
  });
  auditCompat(req, id, access.mailboxId, 'mailbox.foreign.folder.empty', { folderId, name: folder.name, expunged: live.length });
  res.json({ deleted: live.length });
});

// Folder + message operations of the 9.3 webmail (shared + delegated):
// routes/foreign-mailbox.ts, mounted on /api/v1/mail/shared-mailboxes/:id and
// /api/v1/mail/delegated-mailboxes/:id in server.ts.

// ── GET /api/v1/user/preferences ─────────────────────────────────────────────
// Personal user preferences (incl. inactivityTimeoutMinutes)
userRouter.get('/preferences', async (req: Request, res: Response) => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId: req.apiUser!.userId },
    select: { inactivityTimeoutMinutes: true },
  });
  // Global fallback from ServerSettings
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
    // null = use global setting; 0 = disabled; 1-1440 = own value
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
