/**
 * v3.18.25 A5 — iMIP/iTIP Calendar Invitations (RFC 6047 / 5546).
 *
 * Erzeugt iMIP-konforme Einladungs-Mails für Calendar-Events. Outlook +
 * Gmail kompatibel: ICS-Body sowohl als `text/calendar; method=REQUEST` in
 * `multipart/alternative` (für Gmail) ALS AUCH als separater `.ics`-Anhang
 * in `multipart/mixed` (für Outlook-Win32).
 *
 * Recherche: research_imip Report v3.18.24 — Quellen RFC 6047, RFC 5546,
 * MS-OXCICAL, Apple Calendar Server CalDAV-Scheduling-Examples.
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
  sequence: number;     // 0 für REQUEST, +1 bei jedem UPDATE
  summary: string;
  description?: string;
  location?: string;
  dtStart: Date;
  dtEnd: Date;
  organizer: { email: string; cn?: string };
  attendees: AttendeeData[];
  publicHostname: string;  // für UID-Domain fallback
}

/**
 * Baut ein REQUEST-VCALENDAR. Gibt den ICS-String zurück.
 */
export function buildRequestIcs(ev: EventData): string {
  return buildIcs(ev, ICalCalendarMethod.REQUEST, ICalEventStatus.CONFIRMED);
}

/**
 * Baut ein CANCEL-VCALENDAR (Organizer löscht Event).
 */
export function buildCancelIcs(ev: EventData): string {
  return buildIcs(ev, ICalCalendarMethod.CANCEL, ICalEventStatus.CANCELLED);
}

/**
 * Baut ein REPLY-VCALENDAR (Gast antwortet — wir senden das aus wenn ein
 * User in CoreMail auf einen externen Termin Accept/Decline klickt).
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
  // REPLY hat GENAU EINEN attendee: den antwortenden Gast
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
    summary: ev.summary,
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.location ? { location: ev.location } : {}),
    stamp: new Date(),
    status,
    busystatus: ICalEventBusyStatus.BUSY,
    transparency: ICalEventTransparency.OPAQUE,
    organizer: { name: ev.organizer.cn ?? ev.organizer.email, email: ev.organizer.email },
  });

  // Outlook-Quirks — verbessert Frei/Gebucht-Status + Force-Inspector
  // (siehe Research v3.18.24, MS-OXCICAL)
  e.x([
    { key: 'X-MICROSOFT-CDO-BUSYSTATUS', value: 'BUSY' },
    { key: 'X-MICROSOFT-CDO-INTENDEDSTATUS', value: 'BUSY' },
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

  return cal.toString();
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
 * Baut eine stabile UID für ein Event. Format: `<eventId>@<hostname>`
 * (RFC 5545 §3.8.4.7 — empfiehlt domain-suffix).
 */
export function buildEventUid(eventId: string, publicHostname: string): string {
  const host = publicHostname.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `${eventId}@${host || 'coremail.local'}`;
}

/**
 * Baut die volle MIME-Einladung als Raw-Buffer (RFC 5322).
 *
 * Struktur:
 *   multipart/mixed
 *   ├── multipart/alternative   ← Gmail liest hieraus den text/calendar Part
 *   │   ├── text/plain          ← Fallback für Plain-Text-Reader
 *   │   ├── text/html           ← Human-Readable HTML
 *   │   └── text/calendar; method=REQUEST   ← Inline-iMIP
 *   └── application/ics; name="invite.ics"  ← Outlook-Win32 braucht den
 *                                              Anhang für RSVP-Buttons
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
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'crlf' });
  const info = await transport.sendMail({
    from: args.from.name
      ? { name: args.from.name, address: args.from.email }
      : args.from.email,
    to: args.to.join(', '),
    subject: args.subject,
    text: args.textBody,
    ...(args.htmlBody ? { html: args.htmlBody } : {}),
    // Inline-Alternative für Gmail
    alternatives: [
      {
        contentType: `text/calendar; charset=UTF-8; method=${args.method}`,
        content: args.ics,
      },
    ],
    // Zusätzlich .ics-Attachment für Outlook-Win32 RSVP-Buttons
    attachments: [
      {
        filename: `invite.ics`,
        content: args.ics,
        contentType: `application/ics; method=${args.method}`,
      },
    ],
    headers: {
      // Damit Mail-Clients erkennen dass die Mail eine Einladung ist
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
 * High-level Helper: erstellt REQUEST/CANCEL-Mail und queued sie via BullMQ
 * `smtp-outbound`. Übernimmt rawMessage-Pfad (base64) — funktioniert ohne
 * StructuredMessage-Erweiterung im Worker.
 */
export interface QueueInvitationOpts {
  ev: EventData;
  method: 'REQUEST' | 'CANCEL';
  /** BullMQ-Queue-Instanz (gleiche wie /mail/send) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: any;
  /** Tracking-ID — wird in den BullMQ-Job als messageId mitgegeben */
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

  await opts.queue.add('send', {
    messageId: opts.trackingId,
    from: opts.ev.organizer.email,
    to: opts.ev.attendees.map((a) => a.email),
    rawMessage: raw.toString('base64'),
  });
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
}

function buildPlainBody(ev: EventData, method: 'REQUEST' | 'CANCEL'): string {
  if (method === 'CANCEL') {
    return `Der Termin „${ev.summary}" wurde abgesagt.\n\n` +
           `Ursprünglicher Zeitpunkt: ${fmtDateTime(ev.dtStart)} – ${fmtDateTime(ev.dtEnd)}\n` +
           (ev.location ? `Ort: ${ev.location}\n` : '') +
           `\nOrganisator: ${ev.organizer.cn ?? ev.organizer.email} <${ev.organizer.email}>\n`;
  }
  return `Du bist zu einem Termin eingeladen.\n\n` +
         `Titel:  ${ev.summary}\n` +
         `Wann:   ${fmtDateTime(ev.dtStart)} – ${fmtDateTime(ev.dtEnd)}\n` +
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
      <p>Ursprünglicher Zeitpunkt: ${esc(fmtDateTime(ev.dtStart))} – ${esc(fmtDateTime(ev.dtEnd))}</p>
      ${ev.location ? `<p>Ort: ${esc(ev.location)}</p>` : ''}
      <p style="color:#888;font-size:12px">— gesendet von CoreMail</p>
    </div>`;
  }
  return `<div style="font-family:system-ui,sans-serif">
    <h2 style="margin:0 0 8px;color:#0078D4">📅 ${esc(ev.summary)}</h2>
    <table style="border-collapse:collapse">
      <tr><td style="padding:4px 8px;color:#666">Wann</td><td><strong>${esc(fmtDateTime(ev.dtStart))} – ${esc(fmtDateTime(ev.dtEnd))}</strong></td></tr>
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

