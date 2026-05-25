/**
 * v3.18.25 A5: iTIP Inbound-Handler.
 *
 * Wird in `storeInboundMessage()` aufgerufen für jede eingehende Mail.
 * Sucht im Raw-Buffer nach einem VCALENDAR-Block mit `METHOD:REPLY` und
 * updated dann den entsprechenden CalendarEvent.attendees-Eintrag.
 *
 * Bewusst minimalistisch — keine schwere ical-parser-Lib im Inbound-Pfad
 * (Performance!), nur Regex-basiertes Extraction der relevanten Felder.
 * Fehlende oder unvollständige VCALENDAR-Blöcke werden silent ignoriert.
 *
 * Unterstützt:
 *  - METHOD:REPLY mit PARTSTAT=ACCEPTED|DECLINED|TENTATIVE
 *  - SEQUENCE-Vergleich (alte REPLYs werden ignoriert)
 *  - UID-Matching (case-insensitive)
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
// ATTENDEE-Zeile mit PARTSTAT + mailto:
// Beispiele:
//   ATTENDEE;PARTSTAT=ACCEPTED;CN="Bob":mailto:bob@gmail.com
//   ATTENDEE;CN=Bob;PARTSTAT=DECLINED:mailto:bob@x.de
const ATTENDEE_RE = /^ATTENDEE([^:]*?);?\s*PARTSTAT=([A-Z-]+)([^:]*?):mailto:([^\s>]+)\s*$/im;

/**
 * Extrahiert das REPLY-VCALENDAR aus einem Raw-Mail-Buffer.
 * Returns null wenn kein REPLY gefunden / kein VCALENDAR / kein passender Attendee.
 */
export function extractITipReply(rawBuffer: Buffer): ParsedReply | null {
  const text = rawBuffer.toString('utf8');
  // RFC 5545 erlaubt Line-Folding mit „\r\n " — vor Regex-Parsing entfalten
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
 * Verarbeitet eine eingehende iTIP-REPLY-Mail: finde Event per UID, prüfe
 * SEQUENCE, update attendees-Array. Fire-and-forget, Errors werden geloggt.
 *
 * Returns `true` wenn ein Event tatsächlich geupdated wurde, sonst `false`.
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

  // SEQUENCE-Check: alte REPLYs ignorieren (RFC 5546 §3.4.3)
  if (reply.sequence < event.sequence) return false;

  // Attendees-Array updaten
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
