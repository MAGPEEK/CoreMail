/**
 * iTIP REQUEST → REPLY for invitees (RFC 5546 §3.2.3, iMIP RFC 6047).
 *
 * Used by protocols where the server answers an invitation on behalf of the
 * user (ActiveSync MeetingResponse) and by resource mailboxes that answer invitations
 * by mail (smtp-server handlers/resource-reply.ts, 9.5). Dependency-free counterpart of the
 * organizer-side helper in api-gateway `lib/imip.ts`:
 *  - `findITipRequest()`        — the METHOD:REQUEST VCALENDAR of a raw mail
 *  - `calendarObjectForInvitee()` — the stored calendar object (no METHOD, own PARTSTAT)
 *  - `buildITipReplyIcs()`      — METHOD:REPLY with exactly the responding ATTENDEE
 *  - `buildITipReplyMime()`     — RFC 5322 mail carrying the REPLY (inline + .ics)
 */
import { randomUUID } from 'node:crypto';
import { buildVCalendar, parseCalendarObject, patchVEvent, type ParsedVEvent } from '@coremail/core/calendar';
import { extractCalendarParts } from './itip-inbound.js';

export type ITipPartstat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

export interface ITipRequest {
  /** VCALENDAR text of the request (unfolded as received). */
  vcal: string;
  /** Master VEVENT. */
  event: ParsedVEvent & { uid: string };
}

const METHOD_LINE = /^METHOD:[^\r\n]*\r?\n/im;

/** Pure: the first METHOD:REQUEST calendar part of a raw message (null when none). */
export function findITipRequest(raw: Buffer | string): ITipRequest | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  for (const part of extractCalendarParts(text)) {
    const unfolded = part.replace(/\r?\n[ \t]/g, '');
    const method = /^METHOD:(\S+)/im.exec(unfolded)?.[1]?.toUpperCase();
    if (method !== 'REQUEST') continue;
    const vcal = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i.exec(part)?.[0];
    if (!vcal) continue;
    const parsed = parseCalendarObject(vcal);
    // RFC 5546 §3.2.2: a REQUEST names its ORGANIZER — the REPLY is addressed to it
    if (!parsed?.main.uid || !parsed.main.organizer) continue;
    return { vcal, event: parsed.main as ParsedVEvent & { uid: string } };
  }
  return null;
}

/** Pure: the attendee of `event` that is one of the user's own addresses (lower-case), or null. */
export function findOwnAttendee(event: ParsedVEvent, ownAddresses: readonly string[]): string | null {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  return event.attendees.find((a) => own.has(a.email.toLowerCase()))?.email.toLowerCase() ?? null;
}

/** Attendee list of the event with `responder`'s PARTSTAT replaced (added when missing). */
export function attendeesWithResponse(event: ParsedVEvent, responder: string, partstat: ITipPartstat): Array<{
  email: string; cn?: string; partstat: string; role: string; rsvp: boolean;
}> {
  const list = event.attendees.map((a) => ({
    email: a.email, ...(a.cn ? { cn: a.cn } : {}), partstat: a.partstat, role: a.role, rsvp: a.rsvp,
  }));
  const own = list.find((a) => a.email.toLowerCase() === responder.toLowerCase());
  if (own) { own.partstat = partstat; own.rsvp = false; } else list.push({ email: responder, partstat, role: 'REQ-PARTICIPANT', rsvp: false });
  return list;
}

/**
 * Pure: calendar object to store in the invitee's calendar — the organizer's
 * VCALENDAR without METHOD (RFC 4791 §4.1 forbids it in stored objects) and with
 * the invitee's PARTSTAT. Every other property (RRULE, VTIMEZONE, VALARM …) is kept.
 */
export function calendarObjectForInvitee(req: ITipRequest, responder: string, partstat: ITipPartstat): string {
  const withoutMethod = req.vcal.replace(METHOD_LINE, '');
  const patched = patchVEvent(withoutMethod, { attendees: attendeesWithResponse(req.event, responder, partstat) });
  if (patched) return patched;
  const e = req.event;
  return buildVCalendar({
    uid: e.uid, summary: e.summary, start: e.start, end: e.end, allDay: e.allDay,
    ...(e.description ? { description: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.rrule ? { rrule: e.rrule } : {}),
    ...(e.sequence !== null ? { sequence: e.sequence } : {}),
    ...(e.organizer ? { organizer: { email: e.organizer } } : {}),
    attendees: attendeesWithResponse(e, responder, partstat),
  });
}

/** Pure: METHOD:REPLY VCALENDAR with exactly one ATTENDEE (the responder). */
export function buildITipReplyIcs(req: ITipRequest, responder: { email: string; cn?: string }, partstat: ITipPartstat, now = new Date()): string {
  const e = req.event;
  return buildVCalendar({
    method: 'REPLY',
    dtstamp: now,
    uid: e.uid,
    // RFC 5546 §3.2.3: the answer to one instance carries its RECURRENCE-ID
    ...(e.recurrenceId ? { recurrenceId: { date: e.recurrenceId.date, dateOnly: e.recurrenceId.dateOnly } } : {}),
    summary: e.summary,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    ...(e.rrule ? { rrule: e.rrule } : {}),
    sequence: e.sequence ?? 0,
    ...(e.organizer ? { organizer: { email: e.organizer } } : {}),
    attendees: [{ email: responder.email, ...(responder.cn ? { cn: responder.cn } : {}), partstat, rsvp: false }],
  });
}

const SUBJECT_PREFIX: Record<ITipPartstat, string> = {
  ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined',
};

/** Header text: control characters removed, non-ASCII as an RFC 2047 encoded word. */
function headerText(s: string): string {
  const clean = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function bareAddr(a: string): string {
  return a.replace(/[\s<>",;]/g, '');
}

function mailboxHeader(m: { email: string; name?: string }): string {
  const addr = bareAddr(m.email);
  if (!m.name) return addr;
  const name = headerText(m.name);
  return name.startsWith('=?') ? `${name} <${addr}>` : `"${name.replace(/["\\]/g, '')}" <${addr}>`;
}

/** Header names the MIME builder writes itself — never taken from `headers`. */
const OWN_HEADERS = new Set(['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'x-coremail-calendar-method']);

/** Pure: `Name: value` lines of extra header fields — token names only, control characters removed from values. */
function extraHeaderLines(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers)
    .filter(([name]) => /^[A-Za-z0-9-]+$/.test(name) && !OWN_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name}: ${value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()}`);
}

function base64Lines(data: string): string {
  return (Buffer.from(data, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Pure: RFC 5322 REPLY mail — multipart/mixed { multipart/alternative { text/plain,
 * text/calendar;method=REPLY }, invite.ics } — the layout of the organizer-side
 * invitations in api-gateway lib/imip.ts (Gmail reads the inline part, Outlook the .ics).
 */
export function buildITipReplyMime(args: {
  ics: string;
  from: { email: string; name?: string };
  to: string;
  summary: string;
  partstat: ITipPartstat;
  now?: Date;
  /** Boundary / Message-ID seed (deterministic tests). */
  seed?: string;
  /** 9.5: subject instead of "<Verb>: <summary>" (resource replies are written in German). */
  subject?: string;
  /** 9.5: text part instead of the default one-line English sentence. */
  text?: string;
  /** 9.5: extra header fields (e.g. Auto-Submitted, In-Reply-To); unsafe names are dropped, values single-line. */
  headers?: Readonly<Record<string, string>>;
}): Buffer {
  const verb = SUBJECT_PREFIX[args.partstat];
  const action = args.partstat === 'TENTATIVE' ? 'tentatively accepted' : verb.toLowerCase();
  const who = args.from.name || args.from.email;
  const seed = args.seed ?? randomUUID().replace(/-/g, '');
  const domain = args.from.email.slice(args.from.email.lastIndexOf('@') + 1).replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const mixed = `mixed-${seed}`;
  const alt = `alt-${seed}`;
  const lines = [
    `From: ${mailboxHeader(args.from)}`,
    `To: ${bareAddr(args.to)}`,
    `Subject: ${headerText(args.subject ?? `${verb}: ${args.summary}`)}`,
    `Date: ${(args.now ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${seed}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Coremail-Calendar-Method: REPLY',
    ...extraHeaderLines(args.headers ?? {}),
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(args.text ?? `${who} has ${action} the invitation "${args.summary}".`),
    `--${alt}`,
    'Content-Type: text/calendar; charset=UTF-8; method=REPLY',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(args.ics),
    `--${alt}--`,
    `--${mixed}`,
    'Content-Type: application/ics; method=REPLY; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(args.ics),
    `--${mixed}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
