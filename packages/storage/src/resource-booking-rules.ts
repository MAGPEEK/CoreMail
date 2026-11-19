/**
 * Resource (room/equipment) booking rules — shared by the event form (api-gateway
 * lib/room-booking.ts) and the invitation mail path (smtp-server
 * handlers/resource-booking.ts), so both answer a booking request the same way:
 *
 *  - the resource policy the admin set in the BCP (active, recurring allowed, max.
 *    duration, booking window, decline conflicts, approval / auto-accept)
 *  - conflicts: every occurrence of the requested meeting (series expanded with its
 *    EXDATEs and RECURRENCE-ID overrides, within the booking horizon, capped) against
 *    the resource's accepted / tentative bookings (recurring ones expanded as well)
 *
 * {@link checkResourceBooking} takes the resource's booking lock first; the caller
 * writes the booking in the same transaction, so of two concurrent bookings of the
 * same slot exactly one gets the resource.
 */
import { expandStoredEvent, overlaps } from '@coremail/core/recurrence';
import { mergeBusy, type BusyInterval } from '@coremail/core/free-busy';
import { lockResourceCalendar, type ResourceLockTx } from './resource-lock.js';
import type { Prisma } from '@prisma/client';

const DAY_MS = 86_400_000;
/** Occurrences of a recurring meeting checked for conflicts (DoS guard). */
export const MAX_CHECKED_OCCURRENCES = 400;
/** The booking horizon never reaches further than a year, whatever the booking window says. */
export const MAX_HORIZON_DAYS = 366;
/** Conflicting occurrences stored with a booking (ResourceBooking.conflicts). */
export const MAX_LISTED_CONFLICTS = 50;

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
export type RoomDeclineReason = 'inactive' | 'recurring' | 'too-frequent' | 'duration' | 'window' | 'conflict';

export interface RoomDecision {
  status: RoomBookingStatus;
  reason?: RoomDeclineReason;
}

/**
 * Pure: the answer of a resource to a booking request. Policy violations and (with
 * "decline on conflict") conflicts decline; approval or no auto-accept leave the
 * request pending.
 */
export function decideRoomBooking(
  room: RoomPolicy,
  slot: { start: Date; end: Date; recurring: boolean; /** repeats more than daily (isBookableRecurrence) */ tooFrequent?: boolean },
  hasConflict: boolean,
  now: Date,
): RoomDecision {
  if (!room.active) return { status: 'DECLINED', reason: 'inactive' };
  if (slot.recurring && !room.allowRecurring) return { status: 'DECLINED', reason: 'recurring' };
  if (slot.recurring && slot.tooFrequent === true) return { status: 'DECLINED', reason: 'too-frequent' };
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
export const hasRrule = (icalData: string): boolean => /\nRRULE[:;]/i.test(icalData);

/** Rule parts that repeat a meeting several times a day (more than one value). */
const SUB_DAY_PARTS = /^BY(HOUR|MINUTE|SECOND)=.*,/;
const AT_MOST_DAILY = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Pure: one recurrence rule repeats at most daily (FREQ DAILY…YEARLY, one BYHOUR / BYMINUTE / BYSECOND value at most). */
function ruleAtMostDaily(rrule: string): boolean {
  const parts = rrule.trim().replace(/^RRULE:/i, '').toUpperCase().split(';');
  const freq = parts.find((p) => p.startsWith('FREQ='))?.slice('FREQ='.length) ?? '';
  return AT_MOST_DAILY.has(freq) && !parts.some((p) => SUB_DAY_PARTS.test(p));
}

/**
 * Pure: every recurrence rule of the meeting repeats at most daily. A denser series
 * (FREQ=HOURLY/MINUTELY/SECONDLY, several times a day) is no room booking, and its
 * expansion runs from the series start on every later check of the resource, growing
 * with time (DoS guard): such a request is declined, such a stored booking blocks its
 * first slot only.
 */
export function isBookableRecurrence(meeting: { rrule: string | null; icalData: string }): boolean {
  const unfolded = meeting.icalData.replace(/\r?\n[ \t]/g, '');
  const rules = [...unfolded.matchAll(/^RRULE(?:;[^:\r\n]*)?:([^\r\n]*)$/gim)].map((m) => m[1] ?? '');
  if (meeting.rrule !== null) rules.push(meeting.rrule);
  return rules.every(ruleAtMostDaily);
}

/** Pure: busy intervals of a resource's bookings in [ws, we) — accepted and tentative only, recurring ones expanded. */
export function bookingIntervals(bookings: readonly BookingRow[], ws: Date, we: Date, excludeUid?: string): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const b of bookings) {
    if (b.uid === excludeUid) continue;
    const status = b.status.toUpperCase();
    if (status !== 'ACCEPTED' && status !== 'TENTATIVE') continue;
    const recurring = hasRrule(b.icalData) && isBookableRecurrence({ rrule: null, icalData: b.icalData });
    const instances = expandStoredEvent(
      { dtStart: b.dtStart, dtEnd: b.dtEnd, allDay: false, recurring, rrule: null, icalData: b.icalData },
      ws, we,
    );
    for (const i of instances) out.push({ start: i.dtStart, end: i.dtEnd, kind: status === 'TENTATIVE' ? 'tentative' : 'busy' });
  }
  return mergeBusy(out);
}

export interface Occurrence { dtStart: Date; dtEnd: Date }

/** Pure: the occurrences of the meeting that overlap a busy interval of the resource. */
export function conflictingOccurrences(instances: readonly Occurrence[], busy: readonly BusyInterval[]): Occurrence[] {
  return instances.filter((i) => busy.some((b) => overlaps(i.dtStart, i.dtEnd, b.start, b.end)));
}

/** Pure: does any instance of the meeting overlap a busy interval of the resource? */
export function conflictsWith(instances: readonly Occurrence[], busy: readonly BusyInterval[]): boolean {
  return conflictingOccurrences(instances, busy).length > 0;
}

export interface MeetingToCheck {
  uid: string;
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  rrule: string | null;
  /** The meeting as it will be stored: its DTSTART/RRULE/EXDATE/overrides decide the occurrences. */
  icalData: string;
}

/** Pure: is the meeting a series (RRULE column or RRULE in its calendar data)? */
export function isRecurringMeeting(meeting: Pick<MeetingToCheck, 'rrule' | 'icalData'>): boolean {
  return meeting.rrule !== null || hasRrule(meeting.icalData);
}

/**
 * Pure: the window checked for conflicts — from the meeting start to the end of the
 * resource's booking window (at most a year ahead), never before the meeting's end.
 */
export function bookingHorizon(room: Pick<RoomPolicy, 'bookingWindowDays'>, meeting: Pick<MeetingToCheck, 'dtStart' | 'dtEnd'>, now: Date): { start: Date; end: Date } {
  const days = Math.min(Math.max(room.bookingWindowDays, 0), MAX_HORIZON_DAYS);
  return { start: meeting.dtStart, end: new Date(Math.max(meeting.dtEnd.getTime(), now.getTime() + days * DAY_MS)) };
}

/** Pure: the meeting's occurrences in the horizon (series expanded, EXDATE / overrides applied, capped). */
export function meetingOccurrences(meeting: MeetingToCheck, horizon: { start: Date; end: Date }): Occurrence[] {
  // a too dense series is declined anyway: its first slot only, never its expansion
  const expand = isRecurringMeeting(meeting) && isBookableRecurrence(meeting);
  return expandStoredEvent(
    { dtStart: meeting.dtStart, dtEnd: meeting.dtEnd, allDay: meeting.allDay, recurring: expand, rrule: expand ? meeting.rrule : null, icalData: meeting.icalData },
    horizon.start, horizon.end,
  ).slice(0, MAX_CHECKED_OCCURRENCES).map((i) => ({ dtStart: i.dtStart, dtEnd: i.dtEnd }));
}

/** Stored form of conflicting occurrences (ResourceBooking.conflicts). */
export function conflictList(conflicts: readonly Occurrence[]): Array<{ start: string; end: string }> {
  return conflicts.slice(0, MAX_LISTED_CONFLICTS).map((c) => ({ start: c.dtStart.toISOString(), end: c.dtEnd.toISOString() }));
}

export type ResourceBookingTx = ResourceLockTx & Pick<Prisma.TransactionClient, 'resourceBooking'>;

export interface ResourceCheck {
  decision: RoomDecision;
  /** Occurrences of the meeting that overlap other bookings of the resource. */
  conflicts: Occurrence[];
}

/**
 * Take the resource's booking lock, then decide the request against the resource's
 * other bookings. Call inside a transaction and write the booking with the same `tx`.
 */
export async function checkResourceBooking(
  tx: ResourceBookingTx,
  calendarId: string,
  room: RoomPolicy,
  meeting: MeetingToCheck,
  now: Date,
): Promise<ResourceCheck> {
  await lockResourceCalendar(tx, calendarId);
  return checkLockedResourceBooking(tx, calendarId, room, meeting, now);
}

/**
 * {@link checkResourceBooking} for a caller that already holds the resource's booking
 * lock in `tx` (it read the booking it changes under the lock as well).
 */
export async function checkLockedResourceBooking(
  tx: ResourceBookingTx,
  calendarId: string,
  room: RoomPolicy,
  meeting: MeetingToCheck,
  now: Date,
): Promise<ResourceCheck> {
  const horizon = bookingHorizon(room, meeting, now);
  const rows = await tx.resourceBooking.findMany({
    where: { calendarId, dtStart: { lt: horizon.end } },
    select: { uid: true, status: true, dtStart: true, dtEnd: true, icalData: true },
  });
  const busy = bookingIntervals(rows, horizon.start, horizon.end, meeting.uid);
  const conflicts = conflictingOccurrences(meetingOccurrences(meeting, horizon), busy);
  const decision = decideRoomBooking(
    room,
    { start: meeting.dtStart, end: meeting.dtEnd, recurring: isRecurringMeeting(meeting), tooFrequent: !isBookableRecurrence(meeting) },
    conflicts.length > 0,
    now,
  );
  return { decision, conflicts };
}
