/**
 * v3.18.25 A5: iTIP inbound handler.
 *
 * Called from `storeInboundMessage()` for every incoming mail.
 * Finds a VCALENDAR with `METHOD:REPLY` (text/calendar / application/ics
 * MIME parts, decoded from base64 / quoted-printable) and updates the
 * corresponding CalendarEvent.attendees entry.
 *
 * Deliberately minimal — no heavy ical parser lib in the inbound path,
 * only regex-based extraction of the relevant fields.
 *
 * Security (RFC 5546 §3.2.3 / §6.1): a REPLY is only applied when
 *  - it is delivered to a user mailbox and the event lives in one of that
 *    user's own calendars (no cross-user updates by UID),
 *  - the REPLY carries exactly one ATTENDEE, and
 *  - the From header address equals that attendee and the envelope sender is
 *    the attendee or an address of the attendee's domain (bounce/VERP
 *    addresses). Spoofed From headers are the job of SPF/DKIM/DMARC upstream.
 *
 * Supports PARTSTAT=ACCEPTED|DECLINED|TENTATIVE, SEQUENCE comparison
 * (old REPLYs are ignored), case-insensitive UID matching.
 */
import { prisma } from './prisma/index.js';

export interface ParsedReply {
  uid: string;
  sequence: number;
  attendeeEmail: string;
  partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION';
}

export interface ITipContext {
  /** SMTP envelope MAIL FROM. */
  envelopeFrom: string;
  /** User whose mailbox receives the mail; null for shared mailboxes (REPLY ignored). */
  recipientUserId: string | null;
}

const VCAL_RE = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i;
const METHOD_RE = /^METHOD:(\S+)\s*$/im;
const UID_RE = /^UID:(.+?)\s*$/im;
const SEQUENCE_RE = /^SEQUENCE:(\d+)\s*$/im;
const ATTENDEE_LINE_RE = /^ATTENDEE[;:].*$/gim;
const ATTENDEE_RE = /^ATTENDEE([^:]*?);?\s*PARTSTAT=([A-Z-]+)([^:]*?):mailto:([^\s>]+)\s*$/im;

function splitHeadBody(part: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(part);
  if (!m) return { head: part, body: '' };
  return { head: part.slice(0, m.index), body: part.slice(m.index + m[0].length) };
}

function headerValue(head: string, name: string): string {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  return re.exec(unfolded)?.[1]?.trim() ?? '';
}

function decodeBody(body: string, cte: string): string {
  const enc = cte.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

/** Pure: all text/calendar (and application/ics) parts of a raw message, decoded. */
export function extractCalendarParts(raw: string, depth = 0): string[] {
  if (depth > 8) return [];
  const { head, body } = splitHeadBody(raw);
  const ctype = headerValue(head, 'content-type');
  const lower = ctype.toLowerCase();
  if (lower.startsWith('multipart/')) {
    const b = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
    if (!b) return [];
    const parts = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    return parts.slice(1).flatMap((p) => extractCalendarParts(p, depth + 1));
  }
  if (lower.startsWith('text/calendar') || lower.startsWith('application/ics')) {
    return [decodeBody(body, headerValue(head, 'content-transfer-encoding'))];
  }
  // single-part message without Content-Type but with an inline VCALENDAR (legacy)
  if (depth === 0 && !ctype && VCAL_RE.test(body)) return [body];
  return [];
}

/** Pure: parse a REPLY from VCALENDAR text. Null when not a usable REPLY. */
export function parseITipReply(vcalText: string): ParsedReply | null {
  // RFC 5545 allows line folding with "\r\n " — unfold before regex parsing
  const unfolded = vcalText.replace(/\r?\n[ \t]/g, '');
  const vcal = VCAL_RE.exec(unfolded)?.[0];
  if (!vcal) return null;
  if (METHOD_RE.exec(vcal)?.[1]?.toUpperCase() !== 'REPLY') return null;
  const uid = UID_RE.exec(vcal)?.[1]?.trim();
  if (!uid) return null;
  const sequence = parseInt(SEQUENCE_RE.exec(vcal)?.[1] ?? '0', 10);
  // RFC 5546 §3.2.3: a REPLY contains exactly one ATTENDEE (the replying one)
  const attendeeLines = vcal.match(ATTENDEE_LINE_RE) ?? [];
  if (attendeeLines.length !== 1) return null;
  const att = ATTENDEE_RE.exec(attendeeLines[0]!);
  if (!att) return null;
  const attendeeEmail = (att[4] ?? '').trim().toLowerCase();
  if (!attendeeEmail.includes('@')) return null;
  const raw = (att[2] ?? '').toUpperCase();
  const partstat: ParsedReply['partstat'] =
    raw === 'ACCEPTED' || raw === 'DECLINED' || raw === 'TENTATIVE' ? raw : 'NEEDS-ACTION';
  return { uid, sequence, attendeeEmail, partstat };
}

/** Extracts the REPLY from a raw mail buffer (null if none). */
export function extractITipReply(rawBuffer: Buffer): ParsedReply | null {
  for (const part of extractCalendarParts(rawBuffer.toString('utf8'))) {
    const r = parseITipReply(part);
    if (r) return r;
  }
  return null;
}

function bare(addr: string): string {
  const m = /<([^>]*)>/.exec(addr);
  return (m ? m[1]! : addr).trim().toLowerCase();
}

/** Pure: does the mail come from the attendee? From header == attendee; envelope = attendee or same domain. */
export function isReplyFromAttendee(rawBuffer: Buffer, envelopeFrom: string, attendeeEmail: string): boolean {
  const { head } = splitHeadBody(rawBuffer.subarray(0, Math.min(rawBuffer.length, 128 * 1024)).toString('utf8'));
  const from = bare(headerValue(head, 'from'));
  const attendee = attendeeEmail.toLowerCase();
  if (from !== attendee) return false;
  const env = bare(envelopeFrom);
  if (!env) return false;
  if (env === attendee) return true;
  const domainOf = (a: string) => a.slice(a.lastIndexOf('@') + 1);
  return domainOf(env) === domainOf(attendee);
}

/**
 * Processes an incoming iTIP REPLY mail: verify sender, find the event by UID
 * in the recipient's own calendars, check SEQUENCE, update attendees array.
 * Returns `true` if an event was actually updated, otherwise `false`.
 */
export async function processITipInbound(rawBuffer: Buffer, ctx: ITipContext): Promise<boolean> {
  if (!ctx.recipientUserId) return false;
  let reply: ParsedReply | null;
  try {
    reply = extractITipReply(rawBuffer);
  } catch {
    return false;
  }
  if (!reply) return false;
  if (!isReplyFromAttendee(rawBuffer, ctx.envelopeFrom, reply.attendeeEmail)) return false;

  const event = await prisma.calendarEvent.findFirst({
    where: { uid: { equals: reply.uid, mode: 'insensitive' }, calendar: { userId: ctx.recipientUserId } },
    select: { id: true, sequence: true, attendees: true },
  });
  if (!event) return false;

  // SEQUENCE check: ignore old REPLYs (RFC 5546 §3.4.3)
  if (reply.sequence < event.sequence) return false;

  const attendees = Array.isArray(event.attendees) ? [...event.attendees] : [];
  let updated = false;
  for (let i = 0; i < attendees.length; i++) {
    const a = attendees[i];
    if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
      const rec = a as Record<string, unknown>;
      const email = typeof rec['email'] === 'string' ? rec['email'].toLowerCase() : null;
      if (email === reply.attendeeEmail) {
        attendees[i] = { ...rec, partstat: reply.partstat, rsvp: false };
        updated = true;
        break;
      }
    }
  }
  if (!updated) return false;

  await prisma.calendarEvent.update({
    where: { id: event.id },
    data: { attendees: attendees as object },
  });
  return true;
}
