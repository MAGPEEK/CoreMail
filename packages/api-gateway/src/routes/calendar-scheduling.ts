/**
 * 9.4: scheduling assistant of the event form — rooms/resources with their
 * availability and meeting-time suggestions over the attendees' free/busy.
 * Mounted inside calendarRouter (authentication already done there).
 *
 *   GET  /calendar/rooms?start=&end=[&uid=]   rooms of the user's domain, `available` for the slot
 *   POST /calendar/schedule-suggestions        { attendees, rooms?, start, end, durationMinutes, workingHoursOnly? }
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { mergeBusy, suggestSlots, type BusyInterval, type WorkingHours } from '@coremail/core/free-busy';
import { busyForUser } from '../lib/calendar-busy.js';
import { listRooms } from '../lib/room-booking.js';
import { loadPreferences } from '../lib/preferences-store.js';

export const calendarSchedulingRouter: RouterType = Router();

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 31 * DAY_MS;

function parseWindow(startRaw: unknown, endRaw: unknown): { start: Date; end: Date } | null {
  const start = new Date(String(startRaw ?? ''));
  const end = new Date(String(endRaw ?? ''));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) return null;
  return { start, end };
}

const hhmmToMinutes = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

calendarSchedulingRouter.get('/rooms', async (req: Request, res: Response) => {
  const window = parseWindow(req.query['start'], req.query['end']);
  if (!window) { res.status(400).json({ error: 'Invalid date range (max 31 days)' }); return; }
  const uid = typeof req.query['uid'] === 'string' ? req.query['uid'] : undefined;
  res.json(await listRooms(req.apiUser!.domainId, window.start, window.end, uid));
});

const SuggestSchema = z.object({
  attendees: z.array(z.string().email()).max(50).default([]),
  rooms: z.array(z.string().email()).max(10).default([]),
  start: z.string(),
  end: z.string(),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  workingHoursOnly: z.boolean().default(true),
  /** UID of the meeting being edited — its own room bookings do not count. */
  uid: z.string().max(500).optional(),
});

calendarSchedulingRouter.post('/schedule-suggestions', async (req: Request, res: Response) => {
  const parsed = SuggestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const window = parseWindow(parsed.data.start, parsed.data.end);
  if (!window) { res.status(400).json({ error: 'Invalid date range (max 31 days)' }); return; }
  const callerId = req.apiUser!.userId;

  const emails = [...new Set([req.apiUser!.email.toLowerCase(), ...parsed.data.attendees.map((e) => e.toLowerCase())])];
  const users = await prisma.user.findMany({ where: { email: { in: emails }, active: true }, select: { id: true, email: true } });
  const busy: BusyInterval[][] = [];
  const unknown: string[] = [];
  for (const email of emails) {
    const user = users.find((u) => u.email.toLowerCase() === email);
    const info = user ? await busyForUser(callerId, user.id, window.start, window.end) : null;
    if (!info?.visible) { unknown.push(email); continue; }
    busy.push(mergeBusy(info.slots));
  }
  if (parsed.data.rooms.length > 0) {
    const wanted = new Set(parsed.data.rooms.map((e) => e.toLowerCase()));
    for (const room of await listRooms(req.apiUser!.domainId, window.start, window.end, parsed.data.uid)) {
      if (!wanted.has(room.email.toLowerCase())) continue;
      busy.push(room.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end), kind: b.kind })));
    }
  }

  const prefs = await loadPreferences(callerId);
  const workingHours: WorkingHours | undefined = parsed.data.workingHoursOnly
    ? {
        days: prefs.calendar.workDays,
        startMinute: hhmmToMinutes(prefs.calendar.workStart),
        endMinute: hhmmToMinutes(prefs.calendar.workEnd),
        timeZone: prefs.regional.timeZone,
      }
    : undefined;
  const slots = suggestSlots({
    busy, windowStart: window.start, windowEnd: window.end,
    durationMs: parsed.data.durationMinutes * 60_000,
    notBefore: new Date(),
    ...(workingHours ? { workingHours } : {}),
    max: 8,
  });
  res.json({
    suggestions: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString(), conflicts: s.conflicts, tentative: s.tentative })),
    // attendees without free/busy access (no share) or unknown addresses
    unknown,
  });
});
