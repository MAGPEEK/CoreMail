/**
 * Server-side recurrence expansion for the REST list + free/busy endpoints.
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
  toIsoDate,
  type IcalDateValue,
  type ParsedVEvent,
} from '@coremail/core/calendar';

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
  override: Pick<ParsedVEvent, 'summary' | 'description' | 'location'> | null;
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
      override: { summary: o.summary, description: o.description, location: o.location },
    });
  }
  return result.sort((a, b) => a.dtStart.getTime() - b.dtStart.getTime());
}
