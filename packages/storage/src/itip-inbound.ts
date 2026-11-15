/**
 * v3.18.25 A5: iTIP inbound handler.
 *
 * Called from `storeInboundMessage()` for every incoming mail.
 * Finds a VCALENDAR with `METHOD:REPLY` (text/calendar / application/ics
 * MIME parts, decoded from base64 / quoted-printable) and applies the
 * attendee's PARTSTAT to the organizer's stored CalendarEvent.
 *
 * v7.1.0: parsed with the shared `@coremail/core/calendar` parser (quoted
 * parameter values such as `CN="Doe: J"` work), and the PARTSTAT is written into
 * `icalData` too — that is what CalDAV clients read (RFC 5546 §3.2.3, RFC 4791 §4.1).
 * A REPLY with RECURRENCE-ID only touches that instance (override component).
 *
 * Security (RFC 5546 §3.2.3 / §6.1): a REPLY is only applied when
 *  - it is delivered to a user mailbox and the event lives in one of that
 *    user's own calendars (no cross-user updates by UID),
 *  - that user (primary address or alias) is the event's ORGANIZER,
 *  - the REPLY carries exactly one ATTENDEE, and
 *  - the From header address equals that attendee and the envelope sender is
 *    the attendee or an address of the attendee's domain (bounce/VERP
 *    addresses), and
 *  - the attendee is authenticated (`ctx.senderAuth`): the authenticated local
 *    envelope sender is the attendee, or the message passed DMARC / SPF / DKIM
 *    for a domain aligned with the attendee's domain. Without a verdict the
 *    REPLY is ignored (the mail itself is still delivered).
 *
 * Ordering (RFC 5546 §2.1.5): REPLYs with a lower SEQUENCE than the event are
 * ignored; with the same SEQUENCE, a REPLY older (DTSTAMP) than the last one
 * applied for that attendee/instance is ignored. UIDs are compared exactly.
 */
import {
  findMainVEvent,
  formatDateOnly,
  formatUtcDateTime,
  getProperties,
  getProperty,
  parseDateProperty,
  parseIcal,
  parseVEventComponent,
  resolveTzid,
  serializeComponent,
  toIsoDate,
  utcToWallClockMs,
  type IcalComponent,
  type IcalDateValue,
  type ParsedVEvent,
} from '@coremail/core/calendar';
import { expandOccurrences } from '@coremail/core/recurrence';
import { prisma } from './prisma/index.js';

export interface ParsedReply {
  uid: string;
  sequence: number;
  attendeeEmail: string;
  partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION';
  /** RECURRENCE-ID of the answered instance; null = the whole series. */
  recurrenceId: IcalDateValue | null;
  /** DTSTAMP of the REPLY (null when missing). */
  dtstamp: Date | null;
}

/**
 * How the sender of a message was authenticated (threaded from the SMTP layer).
 * Never derived from message headers.
 */
export interface SenderAuth {
  /**
   * Domains the message is authenticated for by the inbound filter: header-From
   * domain on DMARC pass, MAIL FROM domain on SPF pass, DKIM d= domains.
   */
  verifiedDomains?: readonly string[];
  /** Envelope sender proven by SMTP AUTH / an internal authenticated producer. */
  authenticatedSender?: string;
}

export interface ITipContext {
  /** SMTP envelope MAIL FROM. */
  envelopeFrom: string;
  /** User whose mailbox receives the mail; null for shared mailboxes (REPLY ignored). */
  recipientUserId: string | null;
  /** Sender authentication verdict; null/empty = unauthenticated (REPLY ignored). */
  senderAuth: SenderAuth | null;
}

/** Pure: relaxed domain alignment (equal, or one is a subdomain of the other). */
export function domainAligned(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, '');
  const y = b.toLowerCase().replace(/\.$/, '');
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Pure: is the attendee's identity authenticated? Either the authenticated
 * local envelope sender IS the attendee, or the message passed DMARC, SPF or
 * DKIM for a domain aligned with the attendee's domain (RFC 5546 §6.1.1:
 * a REPLY must be authenticated as coming from the attendee).
 */
export function isAttendeeAuthenticated(attendeeEmail: string, auth: SenderAuth | null | undefined): boolean {
  if (!auth) return false;
  const attendee = attendeeEmail.toLowerCase();
  if (auth.authenticatedSender && bare(auth.authenticatedSender) === attendee) return true;
  const domain = attendee.slice(attendee.lastIndexOf('@') + 1);
  if (!attendee.includes('@') || !domain) return false;
  return (auth.verifiedDomains ?? []).some((d) => domainAligned(domain, d));
}

const VCAL_RE = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/i;

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

function mailto(v: string): string {
  return v.trim().replace(/^mailto:/i, '').trim().toLowerCase();
}

/** Pure: parse a REPLY from VCALENDAR text. Null when not a usable REPLY. */
export function parseITipReply(vcalText: string): ParsedReply | null {
  const vcal = VCAL_RE.exec(vcalText)?.[0];
  if (!vcal) return null;
  const root = parseIcal(vcal);
  if (!root || root.name !== 'VCALENDAR') return null;
  if (getProperty(root, 'METHOD')?.value.trim().toUpperCase() !== 'REPLY') return null;
  const ev = root.components.find((c) => c.name === 'VEVENT');
  if (!ev) return null;
  const uid = getProperty(ev, 'UID')?.value.trim();
  if (!uid) return null;
  const seqRaw = getProperty(ev, 'SEQUENCE')?.value.trim() ?? '0';
  const sequence = /^\d+$/.test(seqRaw) ? Number(seqRaw) : 0;
  // RFC 5546 §3.2.3: a REPLY contains exactly one ATTENDEE (the replying one)
  const attendees = getProperties(ev, 'ATTENDEE');
  if (attendees.length !== 1) return null;
  const att = attendees[0]!;
  const attendeeEmail = mailto(att.value);
  if (!attendeeEmail.includes('@')) return null;
  const raw = (att.params['PARTSTAT'] ?? '').toUpperCase();
  const partstat: ParsedReply['partstat'] =
    raw === 'ACCEPTED' || raw === 'DECLINED' || raw === 'TENTATIVE' ? raw : 'NEEDS-ACTION';
  const ridProp = getProperty(ev, 'RECURRENCE-ID');
  const recurrenceId = ridProp ? parseDateProperty(ridProp, root) : null;
  if (ridProp && !recurrenceId) return null;
  const stampProp = getProperty(ev, 'DTSTAMP');
  const dtstamp = stampProp ? parseDateProperty(stampProp, root)?.date ?? null : null;
  return { uid, sequence, attendeeEmail, partstat, recurrenceId, dtstamp };
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

// ─── Applying the PARTSTAT to the stored calendar object ─────────────────────

function cloneComponent(c: IcalComponent): IcalComponent {
  return { name: c.name, properties: c.properties.map((p) => ({ ...p, params: { ...p.params } })), components: c.components.map(cloneComponent) };
}

function setPartstat(comp: IcalComponent, email: string, partstat: string): boolean {
  const att = getProperties(comp, 'ATTENDEE').find((p) => mailto(p.value) === email);
  if (!att) return false;
  att.params['PARTSTAT'] = partstat;
  return true;
}

/** Most override (RECURRENCE-ID) components a REPLY may create in one calendar object. */
export const MAX_REPLY_OVERRIDES = 100;
/** Most per-instance DTSTAMP entries kept per attendee (`replyStamps`). */
export const MAX_REPLY_STAMPS = 100;

/**
 * Pure: is `recurrenceId` an instance of the series? RDATE, or an RRULE
 * occurrence (expansion limited to a 2 ms window around the instance, so it is
 * bounded whatever the rule says); EXDATE'd instances are not.
 */
export function isSeriesInstance(master: ParsedVEvent, recurrenceId: IcalDateValue): boolean {
  const t = recurrenceId.date.getTime();
  if (Number.isNaN(t)) return false;
  const same = (d: Date): boolean => (master.allDay ? toIsoDate(d) === toIsoDate(recurrenceId.date) : d.getTime() === t);
  if (master.rdates.some((r) => same(r.date))) return true;
  if (!master.rrule) return same(master.start);
  return expandOccurrences(
    { start: master.start, end: master.end, allDay: master.allDay, tzid: master.tzid, rrule: master.rrule, exdates: master.exdates },
    new Date(t - 1), new Date(t + 1), { max: 10 },
  ).some((o) => same(o.start));
}

/**
 * Pure: write `partstat` for `email` into a stored calendar object — into the master
 * VEVENT, or (with `recurrenceId`) into that instance's override component, which is
 * created from the master when it does not exist yet. Null when nothing matched.
 */
export function applyReplyToIcal(icalText: string, email: string, partstat: string, recurrenceId: IcalDateValue | null): string | null {
  const root = parseIcal(icalText);
  if (!root) return null;
  const master = findMainVEvent(root);
  if (!master) return null;
  const target = email.toLowerCase();
  if (!recurrenceId) return setPartstat(master, target, partstat) ? serializeComponent(root) + '\r\n' : null;

  const parsedMaster = parseVEventComponent(master, root);
  if (!parsedMaster || (!parsedMaster.rrule && parsedMaster.rdates.length === 0)) return null; // not a series
  const events = root.name === 'VEVENT' ? [root] : root.components.filter((c) => c.name === 'VEVENT');
  const existing = events.find((c) => {
    const rid = getProperty(c, 'RECURRENCE-ID');
    return c !== master && rid && parseDateProperty(rid, root)?.date.getTime() === recurrenceId.date.getTime();
  });
  if (existing) return setPartstat(existing, target, partstat) ? serializeComponent(root) + '\r\n' : null;
  if (root.name !== 'VCALENDAR') return null;
  // A new override only for a real instance of the series (bounded expansion),
  // and not more than MAX_REPLY_OVERRIDES of them: otherwise any (spoofed)
  // attendee could add phantom occurrences and grow icalData without limit.
  if (!isSeriesInstance(parsedMaster, recurrenceId)) return null;
  if (events.length - 1 >= MAX_REPLY_OVERRIDES) return null;

  // New override: copy of the master at the instance time, without recurrence rules
  const override = cloneComponent(master);
  if (!setPartstat(override, target, partstat)) return null;
  const startProp = getProperty(master, 'DTSTART');
  const tz = !parsedMaster.allDay && startProp?.params['TZID'] ? resolveTzid(startProp.params['TZID'], root) : null;
  const fmt = (name: string, d: Date) => parsedMaster.allDay
    ? { name, params: { VALUE: 'DATE' }, value: formatDateOnly(d) }
    : tz
      ? { name, params: { TZID: tz }, value: formatUtcDateTime(new Date(utcToWallClockMs(d.getTime(), tz))).slice(0, -1) }
      : { name, params: {}, value: formatUtcDateTime(d) };
  const start = recurrenceId.date;
  const end = new Date(start.getTime() + (parsedMaster.end.getTime() - parsedMaster.start.getTime()));
  override.properties = override.properties.filter((p) =>
    !['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID'].includes(p.name));
  const at = Math.max(0, override.properties.findIndex((p) => p.name === 'UID') + 1);
  override.properties.splice(at, 0, fmt('RECURRENCE-ID', start), fmt('DTSTART', start), fmt('DTEND', end));
  root.components.push(override);
  return serializeComponent(root) + '\r\n';
}

async function recipientAddresses(userId: string): Promise<Set<string>> {
  const [user, aliases] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } }),
  ]);
  return new Set([user?.email, ...aliases.map((a) => a.address)].filter((a): a is string => !!a).map((a) => a.toLowerCase()));
}

/**
 * Processes an incoming iTIP REPLY mail: verify sender, find the event by UID
 * in the recipient's own calendars, check organizer + SEQUENCE/DTSTAMP, update
 * the attendee in the `attendees` column and in `icalData`.
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
  // The From header alone is forgeable: the attendee must be authenticated.
  if (!isAttendeeAuthenticated(reply.attendeeEmail, ctx.senderAuth)) return false;

  const event = await prisma.calendarEvent.findFirst({
    where: { uid: reply.uid, calendar: { userId: ctx.recipientUserId } },
    select: { id: true, sequence: true, attendees: true, icalData: true, organizer: true },
  });
  if (!event) return false;

  // SEQUENCE check: ignore old REPLYs (RFC 5546 §3.4.3)
  if (reply.sequence < event.sequence) return false;

  // Only the organizer's copy takes REPLYs — not an invitee's copy of the same meeting
  if (event.organizer) {
    const own = await recipientAddresses(ctx.recipientUserId);
    if (!own.has(event.organizer.trim().replace(/^mailto:/i, '').toLowerCase())) return false;
  }

  const ridKey = reply.recurrenceId ? reply.recurrenceId.date.toISOString() : null;
  const attendees: unknown[] = Array.isArray(event.attendees) ? [...event.attendees] : [];
  let index = -1;
  for (let i = 0; i < attendees.length; i++) {
    const a = attendees[i];
    if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
      const email = (a as Record<string, unknown>)['email'];
      if (typeof email === 'string' && email.toLowerCase() === reply.attendeeEmail) { index = i; break; }
    }
  }
  if (index < 0) return false;
  const rec = attendees[index] as Record<string, unknown>;

  // DTSTAMP ordering for REPLYs with the same SEQUENCE (RFC 5546 §2.1.5)
  const stamps = (typeof rec['replyStamps'] === 'object' && rec['replyStamps'] !== null && !Array.isArray(rec['replyStamps'])
    ? rec['replyStamps'] : {}) as Record<string, string>;
  const stampKey = ridKey ?? 'master';
  const last = stamps[stampKey];
  if (reply.dtstamp && typeof last === 'string' && reply.dtstamp.getTime() < Date.parse(last)) return false;
  // Bounded bookkeeping: no new instance stamps beyond the cap.
  if (ridKey && last === undefined && Object.keys(stamps).length >= MAX_REPLY_STAMPS) return false;
  const newStamps: Record<string, string> = reply.dtstamp ? { ...stamps, [stampKey]: reply.dtstamp.toISOString() } : stamps;

  attendees[index] = ridKey
    ? { ...rec, replyStamps: newStamps } // a single instance does not change the series PARTSTAT
    : { ...rec, partstat: reply.partstat, rsvp: false, replyStamps: newStamps };

  const icalData = typeof event.icalData === 'string'
    ? applyReplyToIcal(event.icalData, reply.attendeeEmail, reply.partstat, reply.recurrenceId)
    : null;
  if (ridKey && !icalData) return false; // instance reply that could not be applied

  await prisma.calendarEvent.update({
    where: { id: event.id },
    data: { attendees: attendees as object, ...(icalData ? { icalData } : {}) },
  });
  return true;
}
