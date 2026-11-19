/**
 * Rooms of a meeting a phone writes (w3 review): the same booking path as the REST event
 * form (storage room-booking.ts — the resource policy, conflicts of every occurrence, the
 * booking lock). A room is an attendee whose address is a room / resource mailbox of the
 * user's domain, whatever AttendeeType the device gave it.
 *
 *  - Only the user's own meetings book (organizer = one of the user's addresses, or none);
 *    the user's copy of another organizer's meeting never touches a room.
 *  - Rooms are (re)booked when the room list or the timing (start, end, all-day, rule,
 *    exceptions) changed; a removed room is released; otherwise the stored answers stay.
 *  - The rooms' answers replace whatever the device sent for them (PARTSTAT, CUTYPE, role),
 *    so a phone cannot mark a declined room as accepted.
 */
import { parseCalendarObject, patchVEvent, type AttendeeInput, type ParsedVEvent } from '@coremail/core/calendar';
import { bookRooms, bookingAddress, isRoomAttendee, releaseRooms, roomMailboxAddresses } from '@coremail/storage';
import type { PimUser } from './types.js';

type ParsedEvent = { main: ParsedVEvent; overrides: ParsedVEvent[] };

/** Pure: is the meeting organised by the user (or has no organizer)? */
export function isOwnMeeting(main: Pick<ParsedVEvent, 'organizer'>, addresses: readonly string[]): boolean {
  return !main.organizer || addresses.includes(bookingAddress(main.organizer));
}

/** Pure: what decides a room's occurrences — start, end, all-day, rules and exceptions. */
export function timingKey(ev: ParsedEvent): string {
  const ms = (d: Date) => d.getTime();
  return JSON.stringify([
    ms(ev.main.start), ms(ev.main.end), ev.main.allDay, ev.main.rrule,
    ev.main.exdates.map((x) => ms(x.date)).sort(), ev.main.rdates.map((x) => ms(x.date)).sort(),
    ev.overrides.map((o) => [ms(o.recurrenceId!.date), ms(o.start), ms(o.end), o.status]).sort(),
  ]);
}

/** Pure: the attendee list with the rooms' entries in place of what the device sent for them. */
export function withRoomEntries(attendees: readonly AttendeeInput[], rooms: readonly AttendeeInput[]): AttendeeInput[] {
  const byEmail = new Map(rooms.map((r) => [bookingAddress(r.email), r]));
  const out = attendees.map((a) => byEmail.get(bookingAddress(a.email)) ?? a);
  return out.filter((a, i) => out.findIndex((b) => bookingAddress(b.email) === bookingAddress(a.email)) === i);
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The calendar object to store after a device write, with its rooms booked; `before` is the
 * stored object (null for a new event). Unchanged when the meeting books no room.
 */
export async function withRoomBookings(icalData: string, before: string | null, user: PimUser, now: Date): Promise<string> {
  const after = parseCalendarObject(icalData);
  const uid = after?.main.uid;
  if (!after || !uid || !isOwnMeeting(after.main, user.addresses)) return icalData;
  const prev = before ? parseCalendarObject(before) : null;
  const prevRooms = (prev?.main.attendees ?? []).filter(isRoomAttendee);
  const rooms = await roomMailboxAddresses([...after.main.attendees, ...prevRooms].map((a) => a.email), user.domainId);
  const wanted = [...new Set(after.main.attendees.map((a) => bookingAddress(a.email)).filter((e) => rooms.has(e)))];
  const held = prevRooms.map((a) => bookingAddress(a.email)).filter((e) => rooms.has(e));
  const organizer = after.main.organizer ?? user.email;

  const removed = held.filter((e) => !wanted.includes(e));
  if (removed.length > 0) await releaseRooms(uid, removed, organizer);
  if (wanted.length === 0) return icalData;

  const rebook = !prev || !sameSet(wanted, held) || timingKey(prev) !== timingKey(after);
  const entries: AttendeeInput[] = rebook
    ? await bookRooms({
        uid, summary: after.main.summary, organizer, dtStart: after.main.start, dtEnd: after.main.end,
        allDay: after.main.allDay, rrule: after.main.rrule, icalData,
      }, wanted, user.domainId, now)
    : prevRooms.filter((a) => wanted.includes(bookingAddress(a.email)));
  return patchVEvent(icalData, { attendees: withRoomEntries(after.main.attendees, entries) }) ?? icalData;
}

/** A deleted meeting of the user frees its rooms. */
export async function releaseMeetingRooms(icalData: string, user: PimUser): Promise<void> {
  const ev = parseCalendarObject(icalData);
  if (!ev?.main.uid || !isOwnMeeting(ev.main, user.addresses)) return;
  const rooms = ev.main.attendees.filter(isRoomAttendee).map((a) => a.email);
  await releaseRooms(ev.main.uid, rooms, ev.main.organizer ?? user.email);
}
