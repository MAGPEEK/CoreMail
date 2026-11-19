/**
 * Admin routes — Resource Mailboxes (Rooms & Equipment) — Phase 7
 * GET/POST/PUT/DELETE /api/v1/admin/resources
 * GET                 /api/v1/admin/resources/:id/bookings
 * DELETE              /api/v1/admin/resources/:id/bookings/:bookingId
 *
 * w3 scope leaks (review): a scoped admin sees the organizer / attendees of a
 * booking from another hosted domain as "(andere Domain)" (redactBooking).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { allowAddress, allowDomain, redactorOf, scopeOf, scopeParam, targetInScope } from '../../middleware/admin-scope.js';
import { domainIdWhere, type AddressRedactor } from '../../lib/admin-scope.js';

export const adminResourcesRouter: RouterType = Router();
adminResourcesRouter.use(requireArea('recipients'));
// 9.5: a resource outside the admin's management scope is "not found" on every /:id route.
adminResourcesRouter.param('id', scopeParam('resource'));

/** iCalendar CN parameter (display name of an organizer / attendee). */
const ICAL_CN_RE = /;CN=(?:"[^"]*"|[^;:]*)/gi;

/**
 * Pure (w3 scope leaks, review): a booking as a scoped admin sees it — the
 * organizer, the attendees and every iCalendar line naming an address of
 * another hosted domain are redacted; such a line also loses its CN (display
 * name). The iCalendar text is unfolded for that. Organisation-wide: unchanged.
 */
export function redactBooking<T extends { organizer: string; attendees: unknown; icalData: string }>(r: AddressRedactor, b: T): T {
  if (!r.active) return b;
  const icalData = b.icalData.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
    .map((line) => (r.text(line) === line ? line : r.text(line.replace(ICAL_CN_RE, ''))))
    .join('\r\n');
  return { ...b, organizer: r.text(b.organizer), attendees: r.deep(b.attendees), icalData };
}

// ──────────────────────────────────────────────────────────
// Resource Mailboxes CRUD
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/resources
adminResourcesRouter.get('/', async (req: Request, res: Response) => {
  const { type } = req.query as { type?: string };
  const resources = await prisma.resourceMailbox.findMany({
    where: { ...domainIdWhere(scopeOf(req)), ...(type ? { resourceType: type === 'ROOM' ? 'ROOM' : 'EQUIPMENT' } : {}) },
    orderBy: { displayName: 'asc' },
  });
  res.json(resources);
});

// GET /api/v1/admin/resources/:id
adminResourcesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const resource = await prisma.resourceMailbox.findUnique({
    where: { id },
    include: { calendar: { include: { bookings: { orderBy: { dtStart: 'desc' }, take: 50 } } } },
  });
  if (!resource) { res.status(404).json({ error: 'Resource not found' }); return; }
  const redactor = await redactorOf(req);
  res.json(resource.calendar && redactor.active
    ? { ...resource, calendar: { ...resource.calendar, bookings: resource.calendar.bookings.map((b) => redactBooking(redactor, b)) } }
    : resource);
});

const CreateResourceSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  resourceType: z.enum(['ROOM', 'EQUIPMENT']).default('ROOM'),
  domainId: z.string(),
  capacity: z.number().int().positive().optional(),
  location: z.string().default(''),
  phone: z.string().default(''),
  autoAccept: z.boolean().default(true),
  autoDeclineConflict: z.boolean().default(true),
  allowRecurring: z.boolean().default(true),
  maxDurationMinutes: z.number().int().positive().optional(),
  bookingWindowDays: z.number().int().default(180),
  requireApproval: z.boolean().default(false),
  delegateIds: z.array(z.string()).default([]),
});

// POST /api/v1/admin/resources
adminResourcesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateResourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, displayName, resourceType, domainId, capacity, location, phone,
    autoAccept, autoDeclineConflict, allowRecurring, maxDurationMinutes,
    bookingWindowDays, requireApproval, delegateIds } = parsed.data;
  // 9.5: a scoped admin creates resources only in its own domains (domain and address)
  if (!allowDomain(req, res, domainId) || !allowAddress(req, res, email)) return;

  const existing = await prisma.resourceMailbox.findUnique({ where: { email } });
  if (existing) { res.status(409).json({ error: 'Email already in use' }); return; }

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  // Create mailbox + default folders + resource calendar in a transaction
  const resource = await prisma.$transaction(async (tx) => {
    const mailbox = await tx.mailbox.create({
      data: {
        folders: {
          create: [
            { name: 'INBOX', displayName: 'Inbox' },
            { name: 'Sent', displayName: 'Sent Items' },
            { name: 'Trash', displayName: 'Deleted Items' },
          ],
        },
      },
    });

    return tx.resourceMailbox.create({
      data: {
        email, displayName, resourceType, domainId,
        location, phone, autoAccept, autoDeclineConflict, allowRecurring,
        bookingWindowDays, requireApproval, delegateIds,
        mailboxId: mailbox.id,
        ...(capacity !== undefined ? { capacity } : {}),
        ...(maxDurationMinutes !== undefined ? { maxDurationMinutes } : {}),
        calendar: { create: {} },
      },
      include: { calendar: true },
    });
  });

  res.status(201).json(resource);
});

const UpdateResourceSchema = z.object({
  displayName: z.string().min(1).optional(),
  capacity: z.number().int().positive().optional(),
  location: z.string().optional(),
  phone: z.string().optional(),
  autoAccept: z.boolean().optional(),
  autoDeclineConflict: z.boolean().optional(),
  allowRecurring: z.boolean().optional(),
  maxDurationMinutes: z.number().int().positive().optional(),
  bookingWindowDays: z.number().int().optional(),
  requireApproval: z.boolean().optional(),
  delegateIds: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

// PUT /api/v1/admin/resources/:id
adminResourcesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = UpdateResourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const existing = await prisma.resourceMailbox.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Resource not found' }); return; }

  const { displayName, capacity, location, phone, autoAccept, autoDeclineConflict,
    allowRecurring, maxDurationMinutes, bookingWindowDays, requireApproval,
    delegateIds, active } = parsed.data;
  const resource = await prisma.resourceMailbox.update({
    where: { id },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(autoAccept !== undefined ? { autoAccept } : {}),
      ...(autoDeclineConflict !== undefined ? { autoDeclineConflict } : {}),
      ...(allowRecurring !== undefined ? { allowRecurring } : {}),
      ...(maxDurationMinutes !== undefined ? { maxDurationMinutes } : {}),
      ...(bookingWindowDays !== undefined ? { bookingWindowDays } : {}),
      ...(requireApproval !== undefined ? { requireApproval } : {}),
      ...(delegateIds !== undefined ? { delegateIds } : {}),
      ...(active !== undefined ? { active } : {}),
    },
  });
  res.json(resource);
});

// DELETE /api/v1/admin/resources/:id
adminResourcesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.resourceMailbox.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Resource not found' }); return; }
  await prisma.resourceMailbox.delete({ where: { id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────
// Bookings sub-resource
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/resources/:id/bookings?from=&to=
adminResourcesRouter.get('/:id/bookings', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { from, to } = req.query as { from?: string; to?: string };

  const resource = await prisma.resourceMailbox.findUnique({ where: { id } });
  if (!resource) { res.status(404).json({ error: 'Resource not found' }); return; }

  const cal = await prisma.resourceCalendar.findUnique({ where: { resourceId: id } });
  if (!cal) { res.json([]); return; }

  const bookings = await prisma.resourceBooking.findMany({
    where: {
      calendar: { resourceId: id },
      ...(from ? { dtStart: { gte: new Date(from) } } : {}),
      ...(to ? { dtEnd: { lte: new Date(to) } } : {}),
    },
    orderBy: { dtStart: 'asc' },
  });
  const redactor = await redactorOf(req);
  res.json(bookings.map((b) => redactBooking(redactor, b)));
});

// DELETE /api/v1/admin/resources/:id/bookings/:bookingId
adminResourcesRouter.delete('/:id/bookings/:bookingId', async (req: Request, res: Response) => {
  const { id, bookingId } = req.params as { id: string; bookingId: string };
  // 9.5: the booking must belong to the resource of the path (whose scope was checked)
  const booking = await prisma.resourceBooking.findFirst({ where: { id: bookingId, calendar: { resourceId: id } }, select: { id: true } });
  if (!booking) { res.status(404).json({ error: 'Booking not found' }); return; }
  await prisma.resourceBooking.delete({ where: { id: bookingId } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────
// Free/Busy query (public, no admin required)
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/resources/freebusy?email=&from=&to=
adminResourcesRouter.get('/freebusy/query', async (req: Request, res: Response) => {
  const { email, from, to } = req.query as { email?: string; from?: string; to?: string };
  if (!email || !from || !to) {
    res.status(400).json({ error: 'email, from and to are required' });
    return;
  }

  const resource = await prisma.resourceMailbox.findUnique({
    where: { email },
    include: { calendar: { include: {
      bookings: {
        where: {
          dtStart: { lt: new Date(to) },
          dtEnd: { gt: new Date(from) },
        },
        select: { dtStart: true, dtEnd: true, status: true },
      },
    } } },
  });

  // 9.5: a resource outside the admin's management scope is "not found"
  if (!resource || !resource.active || !(await targetInScope(req, 'resource', resource.id))) {
    res.status(404).json({ error: 'Resource not found' });
    return;
  }

  const busy = (resource.calendar?.bookings ?? [])
    .filter((b) => b.status !== 'DECLINED')
    .map((b) => ({ start: b.dtStart, end: b.dtEnd }));

  res.json({ email, displayName: resource.displayName, capacity: resource.capacity, busy });
});
