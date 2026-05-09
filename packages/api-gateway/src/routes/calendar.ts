import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

// GET /api/v1/calendar
calendarRouter.get('/', async (req: Request, res: Response) => {
  const prisma = getPrisma();
  const calendars = await prisma.calendar.findMany({
    where: { userId: req.apiUser!.userId },
    select: { id: true, name: true, color: true },
  });
  res.json(calendars);
});

// POST /api/v1/calendar
calendarRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({ name: z.string().min(1), color: z.string().default('#0078D4') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const calendar = await prisma.calendar.create({
    data: { userId: req.apiUser!.userId, name: parsed.data.name, color: parsed.data.color },
  });
  res.status(201).json(calendar);
});

// GET /api/v1/calendar/events?start=&end=&calendarId=
calendarRouter.get('/events', async (req: Request, res: Response) => {
  const start = req.query['start'] ? new Date(String(req.query['start'])) : new Date();
  const end = req.query['end']
    ? new Date(String(req.query['end']))
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const calendarId = req.query['calendarId'] as string | undefined;

  const prisma = getPrisma();
  const calendars = await prisma.calendar.findMany({ where: { userId: req.apiUser!.userId } });
  const calIds = calendarId
    ? calendars.filter((c) => c.id === calendarId).map((c) => c.id)
    : calendars.map((c) => c.id);

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

  const prisma = getPrisma();
  const calendar = await prisma.calendar.findFirst({
    where: { id: calendarId, userId: req.apiUser!.userId },
  });
  if (!calendar) { res.status(404).json({ error: 'Calendar not found' }); return; }

  const icalData = buildIcal({ summary, dtStart, dtEnd, description, location, allDay, rrule });

  const event = await prisma.calendarEvent.create({
    data: {
      calendarId,
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

  const prisma = getPrisma();
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
    rrule,
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
  const prisma = getPrisma();
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
