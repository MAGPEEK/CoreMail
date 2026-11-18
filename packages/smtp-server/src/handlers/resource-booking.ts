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
 * or removes those occurrences of the stored series instead of the whole booking.
 */
import { createLogger } from '@coremail/core';
import {
  getProperty, parseDateProperty, parseIcal, parseVEventComponent, serializeComponent,
  type IcalComponent, type ParsedVEvent,
} from '@coremail/core/calendar';
import { excludeOccurrence } from '@coremail/core/calendar-exceptions';
import {
  prisma, checkResourceBooking, conflictList, extractCalendarParts, isAttendeeAuthenticated,
  type ResourceCheck, type SenderAuth,
} from '@coremail/storage';

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

/**
 * Pure: the stored series with the occurrences of an update (VEVENTs with
 * RECURRENCE-ID) replaced or added, plus VTIMEZONEs the series lacks. Null when the
 * stored object is no series master or either side is unreadable.
 */
export function applyOccurrenceUpdates(stored: string, incoming: string): string | null {
  const root = parseIcal(stored);
  const update = parseIcal(incoming);
  if (!root || !update || !vevents(root).some((c) => !getProperty(c, 'RECURRENCE-ID'))) return null;
  for (const occ of vevents(update)) {
    const rid = recurrenceIdOf(occ, update)?.getTime();
    if (rid === undefined) continue;
    const at = root.components.findIndex((c) => c.name === 'VEVENT' && recurrenceIdOf(c, root)?.getTime() === rid);
    if (at >= 0) root.components[at] = occ;
    else root.components.push(occ);
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
type BookingDb = Pick<typeof prisma, 'resourceBooking'>;

function findResource(email: string) {
  return prisma.resourceMailbox.findFirst({
    where: { email: email.toLowerCase(), active: true },
    include: { calendar: true },
  });
}

/** CANCEL: the whole booking, or only the cancelled occurrences of the stored series. */
async function cancelBooking(existing: Booking, invite: Invitation): Promise<void> {
  const remaining = invite.master ? null : cancelOccurrences(existing.icalData, invite.recurrenceIds);
  if (remaining) {
    await prisma.resourceBooking.update({ where: { id: existing.id }, data: { icalData: remaining } });
    log.info({ calendarId: existing.calendarId, uid: existing.uid, occurrences: invite.recurrenceIds.length }, 'Resource booking: occurrences cancelled');
    return;
  }
  await prisma.resourceBooking.delete({ where: { id: existing.id } });
  log.info({ calendarId: existing.calendarId, uid: existing.uid }, 'Resource booking cancelled');
}

/**
 * Write the answer. The row is read again inside the transaction (after the lock), so a
 * booking created meanwhile is updated, not duplicated. A decline of an existing booking
 * keeps its previous slot data.
 */
async function writeBooking(
  db: BookingDb,
  calendarId: string,
  meeting: MeetingRequest,
  organizer: string,
  status: 'ACCEPTED' | 'DECLINED' | 'PENDING',
  conflicts: ResourceCheck['conflicts'],
): Promise<void> {
  const listed = conflictList(conflicts);
  const current = await db.resourceBooking.findUnique({ where: { calendarId_uid: { calendarId, uid: meeting.uid } } });
  if (current) {
    await db.resourceBooking.update({
      where: { id: current.id },
      data: status === 'DECLINED'
        ? { status, conflicts: listed }
        : { dtStart: meeting.dtStart, dtEnd: meeting.dtEnd, summary: meeting.summary, status, icalData: meeting.icalData, conflicts: listed },
    });
    return;
  }
  await db.resourceBooking.create({
    data: {
      calendarId, uid: meeting.uid, summary: meeting.summary, organizer, dtStart: meeting.dtStart, dtEnd: meeting.dtEnd,
      status, icalData: meeting.icalData, conflicts: listed,
    },
  });
}

/**
 * REQUEST: an unauthenticated organizer's request waits for approval; otherwise the
 * resource rules decide under the resource's booking lock (conflict check + write in
 * one transaction — two requests for the same slot never both get the resource).
 */
async function requestBooking(
  resource: Resource,
  calendarId: string,
  meeting: MeetingRequest,
  organizer: string,
  authenticated: boolean,
  now: Date,
): Promise<void> {
  const logCtx = { resource: resource.email, uid: meeting.uid };
  if (!authenticated) {
    await writeBooking(prisma, calendarId, meeting, organizer, 'PENDING', []);
    log.info(logCtx, 'Resource booking pending approval — organizer not authenticated');
    return;
  }
  const { decision, conflicts } = await prisma.$transaction(async (tx) => {
    const check = await checkResourceBooking(tx, calendarId, resource, meeting, now);
    await writeBooking(tx, calendarId, meeting, organizer, check.decision.status, check.conflicts);
    return check;
  });
  const conflictDates = conflicts.map((c) => c.dtStart.toISOString());
  if (decision.status === 'DECLINED') log.info({ ...logCtx, reason: decision.reason, conflicts: conflictDates }, 'Resource booking declined');
  else log.info({ ...logCtx, status: decision.status, conflicts: conflictDates }, 'Resource booking decided');
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
    const { uid } = invite;
    const { organizer, authenticated } = organizerIdentity(icalData, rawMessage, senderAuth);
    if (!organizer) {
      log.warn({ resource: email, uid, from: mailFrom }, 'Resource invitation without ORGANIZER/From — ignored');
      continue;
    }

    // v8.1: UIDs are unique per resource calendar — a meeting that books two
    // rooms gets one booking in each. Only this resource's booking is read,
    // changed or deleted here.
    const existing = await prisma.resourceBooking.findUnique({ where: { calendarId_uid: { calendarId, uid } } });
    const isOrganizer = !!existing && authenticated && bareAddress(existing.organizer) === organizer;
    if (existing && !isOrganizer) {
      log.warn({ resource: email, uid, organizer, envelope: mailFrom, authenticated, method: invite.method },
        'Resource booking change refused — not the authenticated organizer');
      continue;
    }

    if (invite.method === 'CANCEL') {
      if (existing) await cancelBooking(existing, invite);
      continue;
    }

    // Occurrences only: they change the stored series (a new booking is just that occurrence)
    const meetingIcal = !invite.master && existing ? applyOccurrenceUpdates(existing.icalData, icalData) : icalData;
    const meeting = meetingIcal ? meetingFromCalendar(uid, meetingIcal) : null;
    if (!meeting) {
      log.info({ resource: email, uid }, 'Resource invitation without a usable VEVENT — ignored');
      continue;
    }
    await requestBooking(resource, calendarId, meeting, organizer, authenticated, now);
  }
  return handled;
}

