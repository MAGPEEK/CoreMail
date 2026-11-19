/**
 * 9.4: rooms and resources in the event form — availability for a slot (listRooms) and
 * booking on save. A room the organizer adds is booked directly; its attendee entry
 * (CUTYPE=ROOM/RESOURCE) carries the answer, so no invitation mail goes to the room.
 * 9.5: the booking itself (bookRooms / refreshRoomBookings / releaseRooms) lives in storage
 * room-booking.ts — ActiveSync calendar writes book rooms the same way; the rules
 * (resource-booking-rules.ts) are the ones the mail path applies to invitations.
 */
import { prisma, bookingAddress, bookingIntervals, ROOM_POLICY_SELECT, type BookingRow } from '@coremail/storage';
import { overlaps } from '@coremail/core/recurrence';
import type { BusyInterval } from '@coremail/core/free-busy';

export {
  bookingIntervals, bookRooms, conflictsWith, decideRoomBooking, isRoomAttendee, refreshRoomBookings, releaseRooms,
  type BookedRoom, type BookingRow, type MeetingToBook, type RoomBookingStatus, type RoomDecision, type RoomDeclineReason,
  type RoomPolicy,
} from '@coremail/storage';

export interface MeetingWriter {
  /** The acting user (id + login address). */
  userId: string;
  email: string;
  /** Owner of the calendar the event is stored in (the acting user, or the one who granted WRITE). */
  calendarOwnerId: string;
}

/**
 * Is the stored event the organizer's own copy of the meeting? True without organizer (an
 * appointment), when the organizer is the acting user, or when it is the owner of the
 * calendar the event lives in (the acting user is that owner or a delegate with WRITE) —
 * own addresses and active aliases count. Only that copy books, rebooks or releases rooms
 * and sends invitations / cancellations; an attendee's copy of someone else's meeting
 * changes (or deletes) only itself.
 */
export async function isOrganizerCopy(organizer: string | null, writer: MeetingWriter): Promise<boolean> {
  if (!organizer) return true;
  const address = bookingAddress(organizer);
  if (bookingAddress(writer.email) === address) return true;
  if (writer.calendarOwnerId !== writer.userId) {
    const owner = await prisma.user.findUnique({ where: { id: writer.calendarOwnerId }, select: { email: true } });
    if (owner && bookingAddress(owner.email) === address) return true;
  }
  const alias = await prisma.emailAlias.findFirst({
    where: { targetUserId: { in: [...new Set([writer.userId, writer.calendarOwnerId])] }, active: true, address: { equals: address, mode: 'insensitive' } },
    select: { id: true },
  });
  return alias !== null;
}

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
    select: ROOM_POLICY_SELECT,
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
