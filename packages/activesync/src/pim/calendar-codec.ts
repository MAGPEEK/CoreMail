/**
 * Calendar class codec ([MS-ASCAL]) — pure.
 *
 * Server → device: the stored calendar object (master VEVENT + RECURRENCE-ID overrides)
 * becomes calendar:* properties. Times are UTC instants; the item's zone travels in
 * calendar:TimeZone ([MS-ASDTYPE] 2.7.4): the master's TZID, else UTC for a timed series (the
 * server expands a UTC series in UTC, so the device must too), and the user's zone
 * (Settings → Region) for single timed events and for all-day events, whose StartTime /
 * EndTime are local midnights.
 * Recurrence ↔ RRULE (pim/recurrence.ts); EXDATEs and cancelled overrides are deleted
 * exceptions, the other overrides changed exceptions.
 *
 * Device → server: `parseCalendar` reads the client's ApplicationData; dates that depend on
 * whether the event is all-day are produced once the writer knows the effective value.
 */
import {
  utcToWallClockMs, wallClockToUtcMs, parseDateString, formatDateOnly, formatUtcDateTime, toIsoDate,
  type AttendeeInput, type Classification, type ParsedVEvent, type ShowAs, type VEventFields,
} from '@coremail/core/calendar';
import { pel, CP, type WbxmlElement } from '../wbxml.js';
import { supports } from '../protocol-version.js';
import { buildTextBody } from '../commands/body.js';
import { formatCompactDate, parseEasDate } from './dates.js';
import { decodeTimeZone, encodeTimeZone, ianaForTimeZone, standardOffsetMinutes, timeZoneOf } from './timezone.js';
import {
  calendarRecurrenceElements, easToRrule, parseRecurrence, rruleToEas, type EasRecurrence,
} from './recurrence.js';
import { intIn, itemData, type BodyInput, type ItemData } from './codec.js';
import type { RenderContext } from './types.js';

const C = CP.Calendar;
const DAY_MS = 86_400_000;
/** Longest reminder the webmail offers (4 weeks, as the REST API). */
export const MAX_REMINDER_MINUTES = 40_320;

const SENSITIVITY: Record<Classification, string> = { PUBLIC: '0', PRIVATE: '2', CONFIDENTIAL: '3' };
const SENSITIVITY_IN: Record<string, Classification> = { 0: 'PUBLIC', 1: 'PRIVATE', 2: 'PRIVATE', 3: 'CONFIDENTIAL' };
const BUSY: Record<ShowAs, string> = { FREE: '0', TENTATIVE: '1', BUSY: '2', OOF: '3' };
const BUSY_IN: Record<string, ShowAs> = { 0: 'FREE', 1: 'TENTATIVE', 2: 'BUSY', 3: 'OOF', 4: 'BUSY' };
/** calendar:AttendeeStatus ([MS-ASCAL] 2.2.2.5): 2 tentative, 3 accept, 4 decline, 5 not responded. */
const ATTENDEE_STATUS: Record<string, string> = { TENTATIVE: '2', ACCEPTED: '3', DECLINED: '4', 'NEEDS-ACTION': '5' };
const ATTENDEE_STATUS_IN: Record<string, string> = { 2: 'TENTATIVE', 3: 'ACCEPTED', 4: 'DECLINED', 5: 'NEEDS-ACTION' };
/** calendar:ResponseType ([MS-ASCAL] 2.2.2.38): 1 organizer, 2 tentative, 3 accepted, 4 declined, 5 not responded. */
const RESPONSE_TYPE: Record<string, string> = { TENTATIVE: '2', ACCEPTED: '3', DECLINED: '4' };

export interface CalendarRenderInput {
  main: ParsedVEvent;
  overrides: ParsedVEvent[];
  updatedAt: Date;
}

/** Zone an event is sent in (see the module comment). */
export function eventZone(main: Pick<ParsedVEvent, 'allDay' | 'tzid' | 'rrule' | 'rdates'>, userZone: string | null): string {
  if (main.allDay) return userZone ?? 'UTC';
  if (main.tzid) return main.tzid;
  // a UTC series is expanded in UTC (the device must too); a single event is the user's —
  // a phone that turns it into a series then sends that zone back (calendar-ical.ts)
  return main.rrule || main.rdates.length > 0 ? 'UTC' : userZone ?? 'UTC';
}

/** The instant a stored time is sent as: an all-day date becomes its local midnight in `zone`. */
export function sentInstant(d: Date, allDay: boolean, zone: string): Date {
  return allDay ? new Date(wallClockToUtcMs(d.getTime(), zone)) : d;
}

/** DTSTART as local wall clock (the implicit weekday / day / month of a rule). */
function startWall(main: ParsedVEvent, zone: string): Date {
  return main.allDay ? main.start : new Date(utcToWallClockMs(main.start.getTime(), zone));
}

/** RRULE of the master as an ActiveSync recurrence; null when it has none / no ActiveSync form. */
export function recurrenceOf(main: ParsedVEvent, zone: string): EasRecurrence | null {
  if (!main.rrule) return null;
  return rruleToEas(main.rrule, startWall(main, zone), (raw) => {
    const v = parseDateString(raw, main.tzid);
    return v ? sentInstant(v.date, v.dateOnly, zone) : null;
  });
}

function isOwn(email: string | null | undefined, own: readonly string[]): boolean {
  return !!email && own.includes(email.toLowerCase());
}

function attendeesElement(main: ParsedVEvent): WbxmlElement | null {
  if (main.attendees.length === 0) return null;
  return pel(C, 'Attendees', main.attendees.map((a) => pel(C, 'Attendee', [
    pel(C, 'Email', a.email),
    pel(C, 'Name', a.cn || a.email),
    pel(C, 'AttendeeStatus', ATTENDEE_STATUS[a.partstat] ?? '0'),
    pel(C, 'AttendeeType', a.cutype === 'ROOM' || a.cutype === 'RESOURCE' ? '3' : a.role === 'OPT-PARTICIPANT' ? '2' : '1'),
  ])));
}

/** [MS-ASCAL] MeetingStatus: 0 appointment, 1 / 5 own meeting (cancelled), 3 / 7 received meeting (cancelled). */
function meetingStatus(main: ParsedVEvent, own: readonly string[]): string {
  if (main.attendees.length === 0) return '0';
  const cancelled = main.status === 'CANCELLED';
  const mine = !main.organizer || isOwn(main.organizer, own);
  return mine ? (cancelled ? '5' : '1') : (cancelled ? '7' : '3');
}

function responseElements(main: ParsedVEvent, own: readonly string[]): WbxmlElement[] {
  if (main.attendees.length === 0) return [];
  if (!main.organizer || isOwn(main.organizer, own)) return [pel(C, 'ResponseType', '1')];
  const me = main.attendees.find((a) => isOwn(a.email, own));
  return [
    pel(C, 'ResponseRequested', me?.rsvp ? '1' : '0'),
    pel(C, 'ResponseType', (me && RESPONSE_TYPE[me.partstat]) ?? '5'),
  ];
}

function exceptionsElement(ev: CalendarRenderInput, zone: string, ctx: RenderContext): WbxmlElement | null {
  const { main } = ev;
  const at = (d: Date, allDay: boolean) => formatCompactDate(sentInstant(d, allDay, zone));
  const deleted = (d: Date) => pel(C, 'Exception', [pel(C, 'Deleted', '1'), pel(C, 'ExceptionStartTime', at(d, main.allDay))]);
  const items: WbxmlElement[] = main.exdates.map((x) => deleted(x.date));
  for (const o of ev.overrides) {
    const rid = o.recurrenceId!.date;
    if (o.status === 'CANCELLED') { items.push(deleted(rid)); continue; }
    items.push(pel(C, 'Exception', [
      pel(C, 'ExceptionStartTime', at(rid, main.allDay)),
      pel(C, 'Subject', o.summary),
      pel(C, 'StartTime', at(o.start, o.allDay)),
      pel(C, 'EndTime', at(o.end, o.allDay)),
      ...(o.description !== main.description ? [buildTextBody(ctx.bodyPref, { bodyText: o.description, bodyHtml: '' }, ctx.version)] : []),
      pel(C, 'Location', o.location),
      pel(C, 'Sensitivity', SENSITIVITY[o.classification]),
      pel(C, 'BusyStatus', BUSY[o.showAs]),
      pel(C, 'AllDayEvent', o.allDay ? '1' : '0'),
      ...(o.alarm ? [pel(C, 'Reminder', String(o.alarm.minutes))] : []),
    ]));
  }
  return items.length > 0 ? pel(C, 'Exceptions', items) : null;
}

/** calendar:* properties of a stored event, in [MS-ASCAL] order. */
export function renderCalendar(ev: CalendarRenderInput, ctx: RenderContext): WbxmlElement[] {
  const { main } = ev;
  const own = ctx.user.addresses;
  const zone = eventZone(main, ctx.user.timeZone);
  const start = sentInstant(main.start, main.allDay, zone);
  const year = new Date(utcToWallClockMs(start.getTime(), zone)).getUTCFullYear();
  const recurrence = recurrenceOf(main, zone);
  const exceptions = recurrence ? exceptionsElement(ev, zone, ctx) : null;
  const attendees = attendeesElement(main);
  const organizer = main.organizer ?? (main.attendees.length > 0 ? ctx.user.email : null);
  const organizerName = organizer && isOwn(organizer, own) ? ctx.user.displayName || organizer : organizer;
  return [
    pel(C, 'TimeZone', encodeTimeZone(timeZoneOf(zone, year))),
    pel(C, 'DtStamp', formatCompactDate(ev.updatedAt)),
    pel(C, 'StartTime', formatCompactDate(start)),
    pel(C, 'Subject', main.summary),
    ...(main.uid ? [pel(C, 'UID', main.uid)] : []),
    ...(organizer ? [pel(C, 'OrganizerName', organizerName!), pel(C, 'OrganizerEmail', organizer)] : []),
    ...(attendees ? [attendees] : []),
    ...(main.location ? [pel(C, 'Location', main.location)] : []),
    pel(C, 'EndTime', formatCompactDate(sentInstant(main.end, main.allDay, zone))),
    ...(recurrence ? [pel(C, 'Recurrence', calendarRecurrenceElements(recurrence, formatCompactDate, supports(ctx.version, 'recurrenceFirstDayOfWeek')))] : []),
    ...(exceptions ? [exceptions] : []),
    buildTextBody(ctx.bodyPref, { bodyText: main.description, bodyHtml: '' }, ctx.version),
    pel(C, 'Sensitivity', SENSITIVITY[main.classification]),
    pel(C, 'BusyStatus', BUSY[main.showAs]),
    pel(C, 'AllDayEvent', main.allDay ? '1' : '0'),
    ...(main.alarm ? [pel(C, 'Reminder', String(main.alarm.minutes))] : []),
    pel(C, 'MeetingStatus', meetingStatus(main, own)),
    ...(supports(ctx.version, 'meetingResponseType') ? responseElements(main, own) : []),
  ];
}

// ─── Device → server ─────────────────────────────────────────────────────────

/** Start / end as VEventFields expect them: instants, or `YYYY-MM-DD` dates for all-day. */
export interface EventTimes { start: Date | string; end: Date | string }

export interface CalendarExceptionInput {
  /** Original start of the instance (UTC instant; all-day: the date at UTC midnight). */
  originalStart: Date;
  deleted: boolean;
  /** Changed fields of the instance (only those the client sent). */
  fields: VEventFields;
}

export interface CalendarInput {
  data: ItemData;
  /** IANA zone of the client's TimeZone; null = none / unknown. */
  zone: string | null;
  allDay?: boolean;
  subject?: string;
  location?: string;
  body?: BodyInput;
  showAs?: ShowAs;
  classification?: Classification;
  reminderMinutes?: number;
  uid?: string;
  organizer?: { email: string; cn?: string };
  attendees?: AttendeeInput[];
  /** Present but not understood → undefined plus `data.present` has Recurrence. */
  recurrence?: EasRecurrence;
  /** Start / end for the effective all-day value; undefined when the client sent neither. */
  times(allDay: boolean): EventTimes | undefined;
  /** The client's exceptions for a series with the effective all-day value; undefined when absent. */
  exceptions(allDay: boolean): CalendarExceptionInput[] | undefined;
}

const MAX_ATTENDEES = 100;
const MAX_UID_LENGTH = 300;

/**
 * UTC midnight of the local date of `utc`. An all-day start / end is a local midnight, so it is
 * rounded to the nearest one (absorbs a daylight-saving hour of a zone known only by its
 * standard offset); `floor` keeps the date of any time of day (Until).
 */
function localDate(utc: Date, zone: string | null, fallbackOffsetMin: number, floor = false): Date {
  const wall = zone ? utcToWallClockMs(utc.getTime(), zone) : utc.getTime() + fallbackOffsetMin * 60_000;
  return new Date((floor ? Math.floor(wall / DAY_MS) : Math.round(wall / DAY_MS)) * DAY_MS);
}

function parseAttendees(el: WbxmlElement): AttendeeInput[] {
  const out: AttendeeInput[] = [];
  for (const a of el.children ?? []) {
    if (typeof a === 'string' || a.name !== 'Attendee') continue;
    const d = itemData(a);
    const email = (d.text('Email') ?? '').trim();
    if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(email) || out.length >= MAX_ATTENDEES) continue;
    const type = d.text('AttendeeType');
    const name = d.text('Name')?.trim();
    out.push({
      email,
      ...(name && name !== email ? { cn: name } : {}),
      partstat: ATTENDEE_STATUS_IN[d.text('AttendeeStatus') ?? ''] ?? 'NEEDS-ACTION',
      role: type === '2' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT',
      ...(type === '3' ? { cutype: 'RESOURCE' } : {}),
    });
  }
  return out;
}

function commonFields(d: ItemData): Pick<CalendarInput, 'subject' | 'location' | 'body' | 'showAs' | 'classification' | 'reminderMinutes'> {
  const out: ReturnType<typeof commonFields> = {};
  const subject = d.text('Subject');
  if (subject !== undefined) out.subject = subject;
  const location = d.text('Location');
  if (location !== undefined) out.location = location;
  const body = d.body();
  if (body) out.body = body;
  const busy = BUSY_IN[d.text('BusyStatus') ?? ''];
  if (busy) out.showAs = busy;
  const cls = SENSITIVITY_IN[d.text('Sensitivity') ?? ''];
  if (cls) out.classification = cls;
  const reminder = intIn(d.text('Reminder'), 0, MAX_REMINDER_MINUTES);
  if (reminder !== undefined) out.reminderMinutes = reminder;
  return out;
}

/** The client's ApplicationData of a calendar item. `userZone` is preferred when the TimeZone matches it. */
export function parseCalendar(appData: WbxmlElement, userZone: string | null): CalendarInput {
  const d = itemData(appData);
  const start = parseEasDate(d.text('StartTime') ?? '');
  const end = parseEasDate(d.text('EndTime') ?? '');
  const blob = d.text('TimeZone');
  const device = blob ? decodeTimeZone(blob) : null;
  const zone = device ? ianaForTimeZone(device, (start ?? new Date()).getUTCFullYear(), [userZone]) : null;
  const fallbackOffset = device ? standardOffsetMinutes(device) : 0;
  const allDayText = d.text('AllDayEvent');
  const toTimes = (allDay: boolean, s: Date, e: Date | null): EventTimes => {
    if (!allDay) return { start: s, end: e && e.getTime() >= s.getTime() ? e : s };
    const sd = localDate(s, zone, fallbackOffset);
    const ed = e ? localDate(e, zone, fallbackOffset) : sd;
    return { start: toIsoDate(sd), end: toIsoDate(ed.getTime() > sd.getTime() ? ed : new Date(sd.getTime() + DAY_MS)) };
  };
  const recurrenceEl = d.child('Recurrence');
  const recurrence = recurrenceEl ? parseRecurrence(recurrenceEl, parseEasDate) : null;
  const organizerEmail = d.text('OrganizerEmail')?.trim();
  const organizerName = d.text('OrganizerName')?.trim();
  const attendeesEl = d.child('Attendees');
  const uid = d.text('UID')?.trim();

  const input: CalendarInput = {
    data: d,
    zone,
    ...commonFields(d),
    ...(allDayText !== undefined ? { allDay: allDayText === '1' } : {}),
    // [MS-ASCAL] UID: at most 300 characters (a longer one is replaced by a server UID)
    ...(uid && uid.length <= MAX_UID_LENGTH ? { uid } : {}),
    ...(organizerEmail && organizerEmail.includes('@') ? { organizer: { email: organizerEmail, ...(organizerName ? { cn: organizerName } : {}) } } : {}),
    ...(attendeesEl ? { attendees: parseAttendees(attendeesEl) } : {}),
    ...(recurrence ? { recurrence } : {}),
    times: (allDay) => (start ? toTimes(allDay, start, end) : undefined),
    exceptions: (allDay) => {
      const list = d.child('Exceptions');
      if (!list) return undefined;
      const out: CalendarExceptionInput[] = [];
      for (const x of list.children ?? []) {
        if (typeof x === 'string' || x.name !== 'Exception') continue;
        const xd = itemData(x);
        const original = parseEasDate(xd.text('ExceptionStartTime') ?? '');
        if (!original) continue;
        const originalStart = allDay ? localDate(original, zone, fallbackOffset) : original;
        if (xd.text('Deleted') === '1') { out.push({ originalStart, deleted: true, fields: {} }); continue; }
        const xs = parseEasDate(xd.text('StartTime') ?? '');
        const xe = parseEasDate(xd.text('EndTime') ?? '');
        const xAllDay = xd.text('AllDayEvent') !== undefined ? xd.text('AllDayEvent') === '1' : allDay;
        const common = commonFields(xd);
        out.push({
          originalStart,
          deleted: false,
          fields: {
            ...(common.subject !== undefined ? { summary: common.subject } : {}),
            ...(common.location !== undefined ? { location: common.location } : {}),
            ...(common.body ? { description: common.body.text } : {}),
            ...(common.showAs ? { showAs: common.showAs } : {}),
            ...(common.classification ? { classification: common.classification } : {}),
            ...(common.reminderMinutes !== undefined ? { alarm: { minutes: common.reminderMinutes } } : {}),
            ...(xs ? { ...toTimes(xAllDay, xs, xe), allDay: xAllDay } : {}),
          },
        });
      }
      return out;
    },
  };
  return input;
}

/** UNTIL value of a rule written from a device recurrence: a date for all-day series, else UTC. */
export function untilValue(allDay: boolean, zone: string | null): (d: Date) => string {
  return (d) => (allDay ? formatDateOnly(localDate(d, zone, 0, true)) : formatUtcDateTime(d));
}

/** RRULE of a device recurrence. */
export function rruleOf(r: EasRecurrence, allDay: boolean, zone: string | null): string {
  return easToRrule(r, untilValue(allDay, zone));
}
