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
 * v3.18.17 A2: Publishes a calendar-share lifecycle event to Redis. SSE-Handler
 * forwards it to all affectedUserIds (Owner + Grantee). Frontend invalidates
 * TanStack Query Cache → instant UI update statt 60s-Polling.
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
    // best-effort — Redis-Ausfall darf nicht den Hauptpfad blocken
  }
}

export const calendarRouter: RouterType = Router();
calendarRouter.use(requireAuth);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── BullMQ Outbound Queue (für iMIP, v3.18.25) ─────────────────────────────
// Singleton-Pattern wie in routes/mail.ts. Eigene Redis-Connection für BullMQ
// — getRedisClient() ist shared mit maxRetriesPerRequest:3, BullMQ braucht
// dedizierte Connection für Blocking-Commands.
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
 * v3.18.25 A5: Sendet iMIP-Einladungen an alle Attendees (REQUEST oder CANCEL).
 * Fire-and-forget — Fehler werden geloggt, blockieren aber nicht den Hauptpfad
 * (Event ist ja schon in der DB).
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

  // PublicHostname aus ServerSettings (für UID-Domain)
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
    // Fail-safe: Event existiert bereits in DB, Einladung scheitert nur an Queue/SMTP
    // — wir loggen und gehen weiter. User kann später via „Einladung neu senden"-Button
    // retry triggern (zukünftig).
    // eslint-disable-next-line no-console
    console.error('[iMIP] failed to enqueue invitation', { eventId: opts.ev.id, err });
  }
}

// GET /api/v1/calendar — eigene + geteilte Kalender
calendarRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;

  let calendars = await listAccessibleCalendars(userId);

  // Lazy provisioning: nur wenn User noch GAR keinen eigenen Kalender hat.
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

// PATCH /api/v1/calendar/:id  (nur Owner)
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

// DELETE /api/v1/calendar/:id  (nur Owner; Default-Kalender geschützt)
calendarRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const cal = await prisma.calendar.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }
  if (cal.isDefault) { res.status(400).json({ error: 'Standard-Kalender kann nicht gelöscht werden' }); return; }
  await prisma.calendar.delete({ where: { id } });
  res.json({ ok: true });
});

// POST /api/v1/calendar/reorder  Body: { ids: string[] }  (nur eigene)
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

// ─── CalDAV-Info (v3.18.18) ─────────────────────────────────────────────────

// GET /api/v1/calendar/caldav-info
// Liefert die CalDAV-URLs für den aktuellen User — eine "Account-URL" für
// Auto-Discovery in Apple Kalender / Thunderbird plus eine direkte URL pro
// eigenem Kalender. Inklusive Hinweis zum Auth (Bearer-Token funktioniert
// nicht in CalDAV-Clients — App-Passwort nötig).
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
  // CalDAV immer über HTTPS empfehlen (Auth-Leak sonst). Wenn Admin den Server
  // explizit auf HTTP konfiguriert hat (z. B. hinter Reverse-Proxy), respektieren
  // wir das aber, sonst geht Auto-Discovery vom Apple Kalender nicht.
  const proto = settings?.useHttps === false ? 'http' : 'https';
  const port = settings?.httpPort ?? 443;
  const isStandardPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  const portSuffix = isStandardPort ? '' : `:${port}`;
  const baseUrl = `${proto}://${hostname}${portSuffix}`;

  res.json({
    // Auto-Discovery (Apple Kalender, Thunderbird): User gibt nur baseUrl ein
    // und der Client entdeckt alle Kalender via PROPFIND.
    accountUrl: `${baseUrl}/dav/calendars/${userId}/`,
    // Pro-Kalender-URL für direkten Mount (z. B. nur einen Kalender abonnieren)
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.name,
      isDefault: c.isDefault,
      url: `${baseUrl}/dav/calendars/${userId}/${c.id}/`,
    })),
    // Auth-Hinweis: CalDAV-Clients brauchen ein App-Passwort, nicht das normale
    // Login-Passwort (das wäre durch MFA blockiert).
    username: user?.email ?? '',
    authHint: 'app-password',
  });
});

// ─── Grantee-lokale Settings (v3.18.16 A3 + A8) ─────────────────────────────

// PATCH /api/v1/calendar/mine-shares/:shareId
// Body: { localColor?: string|null, sortOrder?: number }
// Nur Grantee selbst — Owner-Farbe wird NICHT geändert.
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
// Setzt sortOrder analog /calendar/reorder für eigene Freigaben.
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

// ─── Sharing-Endpoints ──────────────────────────────────────────────────────

// GET /api/v1/calendar/mine-shares — Shares die mir gewährt wurden
// (Grantee-Sicht). Optional Filter ?calendarId=...
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

// GET /api/v1/calendar/:id/shares — Liste aller Freigaben (nur Owner)
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

  // Upsert: erneuter POST mit gleicher granteeId → Update
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

  // v3.18.15 Audit-Log: Share-Erstellung/-Update (Compliance)
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

  // v3.18.17 A2: SSE-Push für Live-Sync
  publishShareEvent(
    share.createdAt.getTime() < Date.now() - 5000 ? 'update' : 'create',
    id,
    [userId, granteeId],
    { permission: parsed.data.permission },
  );

  // v3.18.16 A1: Notification-Mail in Grantee-Inbox — nur bei *neuer* Share,
  // nicht bei Permission-Update via Upsert (sonst Spam).
  const wasUpdate = share.createdAt.getTime() < Date.now() - 5000; // grobe Heuristik
  if (!wasUpdate) {
    const ownerName = req.apiUser!.email; // displayName ggf. via lookup, hier KISS
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

// DELETE /api/v1/calendar/:id/shares/:shareId — Owner ODER Grantee selbst
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

  // Owner darf alles entfernen; Grantee darf eigene Share entfernen ("Aus meiner Liste")
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
// Liefert pro angefragtem User alle Busy-Slots aus Kalendern, auf die der
// aufrufende User Zugriff hat (eigen + per Share). Für andere User werden nur
// Slots aus Kalendern berücksichtigt, die der andere User dem aufrufenden User
// freigegeben hat. CONFIDENTIAL bleibt ausgeblendet, PRIVATE wird als generic
// „Busy" geliefert ohne Subject.
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
  // Begrenzen auf max. 90 Tage (gegen DoS)
  if (end.getTime() - start.getTime() > 90 * 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: 'Range too large (max 90 days)' });
    return;
  }

  // Email → User-Mapping
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

    // Welche Kalender vom Ziel-User darf der Caller einsehen?
    // - Eigene Kalender vom Caller (wenn er sich selbst anfragt)
    // - Vom Ziel-User an Caller geteilte Kalender
    const targetCalendars = await prisma.calendar.findMany({
      where: {
        userId: targetUser.id,
        OR: [
          // Caller fragt sich selbst → alle eigenen
          ...(targetUser.id === callerId ? [{ userId: callerId }] : []),
          // Caller hat Share vom Ziel-User
          { shares: { some: { granteeId: callerId } } },
        ],
      },
      select: { id: true },
    });

    if (targetCalendars.length === 0) {
      // Caller hat keinen Zugriff auf Ziel-Kalender → leere Busy-Liste
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
        // CONFIDENTIAL → ausblenden für Caller (außer Caller ist Owner = Self-Query)
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
          // PRIVATE für Foreign-Caller → kein Subject
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
// v3.18.15: Privacy-Masking aktiv — Grantees sehen private Events nur als „Beschäftigt",
// confidential Events werden komplett ausgeblendet. Owner sieht alles unverändert.
calendarRouter.get('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const start = req.query['start'] ? new Date(String(req.query['start'])) : new Date();
  const end = req.query['end']
    ? new Date(String(req.query['end']))
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const calendarIdParam = req.query['calendarId'] as string | undefined;

  // Pro Kalender merken ob viewer Owner ist (für Masking-Entscheidung)
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

  // Masking: PRIVATE → details ersetzt durch "Beschäftigt"; CONFIDENTIAL → ausgeblendet
  const masked = events
    .map((ev) => maskEventForViewer(ev, ownerByCalendar.get(ev.calendarId) === true))
    .filter((ev): ev is NonNullable<typeof ev> => ev !== null);

  res.json(masked);
});

// POST /api/v1/calendar/events  (WRITE-Permission auf Ziel-Kalender)
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
  // v3.18.15: Privacy-Level (PUBLIC=Default, PRIVATE=nur Beschäftigt, CONFIDENTIAL=unsichtbar)
  classification: z.enum(['PUBLIC', 'PRIVATE', 'CONFIDENTIAL']).optional(),
  // v3.18.25 A5: Attendees (Mail-Adressen Gäste) — wenn nicht-leer wird iMIP-REQUEST versendet
  attendees: z.array(AttendeeSchema).max(100).optional(),
});

calendarRouter.post('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { calendarId, summary, dtStart, dtEnd, description = '', location = '', allDay, recurring, rrule, classification = 'PUBLIC', attendees = [] } = parsed.data;

  const access = await canAccessCalendar(userId, calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  // Organizer = aktueller User (Self-Lookup für displayName)
  const organizer = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true },
  });
  if (!organizer) { res.status(500).json({ error: 'Organizer-User nicht gefunden' }); return; }

  const icalData = buildIcal({
    summary, dtStart, dtEnd, description, location, allDay, classification,
    ...(rrule !== undefined ? { rrule } : {}),
  });

  // v3.18.25: UID mit Hostname-Suffix für globale Eindeutigkeit (RFC 5545 §3.8.4.7)
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  });
  const { randomUUID } = await import('node:crypto');
  const rawEventId = randomUUID();
  const uid = buildEventUid(rawEventId, settings?.publicHostname ?? 'coremail.local');

  // Attendees als JSON-Array speichern
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

  // v3.18.25 A5: iMIP-REQUEST an alle Attendees senden (fire-and-forget)
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

// PUT /api/v1/calendar/events/:id  (WRITE-Permission auf Kalender des Events)
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

  // v3.18.25 A5: Wenn relevante Felder geändert wurden → sequence++ +
  // neue REQUEST-Mails an alle Attendees senden. „Relevante" Felder sind alle
  // die in der iMIP-Mail erscheinen (summary, dtStart, dtEnd, location, attendees).
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

  // v3.18.25 A5: REQUEST-Update an Attendees senden (mit erhöhter SEQUENCE)
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

// DELETE /api/v1/calendar/events/:id  (WRITE-Permission auf Kalender des Events)
calendarRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  // v3.18.25 A5: Volle Event-Daten für CANCEL-Mail laden BEVOR Delete
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

  // v3.18.25 A5: CANCEL-Mails an alle Attendees (mit sequence+1)
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
