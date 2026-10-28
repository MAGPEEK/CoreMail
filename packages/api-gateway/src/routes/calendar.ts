import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import {
  canAccessCalendar,
  listAccessibleCalendars,
  stripGalPrefix,
  maskEventForViewer,
} from '../lib/calendar-access.js';
import { audit, auditContext } from '../lib/audit.js';
import { notifyUserInbox } from '../lib/internal-notify.js';
import { getRedisClient, CHANNEL_CALENDAR_SHARES, createBullMqConnection } from '@coremail/core';
import { Queue } from 'bullmq';
import {
  enqueueInvitation,
  buildEventUid,
  type EventData,
  type AttendeeData,
} from '../lib/imip.js';

/**
 * v3.18.17 A2: Publishes a calendar-share lifecycle event to Redis. SSE handler
 * forwards it to all affectedUserIds (owner + grantee). Frontend invalidates
 * TanStack Query cache → instant UI update instead of 60s polling.
 */
function publishShareEvent(
  action: 'create' | 'update' | 'delete' | 'self_remove',
  calendarId: string,
  affectedUserIds: string[],
  extra?: Record<string, unknown>,
): void {
  try {
    void getRedisClient().publish(
      CHANNEL_CALENDAR_SHARES,
      JSON.stringify({ action, calendarId, affectedUserIds, ...extra }),
    );
  } catch {
    // best-effort — a Redis outage must not block the main path
  }
}

export const calendarRouter: RouterType = Router();
calendarRouter.use(requireAuth);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── BullMQ Outbound Queue (for iMIP, v3.18.25) ─────────────────────────────
// Singleton pattern as in routes/mail.ts. Dedicated Redis connection for BullMQ
// — getRedisClient() is shared with maxRetriesPerRequest:3, BullMQ needs a
// dedicated connection for blocking commands.
let _outboundQueue: Queue | null = null;
function getOutboundQueue(): Queue {
  if (!_outboundQueue) {
    _outboundQueue = new Queue('smtp-outbound', {
      connection: createBullMqConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return _outboundQueue;
}

/**
 * v3.18.25 A5: Sends iMIP invitations to all attendees (REQUEST or CANCEL).
 * Fire-and-forget — errors are logged but do not block the main path
 * (the event is already in the DB).
 */
async function sendInvitations(opts: {
  ev: { id: string; uid: string; summary: string; description: string;
        location: string; dtStart: Date; dtEnd: Date; sequence: number;
        attendees: unknown };
  organizerEmail: string;
  organizerName: string;
  method: 'REQUEST' | 'CANCEL';
}): Promise<void> {
  const rawAttendees = Array.isArray(opts.ev.attendees) ? opts.ev.attendees : [];
  const attendees: AttendeeData[] = rawAttendees
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .filter((a) => typeof a['email'] === 'string' && a['email'].includes('@'))
    .map((a): AttendeeData => ({
      email: a['email'] as string,
      ...(typeof a['cn'] === 'string' ? { cn: a['cn'] } : {}),
      partstat: (a['partstat'] as AttendeeData['partstat']) ?? 'NEEDS-ACTION',
      role: 'REQ-PARTICIPANT',
      rsvp: true,
    }));
  if (attendees.length === 0) return;

  // publicHostname from ServerSettings (for the UID domain)
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  });
  const publicHostname = settings?.publicHostname ?? 'coremail.local';

  const eventData: EventData = {
    uid: opts.ev.uid.includes('@') ? opts.ev.uid : buildEventUid(opts.ev.id, publicHostname),
    sequence: opts.ev.sequence,
    summary: opts.ev.summary,
    description: opts.ev.description,
    location: opts.ev.location,
    dtStart: opts.ev.dtStart,
    dtEnd: opts.ev.dtEnd,
    organizer: { email: opts.organizerEmail, cn: opts.organizerName },
    attendees,
    publicHostname,
  };

  try {
    await enqueueInvitation({
      ev: eventData,
      method: opts.method,
      queue: getOutboundQueue(),
      trackingId: `imip-${opts.method}-${opts.ev.id}`,
    });
  } catch (err) {
    // Fail-safe: the event already exists in the DB, only the invitation failed at queue/SMTP
    // — we log and move on. The user can later trigger a retry via a „Resend invitation"
    // button (future).
    // eslint-disable-next-line no-console
    console.error('[iMIP] failed to enqueue invitation', { eventId: opts.ev.id, err });
  }
}

// GET /api/v1/calendar — own + shared calendars
calendarRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;

  let calendars = await listAccessibleCalendars(userId);

  // Lazy provisioning: only if the user has NO own calendar at all yet.
  if (!calendars.some((c) => !c.shared)) {
    await prisma.calendar.create({
      data: { userId, name: 'Kalender', color: '#0078D4', isDefault: true, sortOrder: 0 },
    });
    calendars = await listAccessibleCalendars(userId);
  }

  res.json(calendars);
});

// POST /api/v1/calendar
const CreateCalSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#0078D4'),
  icon: z.string().max(40).optional(),
});
calendarRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateCalSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const userId = req.apiUser!.userId;
  const maxOrder = await prisma.calendar.aggregate({
    where: { userId },
    _max: { sortOrder: true },
  });
  const calendar = await prisma.calendar.create({
    data: {
      userId,
      name: parsed.data.name,
      color: parsed.data.color,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 10,
      ...(parsed.data.icon ? { icon: parsed.data.icon } : {}),
    },
  });
  res.status(201).json(calendar);
});

// PATCH /api/v1/calendar/:id  (owner only)
const PatchCalSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(40).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
calendarRouter.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchCalSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const cal = await prisma.calendar.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)      updates['name'] = parsed.data.name;
  if (parsed.data.color !== undefined)     updates['color'] = parsed.data.color;
  if (parsed.data.icon !== undefined)      updates['icon'] = parsed.data.icon;
  if (parsed.data.sortOrder !== undefined) updates['sortOrder'] = parsed.data.sortOrder;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.calendar.update({ where: { id }, data: updates as any });
  res.json(updated);
});

// DELETE /api/v1/calendar/:id  (owner only; default calendar protected)
calendarRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const cal = await prisma.calendar.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }
  if (cal.isDefault) { res.status(400).json({ error: 'Standard-Kalender kann nicht gelöscht werden' }); return; }
  await prisma.calendar.delete({ where: { id } });
  res.json({ ok: true });
});

// POST /api/v1/calendar/reorder  Body: { ids: string[] }  (own only)
const ReorderSchema = z.object({ ids: z.array(z.string()).min(1).max(50) });
calendarRouter.post('/reorder', async (req: Request, res: Response) => {
  const parsed = ReorderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const userId = req.apiUser!.userId;
  const owned = await prisma.calendar.findMany({
    where: { id: { in: parsed.data.ids }, userId },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((c) => c.id));
  const sequence = parsed.data.ids.filter((id) => ownedSet.has(id));

  await prisma.$transaction(
    sequence.map((id, idx) =>
      prisma.calendar.update({ where: { id }, data: { sortOrder: (idx + 1) * 10 } }),
    ),
  );
  res.json({ ok: true, count: sequence.length });
});

// ─── CalDAV info (v3.18.18) ─────────────────────────────────────────────────

// GET /api/v1/calendar/caldav-info
// Returns the CalDAV URLs for the current user — one "account URL" for
// auto-discovery in Apple Calendar / Thunderbird plus a direct URL per
// own calendar. Includes an auth hint (bearer token does not work in
// CalDAV clients — app password required).
calendarRouter.get('/caldav-info', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;

  const [settings, user, calendars] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { publicHostname: true, useHttps: true, httpPort: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    }),
    prisma.calendar.findMany({
      where: { userId },
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const hostname = settings?.publicHostname ?? req.get('host') ?? 'mail.local';
  // Always recommend HTTPS for CalDAV (auth leak otherwise). If the admin has
  // explicitly configured the server for HTTP (e.g. behind a reverse proxy), we
  // respect that, otherwise Apple Calendar auto-discovery does not work.
  const proto = settings?.useHttps === false ? 'http' : 'https';
  const port = settings?.httpPort ?? 443;
  const isStandardPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  const portSuffix = isStandardPort ? '' : `:${port}`;
  const baseUrl = `${proto}://${hostname}${portSuffix}`;

  res.json({
    // Auto-discovery (Apple Calendar, Thunderbird): the user enters only baseUrl
    // and the client discovers all calendars via PROPFIND.
    accountUrl: `${baseUrl}/dav/calendars/${userId}/`,
    // Per-calendar URL for direct mount (e.g. subscribe to a single calendar only)
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.name,
      isDefault: c.isDefault,
      url: `${baseUrl}/dav/calendars/${userId}/${c.id}/`,
    })),
    // Auth hint: CalDAV clients need an app password, not the normal
    // login password (which would be blocked by MFA).
    username: user?.email ?? '',
    authHint: 'app-password',
  });
});

// ─── Grantee-local settings (v3.18.16 A3 + A8) ──────────────────────────────

// PATCH /api/v1/calendar/mine-shares/:shareId
// Body: { localColor?: string|null, sortOrder?: number }
// Grantee only — the owner's color is NOT changed.
const PatchMineShareSchema = z.object({
  localColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
calendarRouter.patch('/mine-shares/:shareId', async (req: Request, res: Response) => {
  const { shareId } = req.params as { shareId: string };
  const userId = req.apiUser!.userId;

  const parsed = PatchMineShareSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const share = await prisma.calendarShare.findFirst({
    where: { id: shareId, granteeId: userId },
    select: { id: true },
  });
  if (!share) { res.status(404).json({ error: 'Freigabe nicht gefunden' }); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.localColor !== undefined) updates['localColor'] = parsed.data.localColor;
  if (parsed.data.sortOrder !== undefined)  updates['sortOrder']  = parsed.data.sortOrder;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await prisma.calendarShare.update({ where: { id: shareId }, data: updates as any });
  res.json({ ok: true });
});

// POST /api/v1/calendar/mine-shares/reorder  Body: { ids: string[] }
// Sets sortOrder analogous to /calendar/reorder for own shares.
calendarRouter.post('/mine-shares/reorder', async (req: Request, res: Response) => {
  const parsed = ReorderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const userId = req.apiUser!.userId;
  const mine = await prisma.calendarShare.findMany({
    where: { id: { in: parsed.data.ids }, granteeId: userId },
    select: { id: true },
  });
  const mineSet = new Set(mine.map((s) => s.id));
  const sequence = parsed.data.ids.filter((id) => mineSet.has(id));

  await prisma.$transaction(
    sequence.map((id, idx) =>
      prisma.calendarShare.update({ where: { id }, data: { sortOrder: (idx + 1) * 10 } }),
    ),
  );
  res.json({ ok: true, count: sequence.length });
});

// ─── Sharing endpoints ──────────────────────────────────────────────────────

// GET /api/v1/calendar/mine-shares — shares granted to me
// (grantee view). Optional filter ?calendarId=...
calendarRouter.get('/mine-shares', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const calendarIdFilter = typeof req.query['calendarId'] === 'string'
    ? req.query['calendarId']
    : null;

  const shares = await prisma.calendarShare.findMany({
    where: {
      granteeId: userId,
      ...(calendarIdFilter ? { calendarId: calendarIdFilter } : {}),
    },
    select: {
      id: true,
      calendarId: true,
      permission: true,
      createdAt: true,
      calendar: { select: { name: true, color: true, userId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json(shares.map((s) => ({
    id: s.id,
    calendarId: s.calendarId,
    permission: s.permission,
    calendarName: s.calendar.name,
    calendarColor: s.calendar.color,
    ownerId: s.calendar.userId,
    createdAt: s.createdAt.toISOString(),
  })));
});

// GET /api/v1/calendar/:id/shares — list of all shares (owner only)
calendarRouter.get('/:id/shares', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser!.userId;

  const cal = await prisma.calendar.findFirst({ where: { id, userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }

  const shares = await prisma.calendarShare.findMany({
    where: { calendarId: id },
    select: {
      id: true,
      granteeId: true,
      permission: true,
      comment: true,
      createdAt: true,
      grantee: { select: { email: true, displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json(shares.map((s) => ({
    id: s.id,
    calendarId: id,
    granteeId: s.granteeId,
    granteeEmail: s.grantee.email,
    granteeDisplayName: s.grantee.displayName ?? s.grantee.email,
    permission: s.permission,
    comment: s.comment ?? '',
    createdAt: s.createdAt.toISOString(),
  })));
});

// POST /api/v1/calendar/:id/shares — Body: { granteeId, permission, comment? }
const CreateShareSchema = z.object({
  granteeId: z.string().min(1),
  permission: z.enum(['READ', 'WRITE']),
  comment: z.string().max(200).optional(),
});
calendarRouter.post('/:id/shares', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser!.userId;

  const parsed = CreateShareSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const cal = await prisma.calendar.findFirst({ where: { id, userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }

  const granteeId = stripGalPrefix(parsed.data.granteeId);

  if (granteeId === userId) {
    res.status(400).json({ error: 'Du kannst den Kalender nicht an dich selbst freigeben' });
    return;
  }

  const grantee = await prisma.user.findFirst({
    where: { id: granteeId, active: true },
    select: { id: true, email: true, displayName: true },
  });
  if (!grantee) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

  // Upsert: repeated POST with the same granteeId → update
  const share = await prisma.calendarShare.upsert({
    where: { calendarId_granteeId: { calendarId: id, granteeId } },
    update: {
      permission: parsed.data.permission,
      ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    },
    create: {
      calendarId: id,
      ownerId: userId,
      granteeId,
      permission: parsed.data.permission,
      ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    },
  });

  // v3.18.15 audit log: share create/update (compliance)
  audit({
    actorId: userId,
    actorEmail: req.apiUser!.email,
    action: 'calendar.share.create',
    targetType: 'calendar',
    targetId: id,
    targetName: cal.name,
    changes: { granteeId, granteeEmail: grantee.email, permission: parsed.data.permission },
    ...auditContext(req),
  });

  // v3.18.17 A2: SSE push for live sync
  publishShareEvent(
    share.createdAt.getTime() < Date.now() - 5000 ? 'update' : 'create',
    id,
    [userId, granteeId],
    { permission: parsed.data.permission },
  );

  // v3.18.16 A1: notification mail in the grantee inbox — only for a *new* share,
  // not for a permission update via upsert (would be spam otherwise).
  const wasUpdate = share.createdAt.getTime() < Date.now() - 5000; // rough heuristic
  if (!wasUpdate) {
    const ownerName = req.apiUser!.email; // displayName could be looked up, KISS here
    const permLabel = parsed.data.permission === 'WRITE' ? 'Lesen und Schreiben' : 'Nur lesen';
    void notifyUserInbox({
      recipientUserId: grantee.id,
      fromName: ownerName,
      fromAddr: req.apiUser!.email,
      subject: `${ownerName} hat den Kalender „${cal.name}" mit dir geteilt`,
      bodyText:
        `Hallo,\n\n` +
        `${ownerName} hat den Kalender „${cal.name}" mit dir geteilt.\n\n` +
        `Berechtigung: ${permLabel}\n\n` +
        `Du findest den Kalender ab sofort in deinem CoreMail-Kalender unter „Geteilt mit mir".\n\n` +
        `— CoreMail`,
      bodyHtml:
        `<p>Hallo,</p>` +
        `<p><strong>${escapeHtml(ownerName)}</strong> hat den Kalender ` +
        `<strong>„${escapeHtml(cal.name)}"</strong> mit dir geteilt.</p>` +
        `<p>Berechtigung: <strong>${permLabel}</strong></p>` +
        `<p>Du findest den Kalender ab sofort in deinem CoreMail-Kalender unter ` +
        `<em>Geteilt mit mir</em>.</p>` +
        `<p style="color:#888;font-size:12px">— CoreMail</p>`,
    });
  }

  res.status(201).json({
    id: share.id,
    calendarId: id,
    granteeId: grantee.id,
    granteeEmail: grantee.email,
    granteeDisplayName: grantee.displayName ?? grantee.email,
    permission: share.permission,
    comment: share.comment ?? '',
    createdAt: share.createdAt.toISOString(),
  });
});

// PUT /api/v1/calendar/:id/shares/:shareId — Body: { permission, comment? }
const UpdateShareSchema = z.object({
  permission: z.enum(['READ', 'WRITE']),
  comment: z.string().max(200).optional(),
});
calendarRouter.put('/:id/shares/:shareId', async (req: Request, res: Response) => {
  const { id, shareId } = req.params as { id: string; shareId: string };
  const userId = req.apiUser!.userId;

  const parsed = UpdateShareSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const cal = await prisma.calendar.findFirst({ where: { id, userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }

  const share = await prisma.calendarShare.findFirst({ where: { id: shareId, calendarId: id } });
  if (!share) { res.status(404).json({ error: 'Freigabe nicht gefunden' }); return; }

  const updated = await prisma.calendarShare.update({
    where: { id: shareId },
    data: {
      permission: parsed.data.permission,
      ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    },
    select: {
      id: true, granteeId: true, permission: true, comment: true, createdAt: true,
      grantee: { select: { email: true, displayName: true } },
    },
  });

  audit({
    actorId: userId,
    actorEmail: req.apiUser!.email,
    action: 'calendar.share.update',
    targetType: 'calendar',
    targetId: id,
    targetName: cal.name,
    changes: {
      shareId, granteeEmail: updated.grantee.email,
      oldPermission: share.permission, newPermission: parsed.data.permission,
    },
    ...auditContext(req),
  });

  publishShareEvent('update', id, [userId, updated.granteeId], {
    permission: parsed.data.permission,
  });

  res.json({
    id: updated.id,
    calendarId: id,
    granteeId: updated.granteeId,
    granteeEmail: updated.grantee.email,
    granteeDisplayName: updated.grantee.displayName ?? updated.grantee.email,
    permission: updated.permission,
    comment: updated.comment ?? '',
    createdAt: updated.createdAt.toISOString(),
  });
});

// DELETE /api/v1/calendar/:id/shares/:shareId — owner OR the grantee themselves
calendarRouter.delete('/:id/shares/:shareId', async (req: Request, res: Response) => {
  const { id, shareId } = req.params as { id: string; shareId: string };
  const userId = req.apiUser!.userId;

  const share = await prisma.calendarShare.findUnique({
    where: { id: shareId },
    select: {
      id: true, calendarId: true, ownerId: true, granteeId: true, permission: true,
      grantee: { select: { email: true } },
      calendar: { select: { name: true } },
    },
  });
  if (!share || share.calendarId !== id) { res.status(404).json({ error: 'Freigabe nicht gefunden' }); return; }

  // Owner may remove everything; grantee may remove their own share ("Aus meiner Liste")
  const isOwnerAction = share.ownerId === userId;
  const isGranteeSelfRemoval = share.granteeId === userId;
  if (!isOwnerAction && !isGranteeSelfRemoval) {
    res.status(403).json({ error: 'Keine Berechtigung' });
    return;
  }

  await prisma.calendarShare.delete({ where: { id: shareId } });

  audit({
    actorId: userId,
    actorEmail: req.apiUser!.email,
    action: isOwnerAction ? 'calendar.share.delete' : 'calendar.share.self_remove',
    targetType: 'calendar',
    targetId: id,
    targetName: share.calendar.name,
    changes: {
      shareId, granteeEmail: share.grantee.email,
      permission: share.permission,
    },
    ...auditContext(req),
  });

  publishShareEvent(
    isOwnerAction ? 'delete' : 'self_remove',
    id,
    [share.ownerId, share.granteeId],
  );

  res.json({ ok: true });
});

// ─── Free/Busy (v3.18.17 A4) ────────────────────────────────────────────────

// POST /api/v1/calendar/freebusy
// Body: { userEmails: string[], start: ISO, end: ISO }
// Returns, per requested user, all busy slots from calendars the calling user
// has access to (own + via share). For other users only slots from calendars
// that the other user has shared with the calling user are considered.
// CONFIDENTIAL stays hidden, PRIVATE is returned as a generic „Busy"
// without subject.
const FreeBusySchema = z.object({
  userEmails: z.array(z.string().email()).min(1).max(50),
  start: z.string(),
  end: z.string(),
});
calendarRouter.post('/freebusy', async (req: Request, res: Response) => {
  const callerId = req.apiUser!.userId;
  const parsed = FreeBusySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const start = new Date(parsed.data.start);
  const end = new Date(parsed.data.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    res.status(400).json({ error: 'Invalid date range' });
    return;
  }
  // Limit to max. 90 days (against DoS)
  if (end.getTime() - start.getTime() > 90 * 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: 'Range too large (max 90 days)' });
    return;
  }

  // Email → user mapping
  const users = await prisma.user.findMany({
    where: { email: { in: parsed.data.userEmails.map((e) => e.toLowerCase()) }, active: true },
    select: { id: true, email: true, displayName: true },
  });
  const usersByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  const result: Array<{
    email: string;
    displayName: string | null;
    found: boolean;
    busy: Array<{ start: string; end: string; type: 'busy' | 'tentative'; subject?: string }>;
  }> = [];

  for (const requestedEmail of parsed.data.userEmails) {
    const targetUser = usersByEmail.get(requestedEmail.toLowerCase());
    if (!targetUser) {
      result.push({ email: requestedEmail, displayName: null, found: false, busy: [] });
      continue;
    }

    // Which calendars of the target user may the caller see?
    // - The caller's own calendars (when querying themselves)
    // - Calendars shared by the target user with the caller
    const targetCalendars = await prisma.calendar.findMany({
      where: {
        userId: targetUser.id,
        OR: [
          // Caller queries themselves → all own calendars
          ...(targetUser.id === callerId ? [{ userId: callerId }] : []),
          // Caller has a share from the target user
          { shares: { some: { granteeId: callerId } } },
        ],
      },
      select: { id: true },
    });

    if (targetCalendars.length === 0) {
      // Caller has no access to target calendars → empty busy list
      result.push({
        email: requestedEmail,
        displayName: targetUser.displayName ?? null,
        found: true,
        busy: [],
      });
      continue;
    }

    const events = await prisma.calendarEvent.findMany({
      where: {
        calendarId: { in: targetCalendars.map((c) => c.id) },
        // Overlap: event.dtStart < end AND event.dtEnd > start
        dtStart: { lt: end },
        dtEnd:   { gt: start },
      },
      select: { dtStart: true, dtEnd: true, summary: true, classification: true },
    });

    const busy = events
      .filter((e) => {
        const cls = (e.classification ?? 'PUBLIC').toUpperCase();
        // CONFIDENTIAL → hide from caller (unless caller is owner = self-query)
        if (cls === 'CONFIDENTIAL' && targetUser.id !== callerId) return false;
        return true;
      })
      .map((e) => {
        const cls = (e.classification ?? 'PUBLIC').toUpperCase();
        const isPrivateForCaller = cls === 'PRIVATE' && targetUser.id !== callerId;
        return {
          start: e.dtStart.toISOString(),
          end: e.dtEnd.toISOString(),
          type: 'busy' as const,
          // PRIVATE for foreign caller → no subject
          ...(isPrivateForCaller ? {} : { subject: e.summary }),
        };
      });

    result.push({
      email: requestedEmail,
      displayName: targetUser.displayName ?? null,
      found: true,
      busy,
    });
  }

  res.json({ start: start.toISOString(), end: end.toISOString(), users: result });
});

// ─── Events ─────────────────────────────────────────────────────────────────

// GET /api/v1/calendar/events?start=&end=&calendarId=
// v3.18.15: privacy masking active — grantees see private events only as „Beschäftigt",
// confidential events are hidden completely. Owner sees everything unchanged.
calendarRouter.get('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const start = req.query['start'] ? new Date(String(req.query['start'])) : new Date();
  const end = req.query['end']
    ? new Date(String(req.query['end']))
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const calendarIdParam = req.query['calendarId'] as string | undefined;

  // Remember per calendar whether the viewer is owner (for the masking decision)
  const ownerByCalendar = new Map<string, boolean>();
  let calIds: string[];
  if (calendarIdParam) {
    const access = await canAccessCalendar(userId, calendarIdParam, 'READ');
    if (!access) { res.status(403).json({ error: 'Keine Leserechte für diesen Kalender' }); return; }
    calIds = [calendarIdParam];
    ownerByCalendar.set(calendarIdParam, access.isOwner);
  } else {
    const accessible = await listAccessibleCalendars(userId);
    calIds = accessible.map((c) => c.id);
    for (const c of accessible) ownerByCalendar.set(c.id, c.permission === 'OWNER');
  }

  if (calIds.length === 0) { res.json([]); return; }

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId: { in: calIds }, dtStart: { gte: start }, dtEnd: { lte: end } },
    orderBy: { dtStart: 'asc' },
  });

  // Masking: PRIVATE → details replaced by "Beschäftigt"; CONFIDENTIAL → hidden
  const masked = events
    .map((ev) => maskEventForViewer(ev, ownerByCalendar.get(ev.calendarId) === true))
    .filter((ev): ev is NonNullable<typeof ev> => ev !== null);

  res.json(masked);
});

// v3.18.27 — GET /api/v1/calendar/events/:id (detail load for the edit dialog)
calendarRouter.get('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  const event = await prisma.calendarEvent.findUnique({
    where: { id },
    select: {
      id: true, uid: true, calendarId: true, summary: true, description: true,
      location: true, dtStart: true, dtEnd: true, allDay: true,
      recurring: true, rrule: true, classification: true, sequence: true,
      organizer: true, attendees: true, status: true,
    },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'READ');
  if (!access) { res.status(403).json({ error: 'Keine Leserechte' }); return; }

  // Masking for PRIVATE/CONFIDENTIAL for grantees
  if (!access.isOwner) {
    const cls = (event.classification ?? 'PUBLIC').toUpperCase();
    if (cls === 'CONFIDENTIAL') {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (cls === 'PRIVATE') {
      res.json({
        ...event,
        summary: 'Beschäftigt', description: '', location: '',
        attendees: [], organizer: null,
        readOnly: true, canWrite: false,
      });
      return;
    }
  }

  res.json({
    ...event,
    canWrite: access.permission === 'OWNER' || access.permission === 'WRITE',
    readOnly: access.permission === 'READ',
  });
});

// POST /api/v1/calendar/events  (WRITE permission on target calendar)
const AttendeeSchema = z.object({
  email: z.string().email(),
  cn: z.string().optional(),
  partstat: z.enum(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE']).optional(),
});
const EventSchema = z.object({
  calendarId: z.string(),
  summary: z.string().min(1),
  dtStart: z.string(),
  dtEnd: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  allDay: z.boolean().default(false),
  recurring: z.boolean().default(false),
  rrule: z.string().optional(),
  // v3.18.15: privacy level (PUBLIC=default, PRIVATE=busy only, CONFIDENTIAL=invisible)
  classification: z.enum(['PUBLIC', 'PRIVATE', 'CONFIDENTIAL']).optional(),
  // v3.18.25 A5: attendees (guest mail addresses) — if non-empty an iMIP REQUEST is sent
  attendees: z.array(AttendeeSchema).max(100).optional(),
});

calendarRouter.post('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { calendarId, summary, dtStart, dtEnd, description = '', location = '', allDay, recurring, rrule, classification = 'PUBLIC', attendees = [] } = parsed.data;

  const access = await canAccessCalendar(userId, calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  // Organizer = current user (self-lookup for displayName)
  const organizer = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true },
  });
  if (!organizer) { res.status(500).json({ error: 'Organizer-User nicht gefunden' }); return; }

  const icalData = buildIcal({
    summary, dtStart, dtEnd, description, location, allDay, classification,
    ...(rrule !== undefined ? { rrule } : {}),
  });

  // v3.18.25: UID with hostname suffix for global uniqueness (RFC 5545 §3.8.4.7)
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  });
  const { randomUUID } = await import('node:crypto');
  const rawEventId = randomUUID();
  const uid = buildEventUid(rawEventId, settings?.publicHostname ?? 'coremail.local');

  // Store attendees as a JSON array
  const attendeesJson = attendees.map((a) => ({
    email: a.email,
    cn: a.cn ?? a.email,
    partstat: a.partstat ?? 'NEEDS-ACTION',
    role: 'REQ-PARTICIPANT',
    rsvp: true,
  }));

  const event = await prisma.calendarEvent.create({
    data: {
      calendarId,
      uid,
      summary,
      description,
      location,
      dtStart: new Date(dtStart),
      dtEnd: new Date(dtEnd),
      recurring,
      icalData,
      classification,
      organizer: organizer.email,
      attendees: attendeesJson,
      sequence: 0,
    },
  });

  // v3.18.25 A5: send iMIP REQUEST to all attendees (fire-and-forget)
  if (attendees.length > 0) {
    void sendInvitations({
      ev: event,
      organizerEmail: organizer.email,
      organizerName: organizer.displayName ?? organizer.email,
      method: 'REQUEST',
    });
  }

  res.status(201).json(event);
});

// PUT /api/v1/calendar/events/:id  (WRITE permission on the event's calendar)
calendarRouter.put('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };
  const parsed = EventSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const event = await prisma.calendarEvent.findUnique({
    where: { id },
    select: { id: true, calendarId: true, summary: true, description: true, location: true,
              uid: true, dtStart: true, dtEnd: true, recurring: true, classification: true,
              sequence: true, organizer: true, attendees: true },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  const { summary, dtStart, dtEnd, description, location, allDay, rrule, classification, attendees } = parsed.data;
  const effectiveClass = classification ?? event.classification ?? 'PUBLIC';
  const icalData = buildIcal({
    summary: summary ?? event.summary,
    dtStart: dtStart ?? event.dtStart.toISOString(),
    dtEnd: dtEnd ?? event.dtEnd.toISOString(),
    description: description ?? '',
    location: location ?? '',
    allDay: allDay ?? false,
    classification: effectiveClass,
    ...(rrule !== undefined ? { rrule } : {}),
  });

  // v3.18.25 A5: if relevant fields changed → sequence++ and send new
  // REQUEST mails to all attendees. „Relevant" fields are all those that
  // appear in the iMIP mail (summary, dtStart, dtEnd, location, attendees).
  const willSendUpdate =
    (summary !== undefined && summary !== event.summary) ||
    (dtStart !== undefined && new Date(dtStart).getTime() !== event.dtStart.getTime()) ||
    (dtEnd !== undefined && new Date(dtEnd).getTime() !== event.dtEnd.getTime()) ||
    (location !== undefined && location !== event.location) ||
    attendees !== undefined;

  const newAttendeesJson = attendees
    ? attendees.map((a) => ({
        email: a.email,
        cn: a.cn ?? a.email,
        partstat: a.partstat ?? 'NEEDS-ACTION',
        role: 'REQ-PARTICIPANT',
        rsvp: true,
      }))
    : event.attendees;

  const updated = await prisma.calendarEvent.update({
    where: { id },
    data: {
      summary: summary ?? event.summary,
      description: description ?? event.description,
      location: location ?? event.location,
      dtStart: dtStart ? new Date(dtStart) : event.dtStart,
      dtEnd: dtEnd ? new Date(dtEnd) : event.dtEnd,
      recurring: !!rrule || event.recurring,
      icalData,
      classification: effectiveClass,
      ...(attendees !== undefined ? { attendees: newAttendeesJson as object } : {}),
      ...(willSendUpdate ? { sequence: { increment: 1 } } : {}),
    },
  });

  // v3.18.25 A5: send REQUEST update to attendees (with incremented SEQUENCE)
  const finalAttendees = Array.isArray(updated.attendees) ? updated.attendees : [];
  if (willSendUpdate && finalAttendees.length > 0 && event.organizer) {
    const organizerUser = await prisma.user.findFirst({
      where: { email: event.organizer },
      select: { displayName: true },
    });
    void sendInvitations({
      ev: updated,
      organizerEmail: event.organizer,
      organizerName: organizerUser?.displayName ?? event.organizer,
      method: 'REQUEST',
    });
  }

  res.json(updated);
});

// DELETE /api/v1/calendar/events/:id  (WRITE permission on the event's calendar)
calendarRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  // v3.18.25 A5: load full event data for the CANCEL mail BEFORE delete
  const event = await prisma.calendarEvent.findUnique({
    where: { id },
    select: { id: true, calendarId: true, uid: true, summary: true, description: true,
              location: true, dtStart: true, dtEnd: true, sequence: true,
              organizer: true, attendees: true },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  await prisma.calendarEvent.delete({ where: { id } });

  // v3.18.25 A5: CANCEL mails to all attendees (with sequence+1)
  const attList = Array.isArray(event.attendees) ? event.attendees : [];
  if (attList.length > 0 && event.organizer) {
    const organizerUser = await prisma.user.findFirst({
      where: { email: event.organizer },
      select: { displayName: true },
    });
    void sendInvitations({
      ev: { ...event, sequence: event.sequence + 1 },
      organizerEmail: event.organizer,
      organizerName: organizerUser?.displayName ?? event.organizer,
      method: 'CANCEL',
    });
  }

  res.json({ ok: true });
});

function buildIcal(opts: {
  summary: string; dtStart: string; dtEnd: string;
  description: string; location: string; allDay: boolean;
  rrule?: string;
  classification?: string;
}): string {
  const formatDt = (iso: string, allDay: boolean): string => {
    if (allDay) return iso.slice(0, 10).replace(/-/g, '');
    return iso.replace(/[-:]/g, '').replace('.000', '').slice(0, 15) + 'Z';
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CoreMail//EN',
    'BEGIN:VEVENT',
    `SUMMARY:${opts.summary}`,
    opts.allDay
      ? `DTSTART;VALUE=DATE:${formatDt(opts.dtStart, true)}`
      : `DTSTART:${formatDt(opts.dtStart, false)}`,
    opts.allDay
      ? `DTEND;VALUE=DATE:${formatDt(opts.dtEnd, true)}`
      : `DTEND:${formatDt(opts.dtEnd, false)}`,
  ];
  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  if (opts.location) lines.push(`LOCATION:${opts.location}`);
  if (opts.rrule) lines.push(`RRULE:${opts.rrule}`);
  // RFC 5545 §3.8.1.3 — CLASS:PUBLIC|PRIVATE|CONFIDENTIAL
  if (opts.classification && opts.classification !== 'PUBLIC') {
    lines.push(`CLASS:${opts.classification}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
