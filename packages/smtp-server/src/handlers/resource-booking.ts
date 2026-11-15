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
 */
import { createLogger } from '@coremail/core';
import { prisma, extractCalendarParts, isAttendeeAuthenticated, type SenderAuth } from '@coremail/storage';

const log = createLogger('smtp:resource-booking');

export function bareAddress(addr: string): string {
  const m = /<([^>]*)>/.exec(addr);
  return (m ? m[1]! : addr).trim().replace(/^mailto:/i, '').toLowerCase();
}

const parseDtStamp = (s: string): Date => {
  const clean = s.replace(/Z$/, '');
  if (clean.length === 8) {
    return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
  }
  return new Date(
    `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T` +
      `${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`,
  );
};

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
): Promise<string[]> {
  const handled: string[] = [];
  for (const email of rcptTo) {
    const resource = await prisma.resourceMailbox.findFirst({
      where: { email: email.toLowerCase(), active: true },
      include: { calendar: true },
    });

    if (!resource) continue;
    handled.push(email);
    const calendarId = resource.calendar?.id;
    if (!calendarId) continue;

    const icalData = findCalendar(rawMessage);
    if (!icalData) {
      log.info({ resource: email, from: mailFrom }, 'Mail to a resource mailbox without an invitation — ignored');
      continue;
    }
    const unfolded = icalData.replace(/\r?\n[ \t]/g, '');

    // Extract essential fields
    const uidMatch = /^UID:(.+)$/m.exec(unfolded);
    const dtStartMatch = /^DTSTART[^:]*:(\d{8}T\d{6}Z?|\d{8})/m.exec(unfolded);
    const dtEndMatch = /^DTEND[^:]*:(\d{8}T\d{6}Z?|\d{8})/m.exec(unfolded);
    const summaryMatch = /^SUMMARY:(.+)$/m.exec(unfolded);
    const methodMatch = /^METHOD:(.+)$/m.exec(unfolded);

    if (!uidMatch || !dtStartMatch || !dtEndMatch) continue;

    const uid = uidMatch[1]?.trim() ?? '';
    if (!uid) continue;
    const summary = summaryMatch?.[1]?.trim() ?? 'Meeting';
    const method = methodMatch?.[1]?.trim().toUpperCase() ?? 'REQUEST';

    const dtStart = parseDtStamp(dtStartMatch[1] ?? '');
    const dtEnd = parseDtStamp(dtEndMatch[1] ?? '');

    if (isNaN(dtStart.getTime()) || isNaN(dtEnd.getTime())) continue;

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

    // Handle CANCEL method — remove this resource's booking (organizer only)
    if (method === 'CANCEL') {
      if (!existing) continue;
      if (!isOrganizer) {
        log.warn({ resource: email, uid, organizer, envelope: mailFrom, authenticated }, 'Resource booking CANCEL refused — not the authenticated organizer');
        continue;
      }
      await prisma.resourceBooking.delete({ where: { id: existing.id } });
      log.info({ resource: email, uid }, 'Resource booking cancelled');
      continue;
    }

    if (existing && !isOrganizer) {
      log.warn({ resource: email, uid, organizer, envelope: mailFrom, authenticated }, 'Resource booking update refused — not the authenticated organizer');
      continue;
    }

    const save = async (status: 'PENDING' | 'DECLINED' | 'ACCEPTED'): Promise<void> => {
      if (existing) {
        await prisma.resourceBooking.update({
          where: { id: existing.id },
          data: status === 'DECLINED' ? { status } : { dtStart, dtEnd, summary, status, icalData },
        });
      } else {
        await prisma.resourceBooking.create({
          data: { calendarId, uid, summary, organizer, dtStart, dtEnd, status, icalData },
        });
      }
    };

    if (!resource.autoAccept || resource.requireApproval || !authenticated) {
      // Store as PENDING for manual approval
      await save('PENDING');
      log.info({ resource: email, uid, authenticated }, 'Resource booking pending approval');
      continue;
    }

    // Check for conflicts
    if (resource.autoDeclineConflict) {
      const conflict = await prisma.resourceBooking.findFirst({
        where: {
          calendarId,
          uid: { not: uid },
          status: { in: ['ACCEPTED', 'TENTATIVE'] },
          dtStart: { lt: dtEnd },
          dtEnd: { gt: dtStart },
        },
      });

      if (conflict) {
        log.info({ resource: email, uid, conflict: conflict.uid }, 'Resource booking declined — conflict');
        await save('DECLINED');
        continue;
      }
    }

    // Auto-accept
    await save('ACCEPTED');
    log.info({ resource: email, uid, dtStart, dtEnd }, 'Resource booking accepted');
  }
  return handled;
}
