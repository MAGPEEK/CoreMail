/**
 * 9.5: the automatic answer of a resource mailbox (room / equipment) to an invitation
 * that arrived by mail (handlers/resource-booking.ts) — an iMIP REPLY to the organizer,
 * as rooms of other calendar servers do.
 *
 *  - METHOD:REPLY with the resource as the only ATTENDEE: PARTSTAT ACCEPTED, DECLINED,
 *    or TENTATIVE while the booking waits for approval. Built by storage itip-reply.ts
 *    (the REPLY builder of ActiveSync meeting responses), so there is one REPLY format.
 *  - The answer mirrors the request: a request with the series (or a single meeting)
 *    gets one REPLY for the series; a request with only single occurrences
 *    (RECURRENCE-ID) gets one REPLY per occurrence, each with its RECURRENCE-ID — a
 *    declined occurrence update is a DECLINED REPLY for exactly those occurrences, the
 *    series keeps the answer it had. One VEVENT per REPLY: every calendar client (and
 *    CoreMail's own REPLY processing) applies it.
 *  - German text part: accepted / declined with the reason (conflicting dates, booking
 *    window, duration, series not allowed, too frequent, not bookable) / needs approval.
 *  - Sent through the outbound queue with the resource as envelope sender and From
 *    (the worker signs with its domain's DKIM key), `Auto-Submitted: auto-replied`.
 *
 * Never answered (loop and backscatter safety): requests other than REQUEST (CANCEL,
 * PUBLISH …), an unauthenticated organizer (forged addresses get no mail), a null
 * envelope sender (bounces), automatically submitted, bulk or list mail, automated
 * senders (MAILER-DAEMON, noreply …), the resource itself or another resource mailbox
 * as organizer, and resources with `sendReplies` switched off.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core';
import {
  getProperty, isValidTimeZone, parseIcal, parseVEventComponent, type ParsedVEvent,
} from '@coremail/core/calendar';
import {
  prisma, buildITipReplyIcs, buildITipReplyMime,
  type ITipPartstat, type ITipRequest, type Occurrence, type RoomDecision,
} from '@coremail/storage';
import { automaticMailReason, bareAddress, isAutomatedSender, parseHeaderBlock } from './auto-reply.js';

const log = createLogger('smtp:resource-reply');

/** Most REPLY mails for one request with single occurrences (one per occurrence). */
export const MAX_OCCURRENCE_REPLIES = 10;
/** Conflicting dates listed in the text part. */
export const MAX_TEXT_CONFLICTS = 20;

/** The resource as the answer needs it. */
export interface ReplyResource {
  email: string;
  displayName: string;
  sendReplies: boolean;
  maxDurationMinutes: number | null;
  bookingWindowDays: number;
}

/** What the booking decided for the request. */
export interface BookingAnswer {
  decision: RoomDecision;
  /** Conflicting occurrences of the meeting (declined for them, or listed with an acceptance). */
  conflicts: readonly Occurrence[];
  /** Only the occurrences of the request were declined; the series stays booked. */
  occurrencesOnly: boolean;
}

/** The request the resource answers. */
export interface AnsweredRequest {
  /** METHOD of the invitation (REQUEST when absent). */
  method: string;
  /** VCALENDAR text of the invitation as received. */
  icalData: string;
  /** Raw invitation mail (headers for the loop checks, Message-ID for In-Reply-To). */
  raw: Buffer;
  /** SMTP envelope MAIL FROM ('' = null sender). */
  envelopeFrom: string;
  /** The organizer (iCal ORGANIZER, else header From), lower-case. */
  organizer: string;
  authenticated: boolean;
}

/**
 * Pure: why the request gets no answer (null = answer it). The "organizer is another
 * resource mailbox" check needs the database and runs in {@link answerOrganizer}.
 */
export function replySuppression(resource: Pick<ReplyResource, 'email' | 'sendReplies'>, req: AnsweredRequest): string | null {
  if (!resource.sendReplies) return 'replies off';
  if (req.method.toUpperCase() !== 'REQUEST') return 'not a request';
  if (!req.authenticated) return 'organizer not authenticated';
  const envelope = bareAddress(req.envelopeFrom);
  if (!envelope || !envelope.includes('@')) return 'null sender';
  const organizer = req.organizer.toLowerCase();
  if (!organizer.includes('@')) return 'no organizer';
  if (organizer === resource.email.toLowerCase()) return 'own address';
  if (isAutomatedSender(organizer) || isAutomatedSender(envelope)) return 'automated sender';
  return automaticMailReason(parseHeaderBlock(req.raw), /\b(all|autoreply)\b/i);
}

/** Pure: the PARTSTAT of the resource's answer — a booking waiting for approval is TENTATIVE. */
export function partstatFor(decision: RoomDecision): ITipPartstat {
  if (decision.status === 'ACCEPTED') return 'ACCEPTED';
  if (decision.status === 'DECLINED') return 'DECLINED';
  return 'TENTATIVE';
}

const SUBJECT_PREFIX: Record<ITipPartstat, string> = {
  ACCEPTED: 'Angenommen',
  DECLINED: 'Abgelehnt',
  TENTATIVE: 'Mit Vorbehalt angenommen',
};

/** Pure: the German subject of the answer. */
export function replySubject(partstat: ITipPartstat, summary: string): string {
  return `${SUBJECT_PREFIX[partstat]}: ${summary.trim() || 'Besprechung'}`;
}

/** Pure: German date (and time, with zone) of an instant in `tz` (IANA; UTC when unknown). */
export function formatWhen(date: Date, allDay: boolean, tz: string | null): string {
  const timeZone = tz && isValidTimeZone(tz) ? tz : 'UTC';
  const opts: Intl.DateTimeFormatOptions = allDay
    ? { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
    : { timeZone, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  return new Intl.DateTimeFormat('de-DE', opts).format(date);
}

/** Pure: the German sentence for a decline reason. */
export function declineReasonText(decision: RoomDecision, resource: Pick<ReplyResource, 'maxDurationMinutes' | 'bookingWindowDays'>): string {
  switch (decision.reason) {
    case 'inactive': return 'Die Ressource ist derzeit nicht buchbar.';
    case 'recurring': return 'Serientermine sind für diese Ressource nicht erlaubt.';
    case 'too-frequent': return 'Die Serie wiederholt sich zu häufig (öfter als einmal am Tag).';
    case 'duration':
      return resource.maxDurationMinutes !== null
        ? `Die Besprechung ist länger als erlaubt (höchstens ${resource.maxDurationMinutes} Minuten).`
        : 'Die Besprechung ist länger als erlaubt.';
    case 'window': return `Der Termin liegt außerhalb des Buchungszeitraums (höchstens ${resource.bookingWindowDays} Tage im Voraus).`;
    case 'conflict': return 'Die Ressource ist zu folgenden Terminen bereits belegt:';
    default: return 'Die Buchung ist nicht möglich.';
  }
}

/** Pure: bullet lines of conflicting dates (capped). */
function conflictLines(conflicts: readonly Occurrence[], allDay: boolean, tz: string | null): string[] {
  const lines = conflicts.slice(0, MAX_TEXT_CONFLICTS).map((c) => `- ${formatWhen(c.dtStart, allDay, tz)}`);
  const more = conflicts.length - MAX_TEXT_CONFLICTS;
  return more > 0 ? [...lines, `- … und ${more} weitere`] : lines;
}

/** Pure: the German text part of the answer for one answered meeting / occurrence. */
export function replyText(resource: ReplyResource, event: ParsedVEvent, answer: BookingAnswer): string {
  const name = resource.displayName.trim() || resource.email;
  const partstat = partstatFor(answer.decision);
  const opening = answer.occurrencesOnly && partstat === 'DECLINED'
    ? `${name} hat die Änderung dieses Einzeltermins abgelehnt. Die übrigen Termine der Serie bleiben gebucht.`
    : partstat === 'ACCEPTED'
      ? `${name} hat Ihre Buchung angenommen.`
      : partstat === 'DECLINED'
        ? `${name} hat Ihre Buchung abgelehnt.`
        : `${name} hat Ihre Anfrage vorgemerkt. Die Buchung muss noch genehmigt werden.`;
  const lines = [
    opening,
    '',
    `Besprechung: ${event.summary.trim() || 'Besprechung'}`,
    `Beginn: ${formatWhen(event.start, event.allDay, event.tzid)}`,
    ...(event.rrule ? ['Serientermin'] : []),
  ];
  if (partstat === 'DECLINED') {
    lines.push('', `Grund: ${declineReasonText(answer.decision, resource)}`);
    if (answer.decision.reason === 'conflict') lines.push(...conflictLines(answer.conflicts, event.allDay, event.tzid));
  } else if (answer.conflicts.length > 0) {
    lines.push('', 'Hinweis: Zu folgenden Terminen ist die Ressource bereits belegt:', ...conflictLines(answer.conflicts, event.allDay, event.tzid));
  }
  lines.push('', 'Diese Nachricht wurde automatisch erstellt.');
  return lines.join('\n');
}

/**
 * Pure: the components the answer covers — the series master (or single meeting) when
 * the request carries it, else each RECURRENCE-ID occurrence (capped). The organizer
 * is filled in when the request names none (identity taken from the From header).
 */
export function answeredEvents(icalData: string, uid: string, organizer: string): ITipRequest[] {
  const root = parseIcal(icalData);
  if (!root) return [];
  const events = root.components.filter((c) => c.name === 'VEVENT');
  const master = events.find((c) => !getProperty(c, 'RECURRENCE-ID'));
  const chosen = master ? [master] : events.slice(0, MAX_OCCURRENCE_REPLIES);
  return chosen.flatMap((c) => {
    const ev = parseVEventComponent(c, root);
    return ev ? [{ vcal: icalData, event: { ...ev, uid, organizer: ev.organizer ?? organizer } }] : [];
  });
}

/** Pure: the Message-ID of the request when it is a well-formed msg-id, else null. */
function requestMessageId(raw: Buffer): string | null {
  const id = parseHeaderBlock(raw).get('message-id')?.[0]?.trim() ?? '';
  return /^<[^<>\s]+>$/.test(id) ? id : null;
}

/** Pure: the REPLY mails of the resource (one per answered component). */
export function buildResourceReplies(
  resource: ReplyResource,
  req: AnsweredRequest,
  uid: string,
  answer: BookingAnswer,
  now = new Date(),
): Buffer[] {
  const partstat = partstatFor(answer.decision);
  const inReplyTo = requestMessageId(req.raw);
  const headers: Record<string, string> = {
    'Auto-Submitted': 'auto-replied',
    'X-Auto-Response-Suppress': 'All',
    ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {}),
  };
  const from = { email: resource.email, ...(resource.displayName.trim() ? { name: resource.displayName.trim() } : {}) };
  return answeredEvents(req.icalData, uid, req.organizer).map((request) => {
    const ics = buildITipReplyIcs(request, { email: resource.email, ...(from.name ? { cn: from.name } : {}) }, partstat, now);
    return buildITipReplyMime({
      ics, from, to: req.organizer, summary: request.event.summary, partstat, now, headers,
      subject: replySubject(partstat, request.event.summary),
      text: replyText(resource, request.event, answer),
    });
  });
}

export interface ResourceReplyDeps {
  /** Is the address one of the resource mailboxes? */
  isResourceAddress(address: string): Promise<boolean>;
  /** Queue one REPLY: envelope sender = the resource. */
  enqueue(job: { from: string; to: string; raw: Buffer }): Promise<void>;
}

const defaultDeps: ResourceReplyDeps = {
  isResourceAddress: async (address) =>
    !!(await prisma.resourceMailbox.findFirst({ where: { email: address.toLowerCase() }, select: { id: true } })),
  enqueue: async ({ from, to, raw }) => {
    const { enqueueOutbound } = await import('../outbound/queue.js');
    // DKIM: the worker signs with the key of the envelope domain (outbound/dkim.ts)
    await enqueueOutbound({ messageId: `resource-reply-${randomUUID()}`, from, to: [to], resourceReply: true, rawMessage: raw.toString('base64') });
  },
};

let activeDeps: ResourceReplyDeps = defaultDeps;

/** Test seam: replaces the database lookup and the queue; returns the previous deps. */
export function setResourceReplyDeps(deps: ResourceReplyDeps): ResourceReplyDeps {
  const previous = activeDeps;
  activeDeps = deps;
  return previous;
}

/**
 * Answers the organizer of a decided request. Returns the number of REPLY mails
 * queued, or why none was sent. Never throws: a failed answer never fails the delivery.
 */
export async function answerOrganizer(
  resource: ReplyResource,
  req: AnsweredRequest,
  uid: string,
  answer: BookingAnswer,
  now = new Date(),
): Promise<number | string> {
  try {
    const suppressed = replySuppression(resource, req);
    if (suppressed) return suppressed;
    if (await activeDeps.isResourceAddress(req.organizer)) return 'organizer is a resource';
    const replies = buildResourceReplies(resource, req, uid, answer, now);
    for (const raw of replies) await activeDeps.enqueue({ from: resource.email, to: req.organizer, raw });
    log.info({ resource: resource.email, organizer: req.organizer, uid, replies: replies.length, partstat: partstatFor(answer.decision) }, 'Resource reply enqueued');
    return replies.length;
  } catch (err) {
    log.warn({ err, resource: resource.email, uid }, 'Resource reply failed');
    return 'error';
  }
}
