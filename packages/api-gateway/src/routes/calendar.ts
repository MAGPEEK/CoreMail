import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { patchSchema } from '../lib/zod-compat.js';
import { prisma, getProductName, announceCalendarChange, announceUserEvent } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import {
  canAccessCalendar,
  listAccessibleCalendars,
  stripGalPrefix,
  maskEventForViewer,
} from '../lib/calendar-access.js';
import { audit, auditContext } from '../lib/audit.js';
import { notifyUserInbox } from '../lib/internal-notify.js';
import { loadPreferences } from '../lib/preferences-store.js';
import { createBullMqConnection, type UserEventAction } from '@coremail/core';
import { announceOnWrite } from '../lib/realtime.js';
import { Queue } from 'bullmq';
import {
  enqueueInvitation,
  buildEventUid,
  type EventData,
  type AttendeeData,
} from '../lib/imip.js';
import {
  buildVCalendar, patchVEvent, normalizeAllDayRange, granteeMayWrite, parseCalendarObject, SHOW_AS_VALUES,
  stricterClassification,
  type AlarmSpec, type ShowAs, type VEventFields,
} from '@coremail/core/calendar';
import { excludeOccurrence, isSeriesOccurrence, upsertOccurrence } from '@coremail/core/calendar-exceptions';
import { expandStoredEvent } from '../lib/recurrence.js';
import { busyForUser, freeBusyDirectory } from '../lib/calendar-busy.js';
import { isOrganizerCopy } from '../lib/organizer-copy.js';
import { calendarSchedulingRouter } from './calendar-scheduling.js';

/**
 * Grantees only write events they see unmasked — the same rule as CalDAV (8.0.0,
 * `granteeView` in @coremail/core/calendar): PRIVATE/CONFIDENTIAL events AND PUBLIC
 * series with a PRIVATE/CONFIDENTIAL recurrence override are owner-only for writes.
 */
function isProtectedForGrantee(event: { classification: string | null; icalData?: string | null }): boolean {
  return !granteeMayWrite(event.icalData, event.classification);
}

/**
 * Resolve the REST date input into stored instants.
 *  - all-day: `YYYY-MM-DD` (only the date part of any ISO string is used — no UTC
 *    round-trip), stored as UTC midnight with an EXCLUSIVE end (start + 1 day minimum)
 *  - timed: ISO instants, end must not be before start
 * Returns null for invalid input.
 */
function resolveEventRange(
  dtStart: string,
  dtEnd: string,
  allDay: boolean,
): { start: Date; end: Date } | null {
  try {
    if (allDay) return normalizeAllDayRange(dtStart, dtEnd);
    const start = new Date(dtStart);
    const end = new Date(dtEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end.getTime() < start.getTime()) return null;
    return { start, end };
  } catch {
    return null;
  }
}

/** 9.4: reminder of the stored master VEVENT (owner views only — alarms are private). */
function eventReminder(icalData: string): { minutes: number; byMail: boolean } | null {
  const alarm = parseCalendarObject(icalData)?.main.alarm ?? null;
  return alarm ? { minutes: alarm.minutes, byMail: alarm.byMail === true } : null;
}

/** 9.4: VALARM spec from the REST fields (null = no reminder). */
function alarmFrom(minutes: number | null, byMail: boolean, ownerEmail: string): AlarmSpec | null {
  return minutes === null ? null : { minutes, ...(byMail ? { byMail: true, mailTo: ownerEmail } : {}) };
}

/** `?occurrence=<ISO>` of an occurrence-scoped request; undefined = the whole event, null = invalid. */
function occurrenceParam(req: Request): Date | null | undefined {
  const raw = req.query['occurrence'];
  if (raw === undefined) return undefined;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d;
}

/** Stored attendee list (JSON column) → its entries. */
function attendeeEntries(list: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(list) ? list : []).filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null);
}

interface OccurrenceView {
  dtStart: Date;
  dtEnd: Date;
  recurrenceId: string;
  override: { summary: string; description: string; location: string; showAs: ShowAs; classification: string } | null;
}

/** 9.4: one occurrence of a stored series as it is now (moved/changed by its override, if any). */
function occurrenceView(
  stored: { dtStart: Date; dtEnd: Date; allDay: boolean; recurring: boolean; rrule: string | null; icalData: string },
  occurrence: Date,
): OccurrenceView | null {
  const duration = stored.dtEnd.getTime() - stored.dtStart.getTime();
  // overrides may move the instance: search generously around the original start
  const ws = new Date(occurrence.getTime() - 62 * 86_400_000);
  const we = new Date(occurrence.getTime() + duration + 62 * 86_400_000);
  const inst = expandStoredEvent(stored, ws, we)
    .find((i) => i.recurrenceId !== null && new Date(i.recurrenceId).getTime() === occurrence.getTime());
  return inst ? { dtStart: inst.dtStart, dtEnd: inst.dtEnd, recurrenceId: inst.recurrenceId!, override: inst.override } : null;
}

/** Max. list window — protects the recurrence expansion (per event capped separately). */
const MAX_LIST_WINDOW_MS = 4 * 366 * 24 * 60 * 60 * 1000;

/**
 * Share lifecycle → live sync of owner and grantee (9.4 user events, v3.18.17
 * before). The grantee hears `create` / `delete` when they gained / lost the
 * calendar (the webmail shows a hint), everyone else an `update`.
 */
function announceShare(calendarId: string, ownerId: string, granteeId: string, granteeAction: UserEventAction): void {
  announceUserEvent(ownerId, { type: 'calendar', scope: 'shares', action: 'update', calendarIds: [calendarId] });
  announceUserEvent(granteeId, { type: 'calendar', scope: 'shares', action: granteeAction, calendarIds: [calendarId] });
}

export const calendarRouter: RouterType = Router();
calendarRouter.use(requireAuth);
// 9.4: the acting user's own calendar list (create, reorder, colours of shared
// calendars) reaches their other tabs; events, calendar edits and shares
// announce owner + grantees explicitly (announceCalendarChange / announceShare).
calendarRouter.use(announceOnWrite(({ method, path }) =>
  (method === 'POST' && (path === '/' || path === '/reorder')) || path.startsWith('/mine-shares/')
    ? { type: 'calendar', action: method === 'POST' && path === '/' ? 'create' : 'update' }
    : null));
// 9.4: meeting-time suggestions of the scheduling assistant
calendarRouter.use(calendarSchedulingRouter);

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
      // retry/retention per job from QueueSettings (lib/imip.ts → getOutboundJobOptions)
    });
  }
  return _outboundQueue;
}

/**
 * v3.18.25 A5: Sends iMIP invitations to all attendees (REQUEST or CANCEL).
 * Fire-and-forget — errors are logged but do not block the main path
 * (the event is already in the DB).
 */
/** 9.4: time zone of a local organizer (Settings → Region), '' when unknown. */
async function organizerTimeZone(email: string): Promise<string> {
  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase() }, select: { id: true } });
  return user ? (await loadPreferences(user.id)).regional.timeZone : '';
}

async function sendInvitations(opts: {
  ev: { id: string; uid: string; summary: string; description: string;
        location: string; dtStart: Date; dtEnd: Date; sequence: number;
        attendees: unknown; allDay?: boolean; rrule?: string | null;
        icalData?: string; showAs?: string };
  organizerEmail: string;
  organizerName: string;
  method: 'REQUEST' | 'CANCEL';
  /** 9.4: only this occurrence (its original start) changed / was cancelled. */
  recurrenceId?: Date;
}): Promise<void> {
  const attendees: AttendeeData[] = attendeeEntries(opts.ev.attendees)
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
  const timeZone = await organizerTimeZone(opts.organizerEmail);
  const exdates = opts.ev.icalData && opts.ev.rrule ? (parseCalendarObject(opts.ev.icalData)?.main.exdates ?? []).map((x) => x.date) : [];
  const showAs = opts.ev.showAs && (SHOW_AS_VALUES as readonly string[]).includes(opts.ev.showAs) ? opts.ev.showAs as ShowAs : undefined;

  const eventData: EventData = {
    uid: opts.ev.uid.includes('@') ? opts.ev.uid : buildEventUid(opts.ev.id, publicHostname),
    sequence: opts.ev.sequence,
    summary: opts.ev.summary,
    description: opts.ev.description,
    location: opts.ev.location,
    dtStart: opts.ev.dtStart,
    dtEnd: opts.ev.dtEnd,
    ...(opts.ev.allDay ? { allDay: true } : {}),
    ...(opts.ev.rrule ? { rrule: opts.ev.rrule } : {}),
    ...(exdates.length > 0 ? { exdates } : {}),
    ...(opts.recurrenceId ? { recurrenceId: opts.recurrenceId } : {}),
    ...(showAs ? { showAs } : {}),
    organizer: { email: opts.organizerEmail, cn: opts.organizerName },
    attendees,
    publicHostname,
    ...(timeZone ? { timeZone } : {}),
  };

  try {
    await enqueueInvitation({
      ev: eventData,
      method: opts.method,
      queue: getOutboundQueue(),
      trackingId: `imip-${opts.method}-${opts.ev.id}${opts.recurrenceId ? `-${opts.recurrenceId.getTime()}` : ''}`,
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
  announceCalendarChange([id], { action: 'update' });
  res.json(updated);
});

// DELETE /api/v1/calendar/:id  (owner only; default calendar protected)
calendarRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const cal = await prisma.calendar.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }
  if (cal.isDefault) { res.status(400).json({ error: 'Standard-Kalender kann nicht gelöscht werden' }); return; }
  const grantees = await prisma.calendarShare.findMany({ where: { calendarId: id }, select: { granteeId: true } });
  await prisma.calendar.delete({ where: { id } });
  announceUserEvent([cal.userId, ...grantees.map((g) => g.granteeId)], { type: 'calendar', action: 'delete', calendarIds: [id] });
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
  announceShare(id, userId, granteeId, share.createdAt.getTime() < Date.now() - 5000 ? 'update' : 'create');

  // v3.18.16 A1: notification mail in the grantee inbox — only for a *new* share,
  // not for a permission update via upsert (would be spam otherwise).
  const wasUpdate = share.createdAt.getTime() < Date.now() - 5000; // rough heuristic
  if (!wasUpdate) {
    const ownerName = req.apiUser!.email; // displayName could be looked up, KISS here
    const permLabel = parsed.data.permission === 'WRITE' ? 'Lesen und Schreiben' : 'Nur lesen';
    const productName = await getProductName(); // 9.3: branded product name
    void notifyUserInbox({
      recipientUserId: grantee.id,
      fromName: ownerName,
      fromAddr: req.apiUser!.email,
      subject: `${ownerName} hat den Kalender „${cal.name}" mit dir geteilt`,
      bodyText:
        `Hallo,\n\n` +
        `${ownerName} hat den Kalender „${cal.name}" mit dir geteilt.\n\n` +
        `Berechtigung: ${permLabel}\n\n` +
        `Du findest den Kalender ab sofort in deinem ${productName}-Kalender unter „Geteilt mit mir".\n\n` +
        `— ${productName}`,
      bodyHtml:
        `<p>Hallo,</p>` +
        `<p><strong>${escapeHtml(ownerName)}</strong> hat den Kalender ` +
        `<strong>„${escapeHtml(cal.name)}"</strong> mit dir geteilt.</p>` +
        `<p>Berechtigung: <strong>${permLabel}</strong></p>` +
        `<p>Du findest den Kalender ab sofort in deinem ${escapeHtml(productName)}-Kalender unter ` +
        `<em>Geteilt mit mir</em>.</p>` +
        `<p style="color:#888;font-size:12px">— ${escapeHtml(productName)}</p>`,
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

  announceShare(id, userId, updated.granteeId, 'update');

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

  announceShare(id, share.ownerId, share.granteeId, isOwnerAction ? 'delete' : 'update');

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
  // 9.4 review: only addresses the caller may know (own domain's address list, shares)
  const users = await freeBusyDirectory(req.apiUser!, parsed.data.userEmails);
  const usersByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  const result: Array<{
    email: string;
    displayName: string | null;
    found: boolean;
    /** 9.4: false = no access to this user's calendars (availability unknown, not free). */
    visible: boolean;
    busy: Array<{ start: string; end: string; type: 'busy' | 'tentative' | 'oof'; subject?: string }>;
  }> = [];

  for (const requestedEmail of parsed.data.userEmails) {
    const targetUser = usersByEmail.get(requestedEmail.toLowerCase());
    if (!targetUser) {
      result.push({ email: requestedEmail, displayName: null, found: false, visible: false, busy: [] });
      continue;
    }
    const info = await busyForUser(callerId, targetUser.id, start, end);
    result.push({
      email: requestedEmail,
      displayName: targetUser.displayName ?? null,
      found: true,
      visible: info.visible,
      busy: info.slots.map((s) => ({
        start: s.start.toISOString(), end: s.end.toISOString(), type: s.kind,
        ...(s.subject !== undefined ? { subject: s.subject } : {}),
      })),
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
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    res.status(400).json({ error: 'Invalid date range' });
    return;
  }
  if (end.getTime() - start.getTime() > MAX_LIST_WINDOW_MS) {
    res.status(400).json({ error: 'Range too large (max 4 years)' });
    return;
  }
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

  // Overlap semantics (dtStart < end AND dtEnd > start); recurring series are
  // loaded whenever they started before the window end and expanded server-side.
  const events = await prisma.calendarEvent.findMany({
    where: {
      calendarId: { in: calIds },
      dtStart: { lt: end },
      OR: [{ dtEnd: { gt: start } }, { recurring: true }, { rrule: { not: null } }],
    },
    orderBy: { dtStart: 'asc' },
  });

  // One entry per occurrence. Non-recurring events keep their shape; instances of a
  // series carry `recurrenceId` (original start) and `instanceId` = "<id>:<recurrenceId>".
  // `id` stays the series id so the edit dialog opens the master.
  const instances = events.flatMap((ev) =>
    expandStoredEvent(ev, start, end).map((inst) => ({
      ...ev,
      ...(inst.override ?? {}),
      // masking below: an override is never less private than its series
      classification: stricterClassification(ev.classification, inst.override?.classification),
      dtStart: inst.dtStart,
      dtEnd: inst.dtEnd,
      allDay: inst.allDay,
      recurrenceId: inst.recurrenceId,
      instanceId: inst.recurrenceId ? `${ev.id}:${inst.recurrenceId}` : ev.id,
    })),
  );
  instances.sort((a, b) => a.dtStart.getTime() - b.dtStart.getTime());

  // 9.4: reminders (for the webmail's reminder popups) — owners only, one parse per event
  const reminders = new Map(events
    .filter((ev) => ownerByCalendar.get(ev.calendarId) === true)
    .map((ev) => [ev.id, eventReminder(ev.icalData)] as const));

  // Masking: PRIVATE → details replaced by "Beschäftigt"; CONFIDENTIAL → hidden
  // The raw iCal is only returned to the owner (it would leak masked PRIVATE details).
  const masked = instances
    .map((ev) => {
      const isOwner = ownerByCalendar.get(ev.calendarId) === true;
      const { icalData, ...rest } = ev;
      return maskEventForViewer(isOwner ? { ...rest, icalData, reminder: reminders.get(ev.id) ?? null } : rest, isOwner);
    })
    .filter((ev): ev is NonNullable<typeof ev> => ev !== null);

  res.json(masked);
});

// v3.18.27 — GET /api/v1/calendar/events/:id (detail load for the edit dialog)
calendarRouter.get('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  const occurrence = occurrenceParam(req);
  if (occurrence === null) { res.status(400).json({ error: 'Invalid occurrence' }); return; }
  const stored = await prisma.calendarEvent.findUnique({
    where: { id },
    select: {
      id: true, uid: true, calendarId: true, summary: true, description: true,
      location: true, dtStart: true, dtEnd: true, allDay: true,
      recurring: true, rrule: true, classification: true, sequence: true,
      organizer: true, attendees: true, status: true, showAs: true, icalData: true,
    },
  });
  if (!stored) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, stored.calendarId, 'READ');
  if (!access) { res.status(403).json({ error: 'Keine Leserechte' }); return; }

  // 9.4: ?occurrence= → the occurrence's own data (override or master at that time)
  const { icalData, ...master } = stored;
  let event = { ...master, recurrenceId: null as string | null };
  if (occurrence) {
    const view = isSeriesOccurrence(icalData, occurrence) ? occurrenceView(stored, occurrence) : null;
    if (!view) { res.status(404).json({ error: 'Occurrence not found' }); return; }
    event = {
      ...event, ...(view.override ?? {}), dtStart: view.dtStart, dtEnd: view.dtEnd, recurrenceId: view.recurrenceId,
      classification: stricterClassification(master.classification, view.override?.classification),
    };
  }
  const reminder = access.isOwner ? eventReminder(icalData) : null;
  const extras = {
    reminderMinutes: reminder?.minutes ?? null,
    reminderByMail: reminder?.byMail ?? false,
  };

  // Masking for PRIVATE/CONFIDENTIAL for grantees (incl. a private override of a public series)
  if (!access.isOwner) {
    const cls = (event.classification ?? 'PUBLIC').toUpperCase();
    if (cls === 'CONFIDENTIAL') {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (cls === 'PRIVATE' || (occurrence && isProtectedForGrantee(stored))) {
      res.json({
        ...event,
        summary: 'Beschäftigt', description: '', location: '',
        attendees: [], organizer: null,
        ...extras,
        readOnly: true, canWrite: false,
      });
      return;
    }
  }

  res.json({
    ...event,
    ...extras,
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
  // RFC 5545 RECUR value (optionally prefixed with "RRULE:"); null/"" on PUT removes it
  rrule: z.string().max(500)
    .regex(/^(RRULE:)?FREQ=[A-Za-z0-9=;,:+-]+$/i, 'Invalid RRULE').or(z.literal('')).nullable().optional(),
  // v3.18.15: privacy level (PUBLIC=default, PRIVATE=busy only, CONFIDENTIAL=invisible)
  classification: z.enum(['PUBLIC', 'PRIVATE', 'CONFIDENTIAL']).optional(),
  // v3.18.25 A5: attendees (guest mail addresses) — if non-empty an iMIP REQUEST is sent
  attendees: z.array(AttendeeSchema).max(100).optional(),
  // 9.4: reminder (VALARM) minutes before the start; null = none; omitted on create =
  // the user's default reminder (Settings → Kalender). PUT keeps the stored alarms.
  reminderMinutes: z.number().int().min(0).max(40320).nullable().optional(),
  // 9.4: the reminder also as an e-mail to the owner (VALARM ACTION:EMAIL)
  reminderByMail: z.boolean().optional(),
  // 9.4: "Anzeigen als"
  showAs: z.enum(['FREE', 'TENTATIVE', 'BUSY', 'OOF']).optional(),
});

calendarRouter.post('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { calendarId, summary, dtStart, dtEnd, description = '', location = '', allDay, recurring, rrule, classification = 'PUBLIC', attendees = [] } = parsed.data;
  const reminderMinutes = parsed.data.reminderMinutes === undefined
    ? (await loadPreferences(userId)).calendar.defaultReminderMinutes
    : parsed.data.reminderMinutes;

  const access = await canAccessCalendar(userId, calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  // Organizer = current user (self-lookup for displayName)
  const organizer = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true },
  });
  if (!organizer) { res.status(500).json({ error: 'Organizer-User nicht gefunden' }); return; }

  const range = resolveEventRange(dtStart, dtEnd, allDay);
  if (!range) { res.status(400).json({ error: 'Invalid date range' }); return; }
  const rruleValue = rrule ? rrule.replace(/^RRULE:/i, '').toUpperCase() : null;

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
  const showAs: ShowAs = parsed.data.showAs ?? 'BUSY';

  const icalData = buildVCalendar({
    uid, summary, description, location, allDay, classification, showAs,
    start: range.start, end: range.end,
    sequence: 0,
    ...(rruleValue ? { rrule: rruleValue } : {}),
    organizer: { email: organizer.email, ...(organizer.displayName ? { cn: organizer.displayName } : {}) },
    attendees: attendeesJson,
    alarm: alarmFrom(reminderMinutes, parsed.data.reminderByMail === true, organizer.email),
  });

  const event = await prisma.calendarEvent.create({
    data: {
      calendarId,
      uid,
      summary,
      description,
      location,
      dtStart: range.start,
      dtEnd: range.end,
      allDay,
      recurring: recurring || rruleValue !== null,
      rrule: rruleValue,
      icalData,
      classification,
      showAs,
      organizer: organizer.email,
      attendees: attendeesJson as object[],
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

  announceCalendarChange([event.calendarId], { action: 'create', ids: [event.id] });
  res.status(201).json(event);
});

// PUT /api/v1/calendar/events/:id  (WRITE permission on the event's calendar)
calendarRouter.put('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };
  const parsed = patchSchema(EventSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const occurrence = occurrenceParam(req);
  if (occurrence === null) { res.status(400).json({ error: 'Invalid occurrence' }); return; }

  const event = await prisma.calendarEvent.findUnique({
    where: { id },
    select: EVENT_WRITE_SELECT,
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }
  // v7.1.0: a grantee only sees PRIVATE events masked (and CONFIDENTIAL ones not at all) —
  // saving that copy would overwrite the owner's real data, so it may not write them.
  if (!access.isOwner && isProtectedForGrantee(event)) {
    res.status(403).json({ error: 'Private Termine kann nur der Eigentümer ändern' });
    return;
  }
  // 9.5: an attendee's copy of someone else's meeting changes only itself — no
  // invitation update in the organizer's name
  const organizerCopy = await isOrganizerCopy(event.organizer, { userId, email: req.apiUser!.email, calendarOwnerId: access.ownerId });
  if (occurrence) {
    await updateOccurrence(res, event, occurrence, parsed.data, organizerCopy);
    return;
  }

  const { summary, dtStart, dtEnd, description, location, allDay, rrule, classification, attendees } = parsed.data;
  const effectiveClass = classification ?? event.classification ?? 'PUBLIC';

  // Dates: only re-resolved when the client sent date or all-day fields; the
  // missing half comes from the stored row (all-day stays date-only, no UTC drift).
  const effectiveAllDay = allDay ?? event.allDay;
  const datesTouched = dtStart !== undefined || dtEnd !== undefined || allDay !== undefined;
  let range = { start: event.dtStart, end: event.dtEnd };
  if (datesTouched) {
    const r = resolveEventRange(
      dtStart ?? event.dtStart.toISOString(),
      dtEnd ?? event.dtEnd.toISOString(),
      effectiveAllDay,
    );
    if (!r) { res.status(400).json({ error: 'Invalid date range' }); return; }
    range = r;
  }
  // rrule: undefined = keep, null/"" = remove, string = set
  const effectiveRrule = rrule === undefined
    ? event.rrule
    : (rrule ? rrule.replace(/^RRULE:/i, '').toUpperCase() : null);

  const storedAttendees = attendeeEntries(event.attendees);
  const newAttendees: Array<Record<string, unknown>> = attendees
    ? attendees.map((a) => ({
        email: a.email,
        cn: a.cn ?? a.email,
        partstat: a.partstat ?? 'NEEDS-ACTION',
        role: 'REQ-PARTICIPANT',
        rsvp: true,
      }))
    : storedAttendees;

  const attendeeKey = (list: unknown): string => JSON.stringify(
    (Array.isArray(list) ? list : [])
      .map((a) => String((a as Record<string, unknown>)['email'] ?? '').toLowerCase())
      .sort(),
  );

  // v3.18.25 A5: if relevant fields changed → sequence++ and send new
  // REQUEST mails to all attendees. „Relevant" fields are all those that
  // appear in the iMIP mail (summary, dates, location, recurrence, attendees).
  const willSendUpdate =
    (summary !== undefined && summary !== event.summary) ||
    range.start.getTime() !== event.dtStart.getTime() ||
    range.end.getTime() !== event.dtEnd.getTime() ||
    effectiveAllDay !== event.allDay ||
    effectiveRrule !== event.rrule ||
    (location !== undefined && location !== event.location) ||
    (attendees !== undefined && attendeeKey(newAttendees) !== attendeeKey(storedAttendees));
  const newSequence = event.sequence + (willSendUpdate ? 1 : 0);
  const attendeesChanged = attendees !== undefined;

  // 9.4: reminder (owner only — alarms are the calendar owner's) and show-as
  const currentAlarm = eventReminder(event.icalData);
  const alarmTouched = access.isOwner && (parsed.data.reminderMinutes !== undefined || parsed.data.reminderByMail !== undefined);
  const alarm = alarmTouched
    ? alarmFrom(
        parsed.data.reminderMinutes === undefined ? currentAlarm?.minutes ?? null : parsed.data.reminderMinutes,
        parsed.data.reminderByMail ?? currentAlarm?.byMail ?? false,
        req.apiUser!.email,
      )
    : undefined;

  // Patch the stored iCal instead of regenerating it: RRULE/EXDATE/VALARM/TZID/
  // X-properties written by CalDAV clients survive a REST edit.
  const patch: VEventFields = {
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(datesTouched ? { start: range.start, end: range.end, allDay: effectiveAllDay } : {}),
    ...(rrule !== undefined ? { rrule: effectiveRrule } : {}),
    ...(classification !== undefined ? { classification: effectiveClass } : {}),
    ...(parsed.data.showAs !== undefined ? { showAs: parsed.data.showAs } : {}),
    ...(alarm !== undefined ? { alarm } : {}),
    sequence: newSequence,
  };
  const attendeeList = newAttendees as Array<{ email: string; cn?: string; partstat?: string }>;
  const icalData = patchVEvent(event.icalData, {
    ...patch, ...(attendeesChanged ? { attendees: attendeeList } : {}),
  }) ?? buildVCalendar({
    uid: event.uid,
    summary: summary ?? event.summary,
    description: description ?? event.description,
    location: location ?? event.location,
    start: range.start,
    end: range.end,
    allDay: effectiveAllDay,
    classification: effectiveClass,
    sequence: newSequence,
    ...(effectiveRrule ? { rrule: effectiveRrule } : {}),
    ...(event.organizer ? { organizer: { email: event.organizer } } : {}),
    attendees: attendeeList,
    ...(parsed.data.showAs !== undefined ? { showAs: parsed.data.showAs } : {}),
    ...(alarm ? { alarm } : {}),
  });

  const updated = await prisma.calendarEvent.update({
    where: { id },
    data: {
      summary: summary ?? event.summary,
      description: description ?? event.description,
      location: location ?? event.location,
      dtStart: range.start,
      dtEnd: range.end,
      allDay: effectiveAllDay,
      rrule: effectiveRrule,
      recurring: effectiveRrule !== null || (rrule === undefined && event.recurring),
      icalData,
      classification: effectiveClass,
      ...(parsed.data.showAs !== undefined ? { showAs: parsed.data.showAs } : {}),
      ...(attendeesChanged ? { attendees: newAttendees as object[] } : {}),
      sequence: newSequence,
    },
  });

  // v3.18.25 A5: send REQUEST update to the attendees (with incremented SEQUENCE);
  // never from an attendee's copy
  if (willSendUpdate && organizerCopy) void notifyAttendees(updated, 'REQUEST');

  announceCalendarChange([event.calendarId], { action: 'update', ids: [id] });
  res.json(updated);
});

// DELETE /api/v1/calendar/events/:id  (WRITE permission on the event's calendar)
calendarRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  const occurrence = occurrenceParam(req);
  if (occurrence === null) { res.status(400).json({ error: 'Invalid occurrence' }); return; }

  // v3.18.25 A5: load full event data for the CANCEL mail BEFORE delete
  const event = await prisma.calendarEvent.findUnique({ where: { id }, select: EVENT_WRITE_SELECT });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }
  if (!access.isOwner && isProtectedForGrantee(event)) {
    res.status(403).json({ error: 'Private Termine kann nur der Eigentümer löschen' });
    return;
  }
  // 9.5: deleting an attendee's copy of someone else's meeting removes only that copy —
  // nobody gets a cancellation in the organizer's name
  const organizerCopy = await isOrganizerCopy(event.organizer, { userId, email: req.apiUser!.email, calendarOwnerId: access.ownerId });

  // 9.4: "only this occurrence" → EXDATE on the series, CANCEL for that occurrence
  if (occurrence) {
    const view = isSeriesOccurrence(event.icalData, occurrence) ? occurrenceView(event, occurrence) : null;
    const icalData = view ? excludeOccurrence(event.icalData, occurrence) : null;
    if (!view || !icalData) { res.status(404).json({ error: 'Occurrence not found' }); return; }
    const updated = await prisma.calendarEvent.update({ where: { id }, data: { icalData, sequence: event.sequence + 1 } });
    announceCalendarChange([event.calendarId], { action: 'update', ids: [id] });
    if (organizerCopy) void notifyAttendees(updated, 'CANCEL', { ...occurrenceFields(view, event), recurrenceId: occurrence });
    res.json({ ok: true });
    return;
  }

  await prisma.calendarEvent.delete({ where: { id } });
  announceCalendarChange([event.calendarId], { action: 'delete', ids: [id] });
  // v3.18.25 A5: CANCEL mails to all attendees (with sequence+1)
  if (organizerCopy) void notifyAttendees({ ...event, sequence: event.sequence + 1 }, 'CANCEL');

  res.json({ ok: true });
});

const EVENT_WRITE_SELECT = {
  id: true, calendarId: true, summary: true, description: true, location: true,
  uid: true, dtStart: true, dtEnd: true, allDay: true, recurring: true, rrule: true,
  classification: true, sequence: true, organizer: true, attendees: true, icalData: true, showAs: true,
} as const;

type StoredEvent = {
  id: string; calendarId: string; summary: string; description: string; location: string; uid: string;
  dtStart: Date; dtEnd: Date; allDay: boolean; recurring: boolean; rrule: string | null; classification: string;
  sequence: number; organizer: string | null; attendees: unknown; icalData: string; showAs: string;
};

/** iMIP to the attendees of a meeting; no-op without attendees. */
async function notifyAttendees(
  ev: StoredEvent,
  method: 'REQUEST' | 'CANCEL',
  occurrence?: Pick<StoredEvent, 'summary' | 'description' | 'location' | 'dtStart' | 'dtEnd'> & { recurrenceId: Date },
): Promise<void> {
  if (!ev.organizer || attendeeEntries(ev.attendees).length === 0) return;
  // called fire-and-forget: a failed lookup must not become an unhandled rejection
  const organizerUser = await prisma.user.findFirst({ where: { email: ev.organizer }, select: { displayName: true } })
    .catch(() => null);
  await sendInvitations({
    ev: occurrence ? { ...ev, ...occurrence } : ev,
    organizerEmail: ev.organizer,
    organizerName: organizerUser?.displayName ?? ev.organizer,
    method,
    ...(occurrence ? { recurrenceId: occurrence.recurrenceId } : {}),
  });
}

/** Text + time fields of one occurrence (override values, else the master's). */
function occurrenceFields(view: OccurrenceView, master: StoredEvent) {
  return {
    summary: view.override?.summary ?? master.summary,
    description: view.override?.description ?? master.description,
    location: view.override?.location ?? master.location,
    dtStart: view.dtStart,
    dtEnd: view.dtEnd,
  };
}

/**
 * 9.4: PUT ?occurrence= — change one occurrence (override with RECURRENCE-ID).
 * Text, time, show-as and classification of the occurrence; recurrence, attendees
 * and the reminder belong to the series and are not changed here. The attendees
 * are notified from the organizer's copy only (9.5); an attendee's copy changes
 * only itself and notifies nobody.
 */
async function updateOccurrence(
  res: Response,
  event: StoredEvent,
  occurrence: Date,
  data: { [K in keyof z.infer<typeof EventSchema>]?: z.infer<typeof EventSchema>[K] | undefined },
  organizerCopy: boolean,
): Promise<void> {
  const view = isSeriesOccurrence(event.icalData, occurrence) ? occurrenceView(event, occurrence) : null;
  if (!view) { res.status(404).json({ error: 'Occurrence not found' }); return; }
  const allDay = data.allDay ?? event.allDay;
  const datesTouched = data.dtStart !== undefined || data.dtEnd !== undefined || data.allDay !== undefined;
  const range = datesTouched
    ? resolveEventRange(data.dtStart ?? view.dtStart.toISOString(), data.dtEnd ?? view.dtEnd.toISOString(), allDay)
    : { start: view.dtStart, end: view.dtEnd };
  if (!range) { res.status(400).json({ error: 'Invalid date range' }); return; }

  const sequence = event.sequence + 1;
  const icalData = upsertOccurrence(event.icalData, occurrence, {
    ...(data.summary !== undefined ? { summary: data.summary } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.location !== undefined ? { location: data.location } : {}),
    ...(datesTouched ? { start: allDay ? range.start.toISOString().slice(0, 10) : range.start, end: allDay ? range.end.toISOString().slice(0, 10) : range.end, allDay } : {}),
    ...(data.showAs !== undefined ? { showAs: data.showAs } : {}),
    ...(data.classification !== undefined ? { classification: data.classification } : {}),
    sequence,
  });
  if (!icalData) { res.status(404).json({ error: 'Occurrence not found' }); return; }
  const updated = await prisma.calendarEvent.update({ where: { id: event.id }, data: { icalData, sequence } });
  const changed = occurrenceView(updated, occurrence) ?? view;
  announceCalendarChange([event.calendarId], { action: 'update', ids: [event.id] });
  if (organizerCopy) void notifyAttendees(updated, 'REQUEST', { ...occurrenceFields(changed, updated), recurrenceId: occurrence });
  res.json({ ...updated, recurrenceId: occurrence.toISOString(), dtStart: changed.dtStart, dtEnd: changed.dtEnd });
}

