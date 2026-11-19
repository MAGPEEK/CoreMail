/**
 * 9.4: rooms and resources in the event form — availability for a slot (listRooms) and
 * booking on save. A room the organizer adds is booked directly; its attendee entry
 * (CUTYPE=ROOM/RESOURCE) carries the answer, so no invitation mail goes to the room.
 * 9.5: the booking itself (bookRooms / refreshRoomBookings / releaseRooms) lives in storage
 * room-booking.ts — ActiveSync calendar writes book rooms the same way; the rules
 * (resource-booking-rules.ts) are the ones the mail path applies to invitations.
 */
import { prisma, bookingIntervals, ROOM_POLICY_SELECT, type BookingRow } from '@coremail/storage';
import { overlaps } from '@coremail/core/recurrence';
import type { BusyInterval } from '@coremail/core/free-busy';

export {
  bookingIntervals, bookRooms, conflictsWith, decideRoomBooking, isRoomAttendee, refreshRoomBookings, releaseRooms,
  type BookedRoom, type BookingRow, type MeetingToBook, type RoomBookingStatus, type RoomDecision, type RoomDeclineReason,
  type RoomPolicy,
} from '@coremail/storage';

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
