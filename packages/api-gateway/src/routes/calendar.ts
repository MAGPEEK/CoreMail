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

export const calendarRouter: RouterType = Router();
calendarRouter.use(requireAuth);

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

  res.json({ ok: true });
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
});

calendarRouter.post('/events', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { calendarId, summary, dtStart, dtEnd, description = '', location = '', allDay, recurring, rrule, classification = 'PUBLIC' } = parsed.data;

  const access = await canAccessCalendar(userId, calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  const icalData = buildIcal({
    summary, dtStart, dtEnd, description, location, allDay, classification,
    ...(rrule !== undefined ? { rrule } : {}),
  });

  const { randomUUID } = await import('node:crypto');
  const event = await prisma.calendarEvent.create({
    data: {
      calendarId,
      uid: randomUUID(),
      summary,
      dtStart: new Date(dtStart),
      dtEnd: new Date(dtEnd),
      recurring,
      icalData,
      classification,
    },
  });
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
    select: { id: true, calendarId: true, summary: true, dtStart: true, dtEnd: true, recurring: true, classification: true },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  const { summary, dtStart, dtEnd, description, location, allDay, rrule, classification } = parsed.data;
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

  const updated = await prisma.calendarEvent.update({
    where: { id },
    data: {
      summary: summary ?? event.summary,
      dtStart: dtStart ? new Date(dtStart) : event.dtStart,
      dtEnd: dtEnd ? new Date(dtEnd) : event.dtEnd,
      recurring: !!rrule || event.recurring,
      icalData,
      classification: effectiveClass,
    },
  });
  res.json(updated);
});

// DELETE /api/v1/calendar/events/:id  (WRITE-Permission auf Kalender des Events)
calendarRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const { id } = req.params as { id: string };

  const event = await prisma.calendarEvent.findUnique({
    where: { id },
    select: { id: true, calendarId: true },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const access = await canAccessCalendar(userId, event.calendarId, 'WRITE');
  if (!access) { res.status(403).json({ error: 'Keine Schreibrechte für diesen Kalender' }); return; }

  await prisma.calendarEvent.delete({ where: { id } });
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
