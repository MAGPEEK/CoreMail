/**
 * v3.18.25 A5: iTIP inbound handler.
 *
 * Called from `storeInboundMessage()` for every incoming mail.
 * Searches the raw buffer for a VCALENDAR block with `METHOD:REPLY` and
 * then updates the corresponding CalendarEvent.attendees entry.
 *
 * Deliberately minimal — no heavy ical parser lib in the inbound path
 * (performance!), only regex-based extraction of the relevant fields.
 * Missing or incomplete VCALENDAR blocks are silently ignored.
 *
 * Supports:
 *  - METHOD:REPLY with PARTSTAT=ACCEPTED|DECLINED|TENTATIVE
 *  - SEQUENCE comparison (old REPLYs are ignored)
 *  - UID matching (case-insensitive)
 */
import { prisma } from './prisma/index.js';

interface ParsedReply {
  uid: string;
  sequence: number;
  attendeeEmail: string;
  partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION';
}

const VCAL_RE = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i;
const METHOD_RE = /^METHOD:(\S+)\s*$/im;
const UID_RE = /^UID:(.+?)\s*$/im;
const SEQUENCE_RE = /^SEQUENCE:(\d+)\s*$/im;
// ATTENDEE line with PARTSTAT + mailto:
// Examples:
//   ATTENDEE;PARTSTAT=ACCEPTED;CN="Bob":mailto:bob@gmail.com
//   ATTENDEE;CN=Bob;PARTSTAT=DECLINED:mailto:bob@x.de
const ATTENDEE_RE = /^ATTENDEE([^:]*?);?\s*PARTSTAT=([A-Z-]+)([^:]*?):mailto:([^\s>]+)\s*$/im;

/**
 * Extracts the REPLY VCALENDAR from a raw mail buffer.
 * Returns null if no REPLY found / no VCALENDAR / no matching attendee.
 */
export function extractITipReply(rawBuffer: Buffer): ParsedReply | null {
  const text = rawBuffer.toString('utf8');
  // RFC 5545 allows line folding with "\r\n " — unfold before regex parsing
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const vcalMatch = VCAL_RE.exec(unfolded);
  if (!vcalMatch) return null;
  const vcal = vcalMatch[0];

  const method = METHOD_RE.exec(vcal)?.[1]?.toUpperCase();
  if (method !== 'REPLY') return null;

  const uid = UID_RE.exec(vcal)?.[1]?.trim();
  if (!uid) return null;

  const sequence = parseInt(SEQUENCE_RE.exec(vcal)?.[1] ?? '0', 10);

  const att = ATTENDEE_RE.exec(vcal);
  if (!att) return null;
  const partstatRaw = (att[2] ?? '').toUpperCase();
  const attendeeEmail = (att[4] ?? '').trim().toLowerCase();
  if (!attendeeEmail) return null;

  let partstat: ParsedReply['partstat'];
  switch (partstatRaw) {
    case 'ACCEPTED':  partstat = 'ACCEPTED'; break;
    case 'DECLINED':  partstat = 'DECLINED'; break;
    case 'TENTATIVE': partstat = 'TENTATIVE'; break;
    default:          partstat = 'NEEDS-ACTION'; break;
  }

  return { uid, sequence, attendeeEmail, partstat };
}

/**
 * Processes an incoming iTIP REPLY mail: find event by UID, check
 * SEQUENCE, update attendees array. Fire-and-forget, errors are logged.
 *
 * Returns `true` if an event was actually updated, otherwise `false`.
 */
export async function processITipInbound(rawBuffer: Buffer): Promise<boolean> {
  let reply: ParsedReply | null;
  try {
    reply = extractITipReply(rawBuffer);
  } catch {
    return false;
  }
  if (!reply) return false;

  const event = await prisma.calendarEvent.findFirst({
    where: { uid: reply.uid },
    select: { id: true, sequence: true, attendees: true },
  });
  if (!event) return false;

  // SEQUENCE check: ignore old REPLYs (RFC 5546 §3.4.3)
  if (reply.sequence < event.sequence) return false;

  // Update attendees array
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
