/**
 * Booking rooms and resources directly from a meeting the user writes — the event form
 * (api-gateway routes/calendar.ts) and ActiveSync calendar writes (activesync
 * pim/calendar-rooms.ts) go through the same functions (9.5: moved here from api-gateway
 * lib/room-booking.ts). A room the organizer adds is booked directly (conflict check against
 * the room's other bookings, recurring ones expanded, the policy the admin set in the BCP —
 * resource-booking-rules.ts, the same rules the mail path for invitations applies); its
 * attendee entry (CUTYPE=ROOM/RESOURCE) carries the answer.
 *
 * A booking belongs to its organizer: a booking row of the same UID written by another
 * organizer is never changed or removed (client-chosen UIDs — CalDAV, ActiveSync — must not
 * take over or cancel someone else's room).
 */
import { prisma } from './prisma/index.js';
import { checkLockedResourceBooking, conflictList, type RoomBookingStatus, type RoomDeclineReason } from './resource-booking-rules.js';
import { lockResourceCalendar } from './resource-lock.js';

/** Resource mailbox columns a booking decision needs (policy + calendar). */
export const ROOM_POLICY_SELECT = {
  id: true, email: true, displayName: true, resourceType: true, capacity: true, location: true, active: true,
  autoAccept: true, autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: true,
  bookingWindowDays: true, requireApproval: true, calendar: { select: { id: true } },
} as const;

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
  /** Organizer address; a booking of the same UID by another organizer is left alone. */
  organizer: string;
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  rrule: string | null;
  icalData: string;
}

const PARTSTAT: Record<RoomBookingStatus, BookedRoom['partstat']> = { ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED', PENDING: 'NEEDS-ACTION' };

/** Pure: an address as bookings compare it (no `mailto:`, lower case). */
export const bookingAddress = (address: string): string => address.trim().replace(/^mailto:/i, '').toLowerCase();

const lowerAll = (emails: readonly string[]): string[] => [...new Set(emails.map(bookingAddress))];

/** The given addresses that are rooms / resources of the domain (lower case); none without a domain. */
export async function roomMailboxAddresses(emails: readonly string[], domainId: string | null | undefined): Promise<Set<string>> {
  if (emails.length === 0 || !domainId) return new Set();
  const rows = await prisma.resourceMailbox.findMany({ where: { email: { in: lowerAll(emails) }, domainId }, select: { email: true } });
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/**
 * Book (or re-check) the given rooms for a meeting; returns their attendee entries.
 * Unknown or foreign-domain addresses are ignored. The booking row is keyed by the meeting
 * UID per room, so saving again updates it. Conflict check and write run in one transaction
 * under the room's booking lock (resource-lock.ts): of two concurrent bookings of the
 * same slot exactly one gets the room. `meeting.icalData` must be the meeting as it will be
 * stored — its DTSTART/RRULE/EXDATE/overrides decide which occurrences are checked. A room
 * whose booking of this UID belongs to another organizer answers DECLINED (conflict).
 */
export async function bookRooms(
  meeting: MeetingToBook,
  roomEmails: readonly string[],
  domainId: string | null | undefined,
  now = new Date(),
): Promise<BookedRoom[]> {
  // rooms belong to a domain: without one the user books none (never another domain's)
  if (roomEmails.length === 0 || !domainId) return [];
  const rooms = await prisma.resourceMailbox.findMany({
    where: { email: { in: lowerAll(roomEmails) }, domainId },
    select: ROOM_POLICY_SELECT,
  });
  const organizer = bookingAddress(meeting.organizer);
  const out: BookedRoom[] = [];
  for (const room of rooms) {
    if (!room.calendar) continue;
    const calendarId = room.calendar.id;
    const decision = await prisma.$transaction(async (tx) => {
      await lockResourceCalendar(tx, calendarId);
      // under the lock: the UID's booking of another organizer stays untouched
      const existing = await tx.resourceBooking.findUnique({ where: { calendarId_uid: { calendarId, uid: meeting.uid } }, select: { organizer: true } });
      if (existing && bookingAddress(existing.organizer) !== organizer) return { status: 'DECLINED' as const, reason: 'conflict' as const };
      const { decision: result, conflicts } = await checkLockedResourceBooking(tx, calendarId, room, meeting, now);
      const data = {
        summary: meeting.summary, organizer: meeting.organizer, dtStart: meeting.dtStart, dtEnd: meeting.dtEnd,
        status: result.status, icalData: meeting.icalData, conflicts: conflictList(conflicts),
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

/** The organizer's bookings of the meeting in the given rooms. */
const organizerBookings = (uid: string, roomEmails: readonly string[], organizer: string) => ({
  uid,
  organizer: { equals: bookingAddress(organizer), mode: 'insensitive' as const },
  calendar: { resource: { email: { in: lowerAll(roomEmails) } } },
});

/**
 * Store the meeting's new calendar data on the organizer's existing room bookings without a
 * new decision — an occurrence was deleted, so its slot is free again; the rooms' answers stay.
 */
export async function refreshRoomBookings(uid: string, roomEmails: readonly string[], icalData: string, organizer: string): Promise<void> {
  if (roomEmails.length === 0) return;
  await prisma.resourceBooking.updateMany({ where: organizerBookings(uid, roomEmails, organizer), data: { icalData } });
}

/** Remove the organizer's bookings of the meeting in the given rooms (room removed, meeting deleted). */
export async function releaseRooms(uid: string, roomEmails: readonly string[], organizer: string): Promise<void> {
  if (roomEmails.length === 0) return;
  await prisma.resourceBooking.deleteMany({ where: organizerBookings(uid, roomEmails, organizer) });
}

/** Attendee entries of a stored meeting that are rooms/resources (CUTYPE ROOM or RESOURCE). */
export function isRoomAttendee(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const cutype = String((a as Record<string, unknown>)['cutype'] ?? '').toUpperCase();
  return cutype === 'ROOM' || cutype === 'RESOURCE';
}
