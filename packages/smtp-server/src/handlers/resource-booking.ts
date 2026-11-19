/**
 * Resource (room/equipment) mailboxes: auto-accept/decline of calendar
 * invitations. Runs for every delivery path — port 25 inbound, SMTP
 * submission and the outbound worker (MWA/REST, JMAP, EAS) — from
 * storeInboundMessage() when the recipient is a resource mailbox.
 *
 * Bookings belong to ONE resource (its ResourceCalendar): a REQUEST/CANCEL
 * never touches another resource's booking with the same UID.
 *
 * Organizer identity (v8.1 review): the iCal ORGANIZER (mailto), else the
 * header From — never the envelope sender (SRS/VERP return paths of mailing
 * lists and forwarders never equal the organizer). The identity counts as
 * authenticated when its domain is aligned with a verified domain of the
 * inbound filter (DMARC/SPF/DKIM) or when it is the authenticated local sender.
 * An existing booking is updated or cancelled only by its stored organizer,
 * and only when authenticated. A new booking from an unauthenticated sender is
 * stored as PENDING (manual approval) instead of being auto-accepted.
 *
 * 9.5: the request is decided by the same rules as a booking from the event form
 * (storage resource-booking-rules.ts): the resource policy, and conflicts of EVERY
 * occurrence of a recurring meeting (EXDATE / RECURRENCE-ID overrides applied, within
 * the booking horizon, capped) with the resource's other bookings, recurring ones
 * expanded. Conflicting occurrences are stored with the booking — the reason of a
 * decline, or listed with the acceptance when the resource does not decline
 * conflicts. A REQUEST or CANCEL for single occurrences (RECURRENCE-ID only) updates
 * or removes those occurrences of the stored series instead of the whole booking; a
 * declined occurrence update declines those occurrences only (cancelled exceptions,
 * the series keeps its answer).
 *
 * 9.5: a decided REQUEST is answered with an iMIP REPLY to the organizer
 * (handlers/resource-reply.ts, unless the resource's `sendReplies` is off or a loop
 * rule forbids it); REPLY / COUNTER / DECLINECOUNTER / REFRESH sent to a resource are ignored.
 */
import { createLogger } from '@coremail/core';
import {
  getProperty, parseDateProperty, parseIcal, parseVEventComponent, serializeComponent,
  type IcalComponent, type ParsedVEvent,
} from '@coremail/core/calendar';
import { excludeOccurrence } from '@coremail/core/calendar-exceptions';
import {
  prisma, checkLockedResourceBooking, conflictList, extractCalendarParts, isAttendeeAuthenticated, lockResourceCalendar,
  type ResourceBookingTx, type ResourceCheck, type SenderAuth,
} from '@coremail/storage';
import { answerOrganizer, type BookingAnswer } from './resource-reply.js';

const log = createLogger('smtp:resource-booking');

export function bareAddress(addr: string): string {
  const m = /<([^>]*)>/.exec(addr);
  return (m ? m[1]! : addr).trim().replace(/^mailto:/i, '').toLowerCase();
}

/** Pure: the address of the (unfolded) RFC 5322 From header, '' when none. */
export function headerFromAddress(raw: Buffer): string {
  let end = raw.indexOf('\r\n\r\n');
  if (end < 0) end = raw.indexOf('\n\n');
  const head = raw.subarray(0, end >= 0 ? end : Math.min(raw.length, 64 * 1024)).toString('utf8').replace(/\r?\n(?=[ \t])/g, '');
  const m = /^From[ \t]*:(.*)$/im.exec(head);
  if (!m) return '';
  const value = m[1]!;
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(value);
  const plain = /([^\s<>",;:()]+@[^\s<>",;:()]+)/.exec(value);
  return (angle?.[1] ?? plain?.[1] ?? '').toLowerCase();
}

/** Pure: the ORGANIZER mailto address of a VCALENDAR text (unfolded), '' when none. */
export function icalOrganizer(ical: string): string {
  const unfolded = ical.replace(/\r?\n[ \t]/g, '');
  const line = /^ORGANIZER[;:].*$/im.exec(unfolded)?.[0];
  if (!line) return '';
  const m = /mailto:([^\s;"]+)\s*$/i.exec(line) ?? /mailto:([^\s;"]+)/i.exec(line);
  return (m?.[1] ?? '').toLowerCase();
}

/**
 * Pure: who organizes the meeting and whether that identity is authenticated.
 * Identity = iCal ORGANIZER, else header From (never the envelope sender).
 */
export function organizerIdentity(
  ical: string,
  raw: Buffer,
  senderAuth: SenderAuth | null,
): { organizer: string; authenticated: boolean } {
  const fromHeader = headerFromAddress(raw);
  const organizer = icalOrganizer(ical) || fromHeader;
  if (!organizer || !organizer.includes('@')) return { organizer: '', authenticated: false };
  let authenticated = isAttendeeAuthenticated(organizer, senderAuth);
  // An authenticated local sender (submission / worker): its header From was
  // checked against its sender identities — that identity is authenticated too.
  if (!authenticated && senderAuth?.authenticatedSender && fromHeader && organizer === fromHeader) {
    authenticated = true;
  }
  return { organizer, authenticated };
}

/** The calendar object of the message (decoded text/calendar part, legacy inline VCALENDAR). */
function findCalendar(raw: Buffer): string | null {
  const text = raw.toString('utf8');
  for (const part of extractCalendarParts(text)) {
    const m = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i.exec(part);
    if (m) return m[0];
  }
  return /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i.exec(text)?.[0] ?? null;
}

/** An invitation: its method and UID, the series master (null when only occurrences are sent). */
export interface Invitation {
  method: string;
  uid: string;
  master: ParsedVEvent | null;
  /** RECURRENCE-IDs of the single occurrences the message carries. */
  recurrenceIds: Date[];
}

function vevents(root: IcalComponent): IcalComponent[] {
  return root.components.filter((c) => c.name === 'VEVENT');
}

function recurrenceIdOf(c: IcalComponent, root: IcalComponent): Date | null {
  const p = getProperty(c, 'RECURRENCE-ID');
  return p ? parseDateProperty(p, root)?.date ?? null : null;
}

/** Pure: the invitation of a VCALENDAR; null without VEVENT or without exactly one UID. */
export function parseInvitation(icalData: string): Invitation | null {
  const root = parseIcal(icalData);
  if (!root || root.name !== 'VCALENDAR') return null;
  const events = vevents(root);
  const uids = new Set(events.map((c) => getProperty(c, 'UID')?.value.trim() ?? ''));
  const uid = [...uids][0];
  if (events.length === 0 || uids.size !== 1 || !uid) return null;
  const masterComp = events.find((c) => !getProperty(c, 'RECURRENCE-ID'));
  return {
    method: (getProperty(root, 'METHOD')?.value.trim().toUpperCase()) || 'REQUEST',
    uid,
    master: masterComp ? parseVEventComponent(masterComp, root) : null,
    recurrenceIds: events.flatMap((c) => { const rid = recurrenceIdOf(c, root); return rid ? [rid] : []; }),
  };
}

/** Marks an occurrence exception the resource declined (the series itself stays booked). */
export const DECLINED_MARK = 'X-RESOURCE-DECLINED';

/** The occurrence as a cancelled exception the resource declined. */
function declinedException(occ: IcalComponent): IcalComponent {
  const properties = occ.properties.filter((p) => p.name !== 'STATUS' && p.name !== DECLINED_MARK);
  properties.push({ name: 'STATUS', params: {}, value: 'CANCELLED' }, { name: DECLINED_MARK, params: {}, value: 'TRUE' });
  return { ...occ, properties };
}

/**
 * Pure: the stored series with the occurrences of an update (VEVENTs with
 * RECURRENCE-ID) replaced or added, plus VTIMEZONEs the series lacks. Null when the
 * stored object is no series master or either side is unreadable.
 *
 * `declined`: the resource declines these occurrences — each is stored as a cancelled
 * exception (STATUS:CANCELLED + {@link DECLINED_MARK}): neither its original slot nor the
 * slot it was moved to blocks the resource, the rest of the series stays booked. A later
 * update of the occurrence replaces the exception and is checked again.
 */
export function applyOccurrenceUpdates(stored: string, incoming: string, opts: { declined?: boolean } = {}): string | null {
  const root = parseIcal(stored);
  const update = parseIcal(incoming);
  if (!root || !update || !vevents(root).some((c) => !getProperty(c, 'RECURRENCE-ID'))) return null;
  for (const occ of vevents(update)) {
    const rid = recurrenceIdOf(occ, update)?.getTime();
    if (rid === undefined) continue;
    const entry = opts.declined ? declinedException(occ) : occ;
    const at = root.components.findIndex((c) => c.name === 'VEVENT' && recurrenceIdOf(c, root)?.getTime() === rid);
    if (at >= 0) root.components[at] = entry;
    else root.components.push(entry);
  }
  const zones = new Set(root.components.filter((c) => c.name === 'VTIMEZONE').map((c) => getProperty(c, 'TZID')?.value));
  for (const tz of update.components.filter((c) => c.name === 'VTIMEZONE' && !zones.has(getProperty(c, 'TZID')?.value))) {
    root.components.unshift(tz);
  }
  return serializeComponent(root) + '\r\n';
}

/** Pure: the stored series without the cancelled occurrences (EXDATE); null when it is no series. */
export function cancelOccurrences(stored: string, recurrenceIds: readonly Date[]): string | null {
  let text: string | null = stored;
  for (const rid of recurrenceIds) {
    text = text ? excludeOccurrence(text, rid) : null;
  }
  return recurrenceIds.length > 0 ? text : null;
}

interface MeetingRequest {
  uid: string;
  summary: string;
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  rrule: string | null;
  icalData: string;
}

/** Pure: the meeting to book from its calendar data (series master, else the single occurrence). */
export function meetingFromCalendar(uid: string, icalData: string): MeetingRequest | null {
  const root = parseIcal(icalData);
  if (!root) return null;
  const events = vevents(root);
  const comp = events.find((c) => !getProperty(c, 'RECURRENCE-ID')) ?? events[0];
  const main = comp ? parseVEventComponent(comp, root) : null;
  if (!main) return null;
  return {
    uid, summary: main.summary.trim() || 'Meeting', dtStart: main.start, dtEnd: main.end,
    allDay: main.allDay, rrule: main.rrule, icalData,
  };
}

type Booking = NonNullable<Awaited<ReturnType<typeof prisma.resourceBooking.findUnique>>>;
type Resource = NonNullable<Awaited<ReturnType<typeof findResource>>>;
type BookingTx = ResourceBookingTx;

function findResource(email: string) {
  return prisma.resourceMailbox.findFirst({
    where: { email: email.toLowerCase(), active: true },
    include: { calendar: true },
  });
}

/** What an invitation did to the resource's booking (for the log and the answer). */
export type Outcome =
  | { kind: 'refused' }
  | { kind: 'unusable' }
  | { kind: 'cancelled'; occurrences: number }
  | { kind: 'pending' }
  | { kind: 'decided'; check: ResourceCheck }
  | { kind: 'occurrences-declined'; check: ResourceCheck; occurrences: number };

/** CANCEL: the whole booking, or only the cancelled occurrences of the stored series. */
async function cancelBooking(tx: BookingTx, existing: Booking, invite: Invitation): Promise<Outcome> {
  const remaining = invite.master ? null : cancelOccurrences(existing.icalData, invite.recurrenceIds);
  if (remaining) {
    await tx.resourceBooking.update({ where: { id: existing.id }, data: { icalData: remaining } });
    return { kind: 'cancelled', occurrences: invite.recurrenceIds.length };
  }
  await tx.resourceBooking.delete({ where: { id: existing.id } });
  return { kind: 'cancelled', occurrences: 0 };
}

/** Write the answer to the booking read under the lock. A decline of an existing booking keeps its previous slot data. */
async function writeBooking(
  tx: BookingTx,
  existing: Booking | null,
  calendarId: string,
  meeting: MeetingRequest,
  organizer: string,
  status: 'ACCEPTED' | 'DECLINED' | 'PENDING',
  conflicts: ResourceCheck['conflicts'],
): Promise<void> {
  const listed = conflictList(conflicts);
  if (existing) {
    await tx.resourceBooking.update({
      where: { id: existing.id },
      data: status === 'DECLINED'
        ? { status, conflicts: listed }
        : { dtStart: meeting.dtStart, dtEnd: meeting.dtEnd, summary: meeting.summary, status, icalData: meeting.icalData, conflicts: listed },
    });
    return;
  }
  await tx.resourceBooking.create({
    data: {
      calendarId, uid: meeting.uid, summary: meeting.summary, organizer, dtStart: meeting.dtStart, dtEnd: meeting.dtEnd,
      status, icalData: meeting.icalData, conflicts: listed,
    },
  });
}

/**
 * One invitation for one resource, in one transaction under the resource's booking
 * lock: the booking is read, the organizer checked, the series merged / cancelled,
 * the rules applied and the answer written on the same row state — two invitations
 * for the same slot never both get the resource, two occurrence updates of one series
 * never overwrite each other, and a booking created meanwhile is never taken over.
 * An unauthenticated organizer's new request waits for approval.
 */
function handleInvitation(
  resource: Resource,
  calendarId: string,
  invite: Invitation,
  icalData: string,
  organizer: string,
  authenticated: boolean,
  now: Date,
): Promise<Outcome> {
  return prisma.$transaction(async (tx): Promise<Outcome> => {
    await lockResourceCalendar(tx, calendarId);
    // v8.1: UIDs are unique per resource calendar — only this resource's booking is
    // read, changed or deleted here.
    const existing = await tx.resourceBooking.findUnique({ where: { calendarId_uid: { calendarId, uid: invite.uid } } });
    if (existing && !(authenticated && bareAddress(existing.organizer) === organizer)) return { kind: 'refused' };
    if (invite.method === 'CANCEL') return existing ? cancelBooking(tx, existing, invite) : { kind: 'unusable' };

    // Occurrences only: they change the stored series (a new booking is just that occurrence)
    const meetingIcal = !invite.master && existing ? applyOccurrenceUpdates(existing.icalData, icalData) : icalData;
    const meeting = meetingIcal ? meetingFromCalendar(invite.uid, meetingIcal) : null;
    if (!meeting) return { kind: 'unusable' };
    if (!authenticated) {
      await writeBooking(tx, null, calendarId, meeting, organizer, 'PENDING', []);
      return { kind: 'pending' };
    }
    const check = await checkLockedResourceBooking(tx, calendarId, resource, meeting, now);
    const declinedSeries = !invite.master && existing && check.decision.status === 'DECLINED'
      ? applyOccurrenceUpdates(existing.icalData, icalData, { declined: true })
      : null;
    if (existing && declinedSeries) {
      // A declined occurrence update declines those occurrences only: the series keeps its answer
      await tx.resourceBooking.update({ where: { id: existing.id }, data: { icalData: declinedSeries, conflicts: conflictList(check.conflicts) } });
      return { kind: 'occurrences-declined', check, occurrences: invite.recurrenceIds.length };
    }
    await writeBooking(tx, existing, calendarId, meeting, organizer, check.decision.status, check.conflicts);
    return { kind: 'decided', check };
  });
}

function logOutcome(outcome: Outcome, ctx: Record<string, unknown>): void {
  switch (outcome.kind) {
    case 'refused': log.warn(ctx, 'Resource booking change refused — not the authenticated organizer'); return;
    case 'unusable': log.info(ctx, 'Resource invitation without a usable VEVENT or booking — ignored'); return;
    case 'pending': log.info(ctx, 'Resource booking pending approval — organizer not authenticated'); return;
    case 'cancelled':
      log.info({ ...ctx, occurrences: outcome.occurrences }, outcome.occurrences > 0 ? 'Resource booking: occurrences cancelled' : 'Resource booking cancelled');
      return;
    case 'decided': {
      const { decision, conflicts } = outcome.check;
      const conflictDates = conflicts.map((c) => c.dtStart.toISOString());
      if (decision.status === 'DECLINED') log.info({ ...ctx, reason: decision.reason, conflicts: conflictDates }, 'Resource booking declined');
      else log.info({ ...ctx, status: decision.status, conflicts: conflictDates }, 'Resource booking decided');
      return;
    }
    case 'occurrences-declined': {
      const { decision, conflicts } = outcome.check;
      log.info({ ...ctx, reason: decision.reason, occurrences: outcome.occurrences, conflicts: conflicts.map((c) => c.dtStart.toISOString()) },
        'Resource booking: occurrence update declined — the series stays booked');
    }
  }
}

/**
 * Processes the calendar invitation of `rawMessage` for every resource mailbox
 * among `rcptTo`. `mailFrom` is kept for the log only. Returns the resource
 * addresses that were recognised (whether or not the message carried an
 * invitation).
 */
export async function processResourceMailboxes(
  rawMessage: Buffer,
  rcptTo: string[],
  mailFrom: string,
  senderAuth: SenderAuth | null = null,
  now = new Date(),
): Promise<string[]> {
  const handled: string[] = [];
  for (const email of rcptTo) {
    const resource = await findResource(email);
    if (!resource) continue;
    handled.push(email);
    const calendarId = resource.calendar?.id;
    if (!calendarId) continue;

    const icalData = findCalendar(rawMessage);
    const invite = icalData ? parseInvitation(icalData) : null;
    if (!icalData || !invite) {
      log.info({ resource: email, from: mailFrom }, 'Mail to a resource mailbox without a usable invitation — ignored');
      continue;
    }
    if (ANSWER_METHODS.has(invite.method)) {
      log.info({ resource: email, uid: invite.uid, from: mailFrom, method: invite.method }, 'Calendar answer to a resource mailbox — ignored');
      continue;
    }
    const { organizer, authenticated } = organizerIdentity(icalData, rawMessage, senderAuth);
    if (!organizer) {
      log.warn({ resource: email, uid: invite.uid, from: mailFrom }, 'Resource invitation without ORGANIZER/From — ignored');
      continue;
    }
    const outcome = await handleInvitation(resource, calendarId, invite, icalData, organizer, authenticated, now);
    logOutcome(outcome, { resource: resource.email, uid: invite.uid, organizer, envelope: mailFrom, authenticated, method: invite.method });
    const answer = bookingAnswer(outcome);
    if (answer) {
      await answerOrganizer(
        resource,
        { method: invite.method, icalData, raw: rawMessage, envelopeFrom: mailFrom, organizer, authenticated },
        invite.uid, answer, now,
      );
    }
  }
  return handled;
}

/**
 * iTIP methods that answer or query a meeting (a REPLY, COUNTER …) — never a booking
 * request. A resource ignores them: no booking change, no answer (an organizer's REPLY
 * echoed back, e.g. inside a bounce, never re-books the resource or starts a reply loop).
 */
const ANSWER_METHODS = new Set(['REPLY', 'COUNTER', 'DECLINECOUNTER', 'REFRESH']);

/** Pure: what the resource answers the organizer — only for a decided request. */
export function bookingAnswer(outcome: Outcome): BookingAnswer | null {
  if (outcome.kind === 'decided') return { decision: outcome.check.decision, conflicts: outcome.check.conflicts, occurrencesOnly: false };
  if (outcome.kind === 'occurrences-declined') return { decision: outcome.check.decision, conflicts: outcome.check.conflicts, occurrencesOnly: true };
  return null;
}

