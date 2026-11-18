/**
 * Server-side recurrence expansion for the REST list + free/busy endpoints and
 * for CalDAV (`calendar-query` time-range filtering, `CALDAV:expand`,
 * `CALDAV:limit-recurrence-set` — RFC 4791 §9.6.5/§9.6.6/§9.9).
 * (Moved from api-gateway `lib/recurrence.ts` in v7.1.0.)
 *
 * RRULEs are evaluated with the `rrule` package in "wall clock" space: DTSTART is
 * converted to its local time in the event's TZID and handed to rrule as a fake-UTC
 * date, every occurrence is converted back with the zone's offset AT THAT DATE.
 * This keeps a 10:00 Europe/Berlin meeting at 10:00 local across DST changes.
 * All-day events are expanded on dates (UTC midnight), UTC events in UTC.
 */
import rrulePkg from 'rrule';
import {
  utcToWallClockMs,
  wallClockToUtcMs,
  isValidTimeZone,
  parseCalendarObject,
  parseDateProperty,
  parseIcal,
  findMainVEvent,
  getProperty,
  formatUtcDateTime,
  formatDateOnly,
  serializeComponent,
  toIsoDate,
  type IcalComponent,
  type IcalDateValue,
  type IcalProperty,
  type ParsedVEvent,
} from './ical.js';

const { RRule } = rrulePkg;

export interface ExpandableEvent {
  start: Date;
  end: Date;
  allDay: boolean;
  tzid: string | null;
  rrule: string | null;
  exdates?: IcalDateValue[];
  rdates?: IcalDateValue[];
}

export interface Occurrence {
  start: Date;
  end: Date;
  /** Original (unmodified) start of this instance — RECURRENCE-ID semantics. */
  recurrenceId: Date;
}

/** Hard cap per event and request (DoS guard: FREQ=SECONDLY etc.). */
export const MAX_OCCURRENCES = 1000;

const DAY_MS = 86_400_000;

/** Half-open overlap [start,end) ∩ [ws,we); zero-length events count when start ∈ [ws,we). */
export function overlaps(start: Date, end: Date, ws: Date, we: Date): boolean {
  const s = start.getTime();
  const e = end.getTime();
  if (e <= s) return s >= ws.getTime() && s < we.getTime();
  return s < we.getTime() && e > ws.getTime();
}

function instanceKey(d: Date, allDay: boolean): string {
  return allDay ? toIsoDate(d) : String(d.getTime());
}

/**
 * All occurrences of `ev` that overlap [windowStart, windowEnd).
 * EXDATE removes, RDATE adds; `excludeRecurrenceIds` removes instances that are
 * overridden by separate RECURRENCE-ID components.
 */
export function expandOccurrences(
  ev: ExpandableEvent,
  windowStart: Date,
  windowEnd: Date,
  opts: { max?: number; excludeRecurrenceIds?: Date[] } = {},
): Occurrence[] {
  const max = opts.max ?? MAX_OCCURRENCES;
  const duration = Math.max(0, ev.end.getTime() - ev.start.getTime());
  const out: Occurrence[] = [];

  if (!ev.rrule) {
    if (overlaps(ev.start, ev.end, windowStart, windowEnd)) {
      out.push({ start: ev.start, end: ev.end, recurrenceId: ev.start });
    }
    return out;
  }

  const tz = !ev.allDay && ev.tzid && isValidTimeZone(ev.tzid) ? ev.tzid : null;
  const toWall = (d: Date): Date => (tz ? new Date(utcToWallClockMs(d.getTime(), tz)) : d);
  const fromWall = (d: Date): Date => (tz ? new Date(wallClockToUtcMs(d.getTime(), tz)) : d);

  let rule: InstanceType<typeof RRule>;
  try {
    const options = RRule.parseString(ev.rrule.replace(/^RRULE:/i, ''));
    if (options.freq === undefined || options.freq === null) throw new Error('RRULE without FREQ');
    if (options.until && tz && /UNTIL=\d{8}T\d{6}Z/i.test(ev.rrule)) {
      // UNTIL is a UTC instant; move it into the same wall-clock space as DTSTART
      options.until = toWall(options.until);
    }
    rule = new RRule({ ...options, dtstart: toWall(ev.start) });
  } catch {
    // Unparseable rule → behave like a single event instead of failing the whole list
    if (overlaps(ev.start, ev.end, windowStart, windowEnd)) out.push({ start: ev.start, end: ev.end, recurrenceId: ev.start });
    return out;
  }

  // Wall-clock window padded by the event duration and the maximum UTC offset
  const pad = DAY_MS;
  const ws = new Date(toWall(windowStart).getTime() - duration - pad);
  const we = new Date(toWall(windowEnd).getTime() + pad);

  const excluded = new Set<string>([
    ...(ev.exdates ?? []).map((x) => instanceKey(x.date, ev.allDay)),
    ...(opts.excludeRecurrenceIds ?? []).map((d) => instanceKey(d, ev.allDay)),
  ]);

  const starts = new Map<string, Date>();
  rule.between(ws, we, true, (_d, i) => i < max * 4).forEach((wall) => {
    const real = fromWall(wall);
    starts.set(instanceKey(real, ev.allDay), real);
  });
  for (const r of ev.rdates ?? []) {
    const real = ev.allDay ? new Date(Date.UTC(r.date.getUTCFullYear(), r.date.getUTCMonth(), r.date.getUTCDate())) : r.date;
    starts.set(instanceKey(real, ev.allDay), real);
  }

  const sorted = [...starts.entries()].sort((a, b) => a[1].getTime() - b[1].getTime());
  for (const [key, start] of sorted) {
    if (excluded.has(key)) continue;
    const end = new Date(start.getTime() + duration);
    if (!overlaps(start, end, windowStart, windowEnd)) continue;
    out.push({ start, end, recurrenceId: start });
    if (out.length >= max) break;
  }
  return out;
}

export interface StoredEventLike {
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  recurring: boolean;
  rrule: string | null;
  icalData: string;
}

export interface ExpandedInstance {
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  /** Set for instances of a recurring series (ISO of the original start). */
  recurrenceId: string | null;
  /** Override VEVENT data (RECURRENCE-ID component) when this instance was modified. */
  override: Pick<ParsedVEvent, 'summary' | 'description' | 'location' | 'showAs'> | null;
}

/**
 * Expand a stored CalendarEvent row into its instances inside the window.
 * Non-recurring rows yield 0 or 1 instance (overlap semantics).
 */
export function expandStoredEvent(ev: StoredEventLike, windowStart: Date, windowEnd: Date): ExpandedInstance[] {
  const parsed = ev.recurring || ev.rrule ? parseCalendarObject(ev.icalData) : null;
  const rrule = parsed?.main.rrule ?? ev.rrule ?? null;

  if (!rrule) {
    return overlaps(ev.dtStart, ev.dtEnd, windowStart, windowEnd)
      ? [{ dtStart: ev.dtStart, dtEnd: ev.dtEnd, allDay: ev.allDay, recurrenceId: null, override: null }]
      : [];
  }

  const main = parsed?.main;
  const allDay = main?.allDay ?? ev.allDay;
  const overrides = parsed?.overrides ?? [];
  const occ = expandOccurrences(
    {
      start: main?.start ?? ev.dtStart,
      end: main?.end ?? ev.dtEnd,
      allDay,
      tzid: main?.tzid ?? null,
      rrule,
      exdates: main?.exdates ?? [],
      rdates: main?.rdates ?? [],
    },
    windowStart,
    windowEnd,
    { excludeRecurrenceIds: overrides.map((o) => o.recurrenceId!.date) },
  );
  const result: ExpandedInstance[] = occ.map((o) => ({
    dtStart: o.start, dtEnd: o.end, allDay, recurrenceId: o.recurrenceId.toISOString(), override: null,
  }));
  for (const o of overrides) {
    if (o.status === 'CANCELLED') continue;
    if (!overlaps(o.start, o.end, windowStart, windowEnd)) continue;
    result.push({
      dtStart: o.start, dtEnd: o.end, allDay: o.allDay,
      recurrenceId: o.recurrenceId!.date.toISOString(),
      override: { summary: o.summary, description: o.description, location: o.location, showAs: o.showAs },
    });
  }
  return result.sort((a, b) => a.dtStart.getTime() - b.dtStart.getTime());
}

// ─── CalDAV calendar-data post-processing ───────────────────────────────────

const RECURRENCE_PROPS = new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE']);

function cloneComponent(c: IcalComponent): IcalComponent {
  return {
    name: c.name,
    properties: c.properties.map((p) => ({ ...p, params: { ...p.params } })),
    components: c.components.map(cloneComponent),
  };
}

function utcDateProp(name: string, d: Date, dateOnly: boolean): IcalProperty {
  return dateOnly
    ? { name, params: { VALUE: 'DATE' }, value: formatDateOnly(d) }
    : { name, params: {}, value: formatUtcDateTime(d) };
}

/** Component with DTSTART/DTEND (and RECURRENCE-ID) rewritten in UTC, recurrence rules removed. */
function asUtcInstance(src: IcalComponent, start: Date, end: Date, allDay: boolean, recurrenceId: Date | null): IcalComponent {
  const c = cloneComponent(src);
  c.properties = c.properties.filter((p) =>
    !RECURRENCE_PROPS.has(p.name) && p.name !== 'DTSTART' && p.name !== 'DTEND' && p.name !== 'DURATION' && p.name !== 'RECURRENCE-ID');
  const at = Math.max(0, c.properties.findIndex((p) => p.name === 'UID') + 1);
  const dates = [utcDateProp('DTSTART', start, allDay), utcDateProp('DTEND', end, allDay)];
  if (recurrenceId) dates.push(utcDateProp('RECURRENCE-ID', recurrenceId, allDay));
  c.properties.splice(at, 0, ...dates);
  return c;
}

function wrap(root: IcalComponent, events: IcalComponent[]): string {
  const cal: IcalComponent = { name: 'VCALENDAR', properties: root.name === 'VCALENDAR' ? root.properties.filter((p) => p.name !== 'METHOD') : [{ name: 'VERSION', params: {}, value: '2.0' }], components: events };
  return serializeComponent(cal) + '\r\n';
}

/**
 * CALDAV:expand (RFC 4791 §9.6.5): the instances of a calendar object that overlap
 * [start, end) as separate VEVENTs with UTC DTSTART/DTEND/RECURRENCE-ID and without
 * RRULE/RDATE/EXDATE; VTIMEZONEs are dropped. Null when no instance overlaps.
 */
export function expandCalendarData(icalText: string, start: Date, end: Date): string | null {
  const root = parseIcal(icalText);
  const parsed = parseCalendarObject(icalText);
  if (!root || !parsed) return null;
  const masterComp = findMainVEvent(root);
  if (!masterComp) return null;
  const main = parsed.main;
  const vevents = (root.name === 'VEVENT' ? [root] : root.components.filter((c) => c.name === 'VEVENT'));
  const overrideComps = vevents.filter((c) => c !== masterComp && getProperty(c, 'RECURRENCE-ID'));
  const out: IcalComponent[] = [];

  const recurring = main.rrule !== null || main.rdates.length > 0;
  if (!recurring && main.recurrenceId === null) {
    if (overlaps(main.start, main.end, start, end)) out.push(asUtcInstance(masterComp, main.start, main.end, main.allDay, null));
  } else {
    const overrideIds = parsed.overrides.map((o) => o.recurrenceId!.date);
    const occ = recurring
      ? expandOccurrences(
          { start: main.start, end: main.end, allDay: main.allDay, tzid: main.tzid, rrule: main.rrule, exdates: main.exdates, rdates: main.rdates },
          start, end, { excludeRecurrenceIds: overrideIds },
        )
      : [];
    // An RDATE-only series has no RRULE → expandOccurrences returns only DTSTART: add the RDATEs
    if (!main.rrule && main.rdates.length > 0) {
      const duration = main.end.getTime() - main.start.getTime();
      const excluded = new Set([...main.exdates.map((x) => x.date.getTime()), ...overrideIds.map((d) => d.getTime())]);
      for (const r of main.rdates) {
        const s = r.date;
        const e = new Date(s.getTime() + duration);
        if (!excluded.has(s.getTime()) && overlaps(s, e, start, end)) occ.push({ start: s, end: e, recurrenceId: s });
      }
    }
    for (const o of occ) out.push(asUtcInstance(masterComp, o.start, o.end, main.allDay, o.recurrenceId));
    for (const comp of overrideComps) {
      const o = parsed.overrides.find((x) => x.recurrenceId && getProperty(comp, 'RECURRENCE-ID')
        && parseDateProperty(getProperty(comp, 'RECURRENCE-ID')!, root)?.date.getTime() === x.recurrenceId.date.getTime());
      if (o && overlaps(o.start, o.end, start, end)) out.push(asUtcInstance(comp, o.start, o.end, o.allDay, o.recurrenceId!.date));
    }
  }
  if (out.length === 0) return null;
  out.sort((a, b) => (getProperty(a, 'DTSTART')?.value ?? '').localeCompare(getProperty(b, 'DTSTART')?.value ?? ''));
  return wrap(root, out);
}

/**
 * CALDAV:limit-recurrence-set (RFC 4791 §9.6.6): the master component plus only the
 * overridden instances whose original or new time overlaps [start, end).
 */
export function limitRecurrenceSet(icalText: string, start: Date, end: Date): string {
  const root = parseIcal(icalText);
  if (!root || root.name !== 'VCALENDAR') return icalText;
  const parsed = parseCalendarObject(icalText);
  if (!parsed) return icalText;
  const keep = (c: IcalComponent): boolean => {
    if (c.name !== 'VEVENT' || !getProperty(c, 'RECURRENCE-ID')) return true;
    const rid = parseDateProperty(getProperty(c, 'RECURRENCE-ID')!, root);
    const o = parsed.overrides.find((x) => rid && x.recurrenceId?.date.getTime() === rid.date.getTime());
    if (!o || !rid) return true;
    const ridEnd = new Date(rid.date.getTime() + (parsed.main.end.getTime() - parsed.main.start.getTime()));
    return overlaps(o.start, o.end, start, end) || overlaps(rid.date, ridEnd, start, end);
  };
  const before = root.components.length;
  root.components = root.components.filter(keep);
  return root.components.length === before ? icalText : serializeComponent(root) + '\r\n';
}

/** Does a stored event have at least one instance in [start, end)? (RFC 4791 §9.9 incl. recurrence). */
export function eventOverlapsRange(ev: StoredEventLike, start: Date, end: Date): boolean {
  if (!ev.recurring && !ev.rrule) return overlaps(ev.dtStart, ev.dtEnd, start, end);
  return expandStoredEvent(ev, start, end).length > 0
    // RDATE-only series: expandStoredEvent only knows RRULEs — fall back to the DB range check
    || (!ev.rrule && overlaps(ev.dtStart, ev.dtEnd, start, end))
    || (!ev.rrule && expandCalendarData(ev.icalData, start, end) !== null);
}
