/**
 * Calendar objects written by ActiveSync clients (pure): a new object from a client Add, the
 * stored object patched by a client Change, and the row columns derived from an object. A
 * stored object is patched, never regenerated — properties the device does not know
 * (VTIMEZONE, X-…, e-mail alarms, override details) survive a device change.
 */
import {
  buildVCalendar, findMainVEvent, getProperty, parseCalendarObject, parseIcal, patchVEvent, serializeComponent,
  utcToWallClockMs, type ParsedVEvent, type VEventPatch,
} from '@coremail/core/calendar';
import { excludeOccurrence, restoreOccurrence, upsertOccurrence } from '@coremail/core/calendar-exceptions';
import { changedBody, clears } from './codec.js';
import { eventZone, rruleOf, type CalendarExceptionInput, type CalendarInput } from './calendar-codec.js';
import { isRepresentable } from './recurrence.js';
import type { WriteContext } from './types.js';

export interface CalendarRow {
  id: string; calendarId: string; uid: string; icalData: string; summary: string; description: string; location: string;
  dtStart: Date; dtEnd: Date; allDay: boolean; rrule: string | null; organizer: string | null; attendees: unknown;
  classification: string; showAs: string; status: string; sequence: number; updatedAt: Date;
}

/** The stored object as parsed VEVENTs; a row whose calendar data is unreadable is rendered from its columns. */
export function parsedEvent(row: CalendarRow): { main: ParsedVEvent; overrides: ParsedVEvent[] } {
  const parsed = parseCalendarObject(row.icalData);
  if (parsed) return parsed;
  return {
    main: {
      uid: row.uid, summary: row.summary, description: row.description, location: row.location,
      start: row.dtStart, end: row.dtEnd, allDay: row.allDay, tzid: null, rrule: row.rrule, exdates: [], rdates: [],
      recurrenceId: null, classification: row.classification === 'PRIVATE' || row.classification === 'CONFIDENTIAL' ? row.classification : 'PUBLIC',
      status: row.status, sequence: row.sequence, organizer: row.organizer, attendees: [], showAs: 'BUSY', alarm: null,
    },
    overrides: [],
  };
}

export interface EventColumns {
  icalData: string; summary: string; description: string; location: string; dtStart: Date; dtEnd: Date;
  allDay: boolean; rrule: string | null; recurring: boolean; classification: string; showAs: string;
  status: string; organizer: string | null; attendees: object[]; sequence?: number;
}

/** Row columns derived from the calendar object (the same fields as CalDAV stores). */
export function columnsOf(icalData: string): EventColumns | null {
  const parsed = parseCalendarObject(icalData);
  if (!parsed) return null;
  const ev = parsed.main;
  return {
    icalData,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    dtStart: ev.start,
    dtEnd: ev.end,
    allDay: ev.allDay,
    rrule: ev.rrule,
    recurring: ev.rrule !== null || ev.rdates.length > 0,
    classification: ev.classification,
    showAs: ev.showAs,
    status: ev.status ?? 'CONFIRMED',
    organizer: ev.organizer,
    attendees: ev.attendees.map((a) => ({ ...a })),
    ...(ev.sequence !== null ? { sequence: ev.sequence } : {}),
  };
}

/** Exceptions of the client applied to a series (EXDATE / override / restored instance). */
export function applyExceptions(icalData: string, wanted: CalendarExceptionInput[]): string {
  const parsed = parseCalendarObject(icalData);
  if (!parsed?.main.rrule) return icalData;
  const sameStart = (a: Date, b: Date) => a.getTime() === b.getTime();
  let ical = icalData;
  // instances the client no longer lists as exceptions are back as generated
  const existing = [...parsed.main.exdates.map((x) => x.date), ...parsed.overrides.map((o) => o.recurrenceId!.date)];
  for (const at of existing) {
    if (!wanted.some((w) => sameStart(w.originalStart, at))) ical = restoreOccurrence(ical, at) ?? ical;
  }
  for (const w of wanted) {
    ical = (w.deleted ? excludeOccurrence(ical, w.originalStart) : upsertOccurrence(ical, w.originalStart, w.fields)) ?? ical;
  }
  return ical;
}

/** Every override and EXDATE removed (a series that became a single event). */
function withoutExceptions(icalData: string): string {
  const root = parseIcal(icalData);
  const master = root ? findMainVEvent(root) : null;
  if (!root || !master) return icalData;
  root.components = root.components.filter((c) => c === master || c.name !== 'VEVENT' || !getProperty(c, 'RECURRENCE-ID'));
  master.properties = master.properties.filter((p) => p.name !== 'EXDATE');
  return serializeComponent(root) + '\r\n';
}

const alarmOf = (minutes: number | undefined) => (minutes === undefined ? null : { minutes });

const zoned = (zone: string | null | undefined): string | null => (zone && zone !== 'UTC' ? zone : null);

/**
 * Zone a timed event written by a device is stored in (TZID), so a series keeps its
 * wall-clock time across DST changes: the device's TimeZone; an unknown one → the user's
 * Settings → Region zone; null = UTC.
 */
export function deviceEventZone(deviceZone: string | null, userZone: string | null): string | null {
  return deviceZone ? zoned(deviceZone) : zoned(userZone);
}

/**
 * Zone a stored timed event without TZID moves to when a device turns it into a series: the
 * device's TimeZone, else (UTC — the zone the server sent it with — or unknown) the user's
 * Region zone; null = it stays in UTC.
 */
export function seriesAnchorZone(deviceZone: string | null, userZone: string | null): string | null {
  return zoned(deviceZone) ?? zoned(userZone);
}

/** Sequence +1 when a property that invitations carry changed (as the REST writer). */
function schedulingChanged(before: ParsedVEvent, after: ParsedVEvent): boolean {
  const emails = (e: ParsedVEvent) => e.attendees.map((a) => a.email.toLowerCase()).sort().join(',');
  return before.summary !== after.summary || before.location !== after.location || before.allDay !== after.allDay
    || before.start.getTime() !== after.start.getTime() || before.end.getTime() !== after.end.getTime()
    || before.rrule !== after.rrule || emails(before) !== emails(after);
}

/** A new calendar object from a client item; null when it has no start. */
export function newEventIcal(input: CalendarInput, ctx: WriteContext, uid: string): string | null {
  const allDay = input.allDay ?? false;
  const times = input.times(allDay);
  if (!times) return null;
  const attendees = input.attendees ?? [];
  const organizer = input.organizer ?? (attendees.length > 0 ? { email: ctx.user.email, ...(ctx.user.displayName ? { cn: ctx.user.displayName } : {}) } : null);
  const rrule = input.recurrence ? rruleOf(input.recurrence, allDay, input.zone) : null;
  const zone = allDay ? null : deviceEventZone(input.zone, ctx.user.timeZone);
  const ical = buildVCalendar({
    uid,
    summary: input.subject ?? '',
    description: input.body?.text ?? '',
    location: input.location ?? '',
    ...times,
    allDay,
    ...(rrule ? { rrule } : {}),
    // timed: in the device's zone — a series keeps its wall-clock time across DST, and a single
    // event the phone later turns into a series already has its zone
    ...(zone ? { tzid: zone } : {}),
    classification: input.classification ?? 'PUBLIC',
    showAs: input.showAs ?? 'BUSY',
    sequence: 0,
    ...(organizer ? { organizer } : {}),
    attendees,
    alarm: alarmOf(input.reminderMinutes),
  });
  const exceptions = rrule ? input.exceptions(allDay) : undefined;
  return exceptions ? applyExceptions(ical, exceptions) : ical;
}

/** The stored object after a client Change ([MS-ASCMD] Change: absent elements are cleared unless ghosted). */
export function changedEventIcal(row: CalendarRow, input: CalendarInput, ctx: WriteContext): string {
  const before = parsedEvent(row).main;
  const zone = eventZone(before, ctx.user.timeZone);
  const sentRule = isRepresentable(before.rrule, before.allDay ? before.start : new Date(utcToWallClockMs(before.start.getTime(), zone)));
  const has = (name: string) => input.data.present.has(name);
  const clear = (name: string) => !has(name) && clears(ctx.supported, name);
  const allDay = input.allDay ?? before.allDay;
  const times = input.times(allDay);

  const patch: VEventPatch = {
    ...(input.subject !== undefined ? { summary: input.subject } : {}),
    ...(times ? { ...times, allDay } : input.allDay !== undefined && input.allDay !== before.allDay ? { start: before.start, end: before.end, allDay } : {}),
    ...(input.location !== undefined ? { location: input.location } : clear('Location') ? { location: '' } : {}),
    ...(input.body ? { description: changedBody(before.description, input.body.text, ctx.truncatedAt) } : clear('Body') ? { description: '' } : {}),
    ...(input.showAs ? { showAs: input.showAs } : clear('BusyStatus') ? { showAs: 'BUSY' as const } : {}),
    ...(input.classification ? { classification: input.classification } : clear('Sensitivity') ? { classification: 'PUBLIC' } : {}),
    ...(input.reminderMinutes !== undefined ? { alarm: { minutes: input.reminderMinutes } } : clear('Reminder') ? { alarm: null } : {}),
    ...(input.attendees ? { attendees: input.attendees } : clear('Attendees') ? { attendees: [] } : {}),
  };
  // Recurrence: a rule the device never got (no ActiveSync form) is kept unless it sends a new one
  let rrule: string | null | undefined;
  if (input.recurrence) rrule = rruleOf(input.recurrence, allDay, input.zone ?? before.tzid);
  else if (has('Recurrence') || (clear('Recurrence') && sentRule)) rrule = null;
  if (rrule !== undefined) patch.rrule = rrule;
  // a timed event stored in UTC that the device turns into a series moves to a real zone (TZID),
  // so its occurrences keep their wall-clock time across DST changes
  const anchor = rrule && !allDay && !before.rrule && !before.tzid ? seriesAnchorZone(input.zone, ctx.user.timeZone) : null;
  const anchored: VEventPatch = anchor ? { tzid: anchor, ...(times ? {} : { start: before.start, end: before.end, allDay }) } : {};

  let ical = patchVEvent(row.icalData, { ...patch, ...anchored }) ?? row.icalData;
  const finalRule = rrule === undefined ? before.rrule : rrule;
  if (!finalRule) {
    ical = withoutExceptions(ical);
  } else if (sentRule || input.recurrence) {
    const wanted = input.exceptions(allDay);
    if (wanted || clear('Exceptions')) ical = applyExceptions(ical, wanted ?? []);
  }
  const after = parseCalendarObject(ical)?.main;
  return after && schedulingChanged(before, after) ? patchVEvent(ical, { sequence: (before.sequence ?? row.sequence) + 1 }) ?? ical : ical;
}
