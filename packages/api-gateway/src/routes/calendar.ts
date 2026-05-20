import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const calendarRouter: RouterType = Router();
calendarRouter.use(requireAuth);

// GET /api/v1/calendar
calendarRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const sel    = { id: true, name: true, color: true, icon: true, sortOrder: true, isDefault: true } as const;

  let calendars = await prisma.calendar.findMany({
    where:   { userId },
    select:  sel,
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  // Lazy provisioning: falls noch kein Kalender existiert → Default-Kalender anlegen.
  // Gilt für bestehende Accounts die vor der Provisioning-Logik erstellt wurden.
  if (calendars.length === 0) {
    const defaultCal = await prisma.calendar.create({
      data:   { userId, name: 'Kalender', color: '#0078D4', isDefault: true, sortOrder: 0 },
      select: sel,
    });
    calendars = [defaultCal];
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
  // sortOrder = letzte Position
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

// PATCH /api/v1/calendar/:id
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

// DELETE /api/v1/calendar/:id  (Default-Kalender kann nicht gelöscht werden)
calendarRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const cal = await prisma.calendar.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!cal) { res.status(404).json({ error: 'Kalender nicht gefunden' }); return; }
  if (cal.isDefault) { res.status(400).json({ error: 'Standard-Kalender kann nicht gelöscht werden' }); return; }
  await prisma.calendar.delete({ where: { id } });
  res.json({ ok: true });
});

// POST /api/v1/calendar/reorder  Body: { ids: string[] }
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

// GET /api/v1/calendar/events?start=&end=&calendarId=
calendarRouter.get('/events', async (req: Request, res: Response) => {
  const start = req.query['start'] ? new Date(String(req.query['start'])) : new Date();
  const end = req.query['end']
    ? new Date(String(req.query['end']))
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const calendarId = req.query['calendarId'] as string | undefined;

  
  const calendars = await prisma.calendar.findMany({ where: { userId: req.apiUser!.userId } });
  const calIds = calendarId
    ? calendars.filter((c: { id: string }) => c.id === calendarId).map((c: { id: string }) => c.id)
    : calendars.map((c: { id: string }) => c.id);

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId: { in: calIds }, dtStart: { gte: start }, dtEnd: { lte: end } },
    orderBy: { dtStart: 'asc' },
  });
  res.json(events);
});

// POST /api/v1/calendar/events
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
});

calendarRouter.post('/events', async (req: Request, res: Response) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { calendarId, summary, dtStart, dtEnd, description = '', location = '', allDay, recurring, rrule } = parsed.data;

  
  const calendar = await prisma.calendar.findFirst({
    where: { id: calendarId, userId: req.apiUser!.userId },
  });
  if (!calendar) { res.status(404).json({ error: 'Calendar not found' }); return; }

  const icalData = buildIcal({ summary, dtStart, dtEnd, description, location, allDay, ...(rrule !== undefined ? { rrule } : {}) });

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
    },
  });
  res.status(201).json(event);
});

// PUT /api/v1/calendar/events/:id
calendarRouter.put('/events/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = EventSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendar: { userId: req.apiUser!.userId } },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  const { summary, dtStart, dtEnd, description, location, allDay, rrule } = parsed.data;
  const icalData = buildIcal({
    summary: summary ?? event.summary,
    dtStart: dtStart ?? event.dtStart.toISOString(),
    dtEnd: dtEnd ?? event.dtEnd.toISOString(),
    description: description ?? '',
    location: location ?? '',
    allDay: allDay ?? false,
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
    },
  });
  res.json(updated);
});

// DELETE /api/v1/calendar/events/:id
calendarRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendar: { userId: req.apiUser!.userId } },
  });
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }
  await prisma.calendarEvent.delete({ where: { id } });
  res.json({ ok: true });
});

function buildIcal(opts: {
  summary: string; dtStart: string; dtEnd: string;
  description: string; location: string; allDay: boolean; rrule?: string;
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
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
