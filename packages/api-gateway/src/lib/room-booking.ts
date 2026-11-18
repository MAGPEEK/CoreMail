/**
 * 9.4: rooms and resources in the event form — availability for a slot and
 * booking on save. A room the organizer adds is booked directly (conflict check
 * against the room's other bookings, recurring ones expanded); its attendee
 * entry (CUTYPE=ROOM/RESOURCE) carries the answer, so no invitation mail goes to
 * the room. The rules follow the resource settings the admin set in the BCP
 * (auto-accept, decline on conflict, recurring allowed, max. duration, booking
 * window, approval) — the same ones the mail path (smtp-server
 * handlers/resource-booking.ts) applies to invitations from other clients.
 */
import { prisma, lockResourceCalendar } from '@coremail/storage';
import { expandStoredEvent, overlaps } from '@coremail/core/recurrence';
import { mergeBusy, type BusyInterval } from '@coremail/core/free-busy';

const DAY_MS = 86_400_000;
/** Occurrences of a recurring meeting checked for room conflicts (DoS guard). */
const MAX_CHECKED_OCCURRENCES = 400;

export interface RoomPolicy {
  active: boolean;
  autoAccept: boolean;
  autoDeclineConflict: boolean;
  allowRecurring: boolean;
  maxDurationMinutes: number | null;
  bookingWindowDays: number;
  requireApproval: boolean;
}

export type RoomBookingStatus = 'ACCEPTED' | 'DECLINED' | 'PENDING';
export type RoomDeclineReason = 'inactive' | 'recurring' | 'duration' | 'window' | 'conflict';

export interface RoomDecision {
  status: RoomBookingStatus;
  reason?: RoomDeclineReason;
}

/**
 * Pure: the answer of a room to a booking request. Policy violations and (with
 * "decline on conflict") conflicts decline; approval or no auto-accept leave the
 * request pending.
 */
export function decideRoomBooking(
  room: RoomPolicy,
  slot: { start: Date; end: Date; recurring: boolean },
  hasConflict: boolean,
  now: Date,
): RoomDecision {
  if (!room.active) return { status: 'DECLINED', reason: 'inactive' };
  if (slot.recurring && !room.allowRecurring) return { status: 'DECLINED', reason: 'recurring' };
  const minutes = (slot.end.getTime() - slot.start.getTime()) / 60_000;
  if (room.maxDurationMinutes !== null && minutes > room.maxDurationMinutes) return { status: 'DECLINED', reason: 'duration' };
  if (slot.start.getTime() > now.getTime() + room.bookingWindowDays * DAY_MS) return { status: 'DECLINED', reason: 'window' };
  if (hasConflict && room.autoDeclineConflict) return { status: 'DECLINED', reason: 'conflict' };
  if (room.requireApproval || !room.autoAccept) return { status: 'PENDING' };
  return { status: 'ACCEPTED' };
}

export interface BookingRow {
  uid: string;
  status: string;
  dtStart: Date;
  dtEnd: Date;
  icalData: string;
}

/** Pure: does the calendar data carry a recurrence rule (RRULE line)? */
const hasRrule = (icalData: string): boolean => /\nRRULE[:;]/i.test(icalData);

/** Pure: busy intervals of a room's bookings in [ws, we) — accepted and tentative only, recurring ones expanded. */
export function bookingIntervals(bookings: readonly BookingRow[], ws: Date, we: Date, excludeUid?: string): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const b of bookings) {
    if (b.uid === excludeUid) continue;
    const status = b.status.toUpperCase();
    if (status !== 'ACCEPTED' && status !== 'TENTATIVE') continue;
    const instances = expandStoredEvent(
      { dtStart: b.dtStart, dtEnd: b.dtEnd, allDay: false, recurring: hasRrule(b.icalData), rrule: null, icalData: b.icalData },
      ws, we,
    );
    for (const i of instances) out.push({ start: i.dtStart, end: i.dtEnd, kind: status === 'TENTATIVE' ? 'tentative' : 'busy' });
  }
  return mergeBusy(out);
}

/** Pure: does any instance of the meeting overlap a busy interval of the room? */
export function conflictsWith(instances: ReadonlyArray<{ dtStart: Date; dtEnd: Date }>, busy: readonly BusyInterval[]): boolean {
  return instances.some((i) => busy.some((b) => overlaps(i.dtStart, i.dtEnd, b.start, b.end)));
}

const ROOM_SELECT = {
  id: true, email: true, displayName: true, resourceType: true, capacity: true, location: true, active: true,
  autoAccept: true, autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: true,
  bookingWindowDays: true, requireApproval: true, calendar: { select: { id: true } },
} as const;

export interface RoomAvailability {
  id: string;
  email: string;
  displayName: string;
  resourceType: string;
  capacity: number | null;
  location: string;
  available: boolean;
  busy: Array<{ start: string; end: string; kind: BusyInterval['kind'] }>;
}

type BookingDb = Pick<typeof prisma, 'resourceBooking'>;

async function bookingsOf(db: BookingDb, calendarIds: string[], ws: Date, we: Date): Promise<Map<string, BookingRow[]>> {
  const rows = calendarIds.length === 0 ? [] : await db.resourceBooking.findMany({
    where: { calendarId: { in: calendarIds }, dtStart: { lt: we } },
    select: { calendarId: true, uid: true, status: true, dtStart: true, dtEnd: true, icalData: true },
  });
  const map = new Map<string, BookingRow[]>();
  for (const r of rows) map.set(r.calendarId, [...(map.get(r.calendarId) ?? []), r]);
  return map;
}

/** Active rooms/resources of the user's domain with their availability in [start, end). */
export async function listRooms(domainId: string | undefined, start: Date, end: Date, excludeUid?: string): Promise<RoomAvailability[]> {
  if (!domainId) return []; // never list other domains' rooms
  const rooms = await prisma.resourceMailbox.findMany({
    where: { active: true, domainId },
    select: ROOM_SELECT,
    orderBy: { displayName: 'asc' },
  });
  const bookings = await bookingsOf(prisma, rooms.flatMap((r) => (r.calendar ? [r.calendar.id] : [])), start, end);
  return rooms.map((r) => {
    const busy = bookingIntervals(r.calendar ? bookings.get(r.calendar.id) ?? [] : [], start, end, excludeUid);
    return {
      id: r.id, email: r.email, displayName: r.displayName, resourceType: r.resourceType,
      capacity: r.capacity, location: r.location,
      available: !busy.some((b) => b.kind !== 'tentative' && overlaps(b.start, b.end, start, end)),
      busy: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString(), kind: b.kind })),
    };
  });
}

export interface BookedRoom {
  email: string;
  cn: string;
  cutype: 'ROOM' | 'RESOURCE';
  partstat: 'ACCEPTED' | 'DECLINED' | 'NEEDS-ACTION';
  role: 'NON-PARTICIPANT';
  rsvp: false;
  reason?: RoomDeclineReason;
}

export interface MeetingToBook {
  uid: string;
  summary: string;
  organizer: string;
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  rrule: string | null;
  icalData: string;
}

const PARTSTAT: Record<RoomBookingStatus, BookedRoom['partstat']> = { ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED', PENDING: 'NEEDS-ACTION' };

/**
 * Book (or re-check) the given rooms for a meeting; returns their attendee
 * entries. Unknown or foreign-domain addresses are ignored. The booking row is
 * keyed by the meeting UID per room, so saving again updates it. Conflict check
 * and write run in one transaction under the room's booking lock
 * (lockResourceCalendar): of two concurrent bookings of the same slot exactly one
 * gets the room. `meeting.icalData` must be the meeting as it will be stored — its
 * DTSTART/RRULE/EXDATE/overrides decide which occurrences are checked.
 */
export async function bookRooms(
  meeting: MeetingToBook,
  roomEmails: readonly string[],
  domainId: string | undefined,
  now = new Date(),
): Promise<BookedRoom[]> {
  // rooms belong to a domain: without one the user books none (never another domain's)
  if (roomEmails.length === 0 || !domainId) return [];
  const rooms = await prisma.resourceMailbox.findMany({
    where: { email: { in: roomEmails.map((e) => e.toLowerCase()) }, domainId },
    select: ROOM_SELECT,
  });
  const recurring = meeting.rrule !== null || hasRrule(meeting.icalData);
  const windowEnd = (room: { bookingWindowDays: number }) => new Date(Math.max(meeting.dtEnd.getTime(), now.getTime() + room.bookingWindowDays * DAY_MS));
  const out: BookedRoom[] = [];
  for (const room of rooms) {
    if (!room.calendar) continue;
    const ws = meeting.dtStart;
    const we = windowEnd(room);
    const calendarId = room.calendar.id;
    const instances = expandStoredEvent(
      { dtStart: meeting.dtStart, dtEnd: meeting.dtEnd, allDay: meeting.allDay, recurring, rrule: meeting.rrule, icalData: meeting.icalData },
      ws, we,
    ).slice(0, MAX_CHECKED_OCCURRENCES);
    const decision = await prisma.$transaction(async (tx) => {
      await lockResourceCalendar(tx, calendarId);
      const bookings = (await bookingsOf(tx, [calendarId], ws, we)).get(calendarId) ?? [];
      const busy = bookingIntervals(bookings, ws, we, meeting.uid);
      const result = decideRoomBooking(room, { start: meeting.dtStart, end: meeting.dtEnd, recurring }, conflictsWith(instances, busy), now);
      const data = {
        summary: meeting.summary, organizer: meeting.organizer, dtStart: meeting.dtStart, dtEnd: meeting.dtEnd,
        status: result.status, icalData: meeting.icalData,
      };
      await tx.resourceBooking.upsert({
        where: { calendarId_uid: { calendarId, uid: meeting.uid } },
        create: { calendarId, uid: meeting.uid, ...data },
        update: data,
      });
      return result;
    });
    out.push({
      email: room.email, cn: room.displayName, cutype: room.resourceType === 'ROOM' ? 'ROOM' : 'RESOURCE',
      partstat: PARTSTAT[decision.status], role: 'NON-PARTICIPANT', rsvp: false,
      ...(decision.reason ? { reason: decision.reason } : {}),
    });
  }
  return out;
}

/**
 * Store the meeting's new calendar data on its existing room bookings without a
 * new decision — an occurrence was deleted, so its slot is free again; the rooms'
 * answers stay.
 */
export async function refreshRoomBookings(uid: string, roomEmails: readonly string[], icalData: string): Promise<void> {
  if (roomEmails.length === 0) return;
  await prisma.resourceBooking.updateMany({
    where: { uid, calendar: { resource: { email: { in: roomEmails.map((e) => e.toLowerCase()) } } } },
    data: { icalData },
  });
}

/** Remove the meeting's bookings of the given rooms (room removed from the meeting, meeting deleted). */
export async function releaseRooms(uid: string, roomEmails: readonly string[]): Promise<void> {
  if (roomEmails.length === 0) return;
  await prisma.resourceBooking.deleteMany({
    where: { uid, calendar: { resource: { email: { in: roomEmails.map((e) => e.toLowerCase()) } } } },
  });
}

/** Attendee entries of a stored meeting that are rooms/resources (CUTYPE ROOM or RESOURCE). */
export function isRoomAttendee(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const cutype = String((a as Record<string, unknown>)['cutype'] ?? '').toUpperCase();
  return cutype === 'ROOM' || cutype === 'RESOURCE';
}
