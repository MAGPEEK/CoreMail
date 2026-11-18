/**
 * v3.18.25 A5 — iMIP/iTIP Calendar Invitations (RFC 6047 / 5546).
 *
 * Generates iMIP-compliant invitation mails for calendar events. Outlook +
 * Gmail compatible: ICS body both as `text/calendar; method=REQUEST` in
 * `multipart/alternative` (for Gmail) AND as a separate `.ics` attachment
 * in `multipart/mixed` (for Outlook Win32).
 *
 * Research: research_imip report v3.18.24 — sources RFC 6047, RFC 5546,
 * MS-OXCICAL, Apple Calendar Server CalDAV scheduling examples.
 */
import ical, {
  ICalCalendarMethod,
  ICalAttendeeStatus,
  ICalAttendeeRole,
  ICalAttendeeType,
  ICalEventStatus,
  ICalEventBusyStatus,
  ICalEventTransparency,
} from 'ical-generator';
import nodemailer from 'nodemailer';
import type { Readable } from 'node:stream';

export type AttendeeStatus = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

export interface AttendeeData {
  email: string;
  cn?: string;          // CN = common name
  partstat?: AttendeeStatus;
  role?: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT' | 'CHAIR';
  rsvp?: boolean;
}

export interface EventData {
  uid: string;
  sequence: number;     // 0 for REQUEST, +1 on every UPDATE
  summary: string;
  description?: string;
  location?: string;
  dtStart: Date;
  dtEnd: Date;
  /** All-day: dtStart/dtEnd are UTC midnights, dtEnd exclusive → VALUE=DATE. */
  allDay?: boolean;
  /** RECUR value (without "RRULE:") for recurring invitations. */
  rrule?: string | null;
  /** 9.4: deleted occurrences of the series (EXDATE). */
  exdates?: Date[];
  /** 9.4: the invitation concerns one occurrence only (RECURRENCE-ID = its original start). */
  recurrenceId?: Date;
  /** 9.4: show-as of the organizer's event (default BUSY). */
  showAs?: 'FREE' | 'TENTATIVE' | 'BUSY' | 'OOF';
  organizer: { email: string; cn?: string };
  attendees: AttendeeData[];
  publicHostname: string;  // for UID domain fallback
  /** 9.4: organizer's time zone (Settings → Region) for the times in the mail text; '' = server zone. */
  timeZone?: string;
}

/**
 * Builds a REQUEST VCALENDAR. Returns the ICS string.
 */
export function buildRequestIcs(ev: EventData): string {
  return buildIcs(ev, ICalCalendarMethod.REQUEST, ICalEventStatus.CONFIRMED);
}

/**
 * Builds a CANCEL VCALENDAR (organizer deletes the event).
 */
export function buildCancelIcs(ev: EventData): string {
  return buildIcs(ev, ICalCalendarMethod.CANCEL, ICalEventStatus.CANCELLED);
}

/**
 * Builds a REPLY VCALENDAR (guest responds — we send this when a CoreMail
 * user clicks Accept/Decline on an external appointment).
 */
export function buildReplyIcs(ev: EventData & { responder: AttendeeData }): string {
  const cal = ical({
    prodId: '//CoreMail//iMIP//EN',
    method: ICalCalendarMethod.REPLY,
  });
  const e = cal.createEvent({
    id: ev.uid,
    sequence: ev.sequence,
    start: ev.dtStart,
    end: ev.dtEnd,
    summary: ev.summary,
    stamp: new Date(),
    organizer: { name: ev.organizer.cn ?? ev.organizer.email, email: ev.organizer.email },
  });
  // REPLY has EXACTLY ONE attendee: the responding guest
  e.createAttendee({
    email: ev.responder.email,
    name: ev.responder.cn ?? ev.responder.email,
    status: mapPartstatToStatus(ev.responder.partstat ?? 'ACCEPTED'),
    rsvp: false,
    role: ICalAttendeeRole.REQ,
    type: ICalAttendeeType.INDIVIDUAL,
  });
  return cal.toString();
}

function buildIcs(ev: EventData, method: ICalCalendarMethod, status: ICalEventStatus): string {
  const cal = ical({
    prodId: '//CoreMail//iMIP//EN',
    method,
  });
  const e = cal.createEvent({
    id: ev.uid,
    sequence: ev.sequence,
    start: ev.dtStart,
    end: ev.dtEnd,
    ...(ev.allDay ? { allDay: true } : {}),
    ...(ev.rrule && !ev.recurrenceId ? { repeating: recurrenceLines(ev) } : {}),
    // all-day: RECURRENCE-ID is a DATE like DTSTART — added below (the generator writes a date-time)
    ...(ev.recurrenceId && !ev.allDay ? { recurrenceId: ev.recurrenceId } : {}),
    summary: ev.summary,
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.location ? { location: ev.location } : {}),
    stamp: new Date(),
    status,
    busystatus: BUSY_STATUS[ev.showAs ?? 'BUSY'],
    transparency: ev.showAs === 'FREE' ? ICalEventTransparency.TRANSPARENT : ICalEventTransparency.OPAQUE,
    organizer: { name: ev.organizer.cn ?? ev.organizer.email, email: ev.organizer.email },
  });

  // Outlook quirks — improves free/busy status + force-inspector
  // (see research v3.18.24, MS-OXCICAL)
  e.x([
    { key: 'X-MICROSOFT-CDO-INTENDEDSTATUS', value: ev.showAs ?? 'BUSY' },
    { key: 'X-MICROSOFT-CDO-IMPORTANCE', value: '1' },
    { key: 'X-MS-OLK-FORCEINSPECTOROPEN', value: 'TRUE' },
  ]);

  for (const a of ev.attendees) {
    e.createAttendee({
      email: a.email,
      name: a.cn ?? a.email,
      status: mapPartstatToStatus(a.partstat ?? 'NEEDS-ACTION'),
      rsvp: a.rsvp ?? true,
      role: a.role === 'OPT-PARTICIPANT' ? ICalAttendeeRole.OPT
          : a.role === 'CHAIR'           ? ICalAttendeeRole.CHAIR
          : ICalAttendeeRole.REQ,
      type: ICalAttendeeType.INDIVIDUAL,
    });
  }

  const ics = cal.toString();
  return ev.recurrenceId && ev.allDay ? withDateRecurrenceId(ics, ev.recurrenceId) : ics;
}

const utcDate = (d: Date): string => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;

/** RECURRENCE-ID;VALUE=DATE of an all-day occurrence, added to the (single) VEVENT. */
export function withDateRecurrenceId(ics: string, recurrenceId: Date): string {
  return ics.replace(/\r?\nEND:VEVENT/, (end) => `\r\nRECURRENCE-ID;VALUE=DATE:${utcDate(recurrenceId)}${end}`);
}

const BUSY_STATUS: Record<NonNullable<EventData['showAs']>, ICalEventBusyStatus> = {
  FREE: ICalEventBusyStatus.FREE,
  TENTATIVE: ICalEventBusyStatus.TENTATIVE,
  BUSY: ICalEventBusyStatus.BUSY,
  OOF: ICalEventBusyStatus.OOF,
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** RRULE plus one EXDATE line per deleted occurrence (UTC, or dates for all-day series). */
export function recurrenceLines(ev: Pick<EventData, 'rrule' | 'exdates' | 'allDay'>): string {
  const lines = [`RRULE:${(ev.rrule ?? '').replace(/^RRULE:/i, '')}`];
  for (const d of ev.exdates ?? []) {
    const date = utcDate(d);
    lines.push(ev.allDay
      ? `EXDATE;VALUE=DATE:${date}`
      : `EXDATE:${date}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`);
  }
  return lines.join('\n');
}

function mapPartstatToStatus(p: AttendeeStatus): ICalAttendeeStatus {
  switch (p) {
    case 'ACCEPTED':  return ICalAttendeeStatus.ACCEPTED;
    case 'DECLINED':  return ICalAttendeeStatus.DECLINED;
    case 'TENTATIVE': return ICalAttendeeStatus.TENTATIVE;
    default:          return ICalAttendeeStatus.NEEDSACTION;
  }
}

/**
 * Builds a stable UID for an event. Format: `<eventId>@<hostname>`
 * (RFC 5545 §3.8.4.7 — recommends a domain suffix).
 */
export function buildEventUid(eventId: string, publicHostname: string): string {
  const host = publicHostname.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `${eventId}@${host || 'coremail.local'}`;
}

/**
 * Builds the full MIME invitation as a raw buffer (RFC 5322).
 *
 * Structure:
 *   multipart/mixed
 *   ├── multipart/alternative   ← Gmail reads the text/calendar part from here
 *   │   ├── text/plain          ← fallback for plain-text readers
 *   │   ├── text/html           ← human-readable HTML
 *   │   └── text/calendar; method=REQUEST   ← inline iMIP
 *   └── application/ics; name="invite.ics"  ← Outlook Win32 needs the
 *                                              attachment for RSVP buttons
 */
export async function buildInvitationMime(args: {
  ics: string;
  method: 'REQUEST' | 'CANCEL' | 'REPLY';
  from: { email: string; name?: string };
  to: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
}): Promise<Buffer> {
  const methodLower = args.method.toLowerCase();
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' }); // CRLF
  const info = await transport.sendMail({
    from: args.from.name
      ? { name: args.from.name, address: args.from.email }
      : args.from.email,
    to: args.to.join(', '),
    subject: args.subject,
    text: args.textBody,
    ...(args.htmlBody ? { html: args.htmlBody } : {}),
    // Inline alternative for Gmail
    alternatives: [
      {
        contentType: `text/calendar; charset=UTF-8; method=${args.method}`,
        content: args.ics,
      },
    ],
    // Additional .ics attachment for Outlook Win32 RSVP buttons
    attachments: [
      {
        filename: `invite.ics`,
        content: args.ics,
        contentType: `application/ics; method=${args.method}`,
      },
    ],
    headers: {
      // So mail clients recognize the mail as an invitation
      'X-Coremail-Calendar-Method': args.method,
    },
  });
  const stream = info.message as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void methodLower;
}

/**
 * High-level helper: creates a REQUEST/CANCEL mail and queues it via BullMQ
 * `smtp-outbound`. Uses the rawMessage path (base64) — works without a
 * StructuredMessage extension in the worker.
 */
export interface QueueInvitationOpts {
  ev: EventData;
  method: 'REQUEST' | 'CANCEL';
  /** BullMQ queue instance (same as /mail/send) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: any;
  /** Tracking ID — passed into the BullMQ job as messageId */
  trackingId: string;
}

export async function enqueueInvitation(opts: QueueInvitationOpts): Promise<void> {
  const ics = opts.method === 'REQUEST'
    ? buildRequestIcs(opts.ev)
    : buildCancelIcs(opts.ev);

  const subjectPrefix = opts.method === 'CANCEL' ? '[Abgesagt] ' : '';
  const textBody = buildPlainBody(opts.ev, opts.method);
  const htmlBody = buildHtmlBody(opts.ev, opts.method);

  const raw = await buildInvitationMime({
    ics,
    method: opts.method,
    from: opts.ev.organizer.cn
      ? { email: opts.ev.organizer.email, name: opts.ev.organizer.cn }
      : { email: opts.ev.organizer.email },
    to: opts.ev.attendees.map((a) => a.email),
    subject: `${subjectPrefix}${opts.ev.summary}`,
    textBody,
    htmlBody,
  });

  const { getOutboundJobOptions } = await import('@coremail/storage/queue-options');
  await opts.queue.add('send', {
    messageId: opts.trackingId,
    from: opts.ev.organizer.email,
    to: opts.ev.attendees.map((a) => a.email),
    rawMessage: raw.toString('base64'),
  }, await getOutboundJobOptions());
}

/**
 * Time shown in the invitation text. Timed events in the organizer's zone (9.4),
 * all-day events as the date only (stored as UTC midnight).
 */
export function formatInvitationTime(d: Date, allDay: boolean, timeZone?: string): string {
  if (allDay) return d.toLocaleDateString('de-DE', { dateStyle: 'full', timeZone: 'UTC' });
  const text = d.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
  return timeZone ? `${text} (${timeZone})` : text;
}

/** "start – end" of the invitation text; all-day ends are exclusive → the last day is shown (once for one day). */
export function formatInvitationRange(ev: Pick<EventData, 'dtStart' | 'dtEnd' | 'allDay' | 'timeZone'>): string {
  if (ev.allDay === true) {
    const lastDay = new Date(Math.max(ev.dtStart.getTime(), ev.dtEnd.getTime() - 86_400_000));
    const first = formatInvitationTime(ev.dtStart, true);
    const last = formatInvitationTime(lastDay, true);
    return first === last ? first : `${first} – ${last}`;
  }
  return `${formatInvitationTime(ev.dtStart, false, ev.timeZone)} – ${formatInvitationTime(ev.dtEnd, false, ev.timeZone)}`;
}

const fmtRange = formatInvitationRange;

function buildPlainBody(ev: EventData, method: 'REQUEST' | 'CANCEL'): string {
  if (method === 'CANCEL') {
    return `Der Termin „${ev.summary}" wurde abgesagt.\n\n` +
           `Ursprünglicher Zeitpunkt: ${fmtRange(ev)}\n` +
           (ev.location ? `Ort: ${ev.location}\n` : '') +
           `\nOrganisator: ${ev.organizer.cn ?? ev.organizer.email} <${ev.organizer.email}>\n`;
  }
  return `Du bist zu einem Termin eingeladen.\n\n` +
         `Titel:  ${ev.summary}\n` +
         `Wann:   ${fmtRange(ev)}\n` +
         (ev.location ? `Ort:    ${ev.location}\n` : '') +
         `Wer:    ${ev.organizer.cn ?? ev.organizer.email} <${ev.organizer.email}>\n` +
         (ev.description ? `\n${ev.description}\n` : '') +
         `\n— gesendet von CoreMail`;
}

function buildHtmlBody(ev: EventData, method: 'REQUEST' | 'CANCEL'): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  if (method === 'CANCEL') {
    return `<div style="font-family:system-ui,sans-serif">
      <p style="color:#c33"><strong>Termin abgesagt:</strong> ${esc(ev.summary)}</p>
      <p>Ursprünglicher Zeitpunkt: ${esc(fmtRange(ev))}</p>
      ${ev.location ? `<p>Ort: ${esc(ev.location)}</p>` : ''}
      <p style="color:#888;font-size:12px">— gesendet von CoreMail</p>
    </div>`;
  }
  return `<div style="font-family:system-ui,sans-serif">
    <h2 style="margin:0 0 8px;color:#0078D4">📅 ${esc(ev.summary)}</h2>
    <table style="border-collapse:collapse">
      <tr><td style="padding:4px 8px;color:#666">Wann</td><td><strong>${esc(fmtRange(ev))}</strong></td></tr>
      ${ev.location ? `<tr><td style="padding:4px 8px;color:#666">Ort</td><td>${esc(ev.location)}</td></tr>` : ''}
      <tr><td style="padding:4px 8px;color:#666">Wer</td><td>${esc(ev.organizer.cn ?? ev.organizer.email)}</td></tr>
    </table>
    ${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
    <p style="color:#888;font-size:12px;margin-top:16px">
      Antworten direkt aus deinem Mail-Client (Annehmen / Vielleicht / Ablehnen).
      <br>— gesendet von CoreMail
    </p>
  </div>`;
}

