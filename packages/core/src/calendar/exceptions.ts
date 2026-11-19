/**
 * 9.4: single occurrences of a recurring event — "only this occurrence" edits and
 * deletes on the stored calendar object, shared by REST and CalDAV consumers.
 *
 *  - delete one occurrence → EXDATE on the master (an override for it is dropped)
 *  - change one occurrence → a VEVENT with RECURRENCE-ID (override); a new one is
 *    cloned from the master without RRULE/RDATE/EXDATE, then patched
 *  - restore one occurrence → its override and EXDATE value removed (ActiveSync clients
 *    send the complete exception list of a series)
 *
 * RECURRENCE-ID and EXDATE are written in the form of the master DTSTART: a date
 * for all-day series, local time with the master's TZID for zoned series (stays
 * correct across DST changes), UTC otherwise.
 */
import {
  findMainVEvent,
  formatDateOnly,
  formatUtcDateTime,
  getProperties,
  getProperty,
  parseDateList,
  parseDateProperty,
  parseIcal,
  parseVEventComponent,
  patchComponent,
  resolveTzid,
  serializeComponent,
  toIsoDate,
  utcToWallClockMs,
  type IcalComponent,
  type IcalProperty,
  type VEventFields,
} from './ical.js';
import { expandOccurrences } from './recurrence.js';

const DAY_MS = 86_400_000;
const SERIES_PROPS = new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'DURATION']);

interface Series {
  root: IcalComponent;
  master: IcalComponent;
  allDay: boolean;
}

function loadSeries(icalText: string): Series | null {
  const root = parseIcal(icalText);
  if (!root || root.name !== 'VCALENDAR') return null;
  const master = findMainVEvent(root);
  if (!master || getProperty(master, 'RECURRENCE-ID')) return null;
  const parsed = parseVEventComponent(master, root);
  if (!parsed || (!parsed.rrule && parsed.rdates.length === 0)) return null;
  return { root, master, allDay: parsed.allDay };
}

/** Same instant (timed) or same day (all-day). */
function sameInstance(a: Date, b: Date, allDay: boolean): boolean {
  return allDay ? toIsoDate(a) === toIsoDate(b) : a.getTime() === b.getTime();
}

/** A date property of the series in the form of the master DTSTART (DATE / TZID / UTC). */
export function seriesDateProp(name: string, date: Date, master: IcalComponent, root: IcalComponent): IcalProperty {
  const start = getProperty(master, 'DTSTART');
  const dateOnly = (start?.params['VALUE'] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(start?.value.trim() ?? '');
  if (dateOnly) return { name, params: { VALUE: 'DATE' }, value: formatDateOnly(date) };
  const tzParam = start?.params['TZID'];
  const zone = tzParam ? resolveTzid(tzParam, root) : null;
  if (tzParam && zone) {
    const local = formatUtcDateTime(new Date(utcToWallClockMs(date.getTime(), zone))).slice(0, -1);
    return { name, params: { TZID: tzParam }, value: local };
  }
  // floating master (no Z, no TZID): read as UTC wall time, so written back floating too
  const floating = !tzParam && !/Z$/i.test(start?.value.trim() ?? 'Z');
  const utc = formatUtcDateTime(date);
  return { name, params: {}, value: floating ? utc.slice(0, -1) : utc };
}

function overrideIndex(series: Series, recurrenceId: Date): number {
  return series.root.components.findIndex((c) => {
    if (c.name !== 'VEVENT' || c === series.master) return false;
    const rid = getProperty(c, 'RECURRENCE-ID');
    const value = rid ? parseDateProperty(rid, series.root) : null;
    return value !== null && sameInstance(value.date, recurrenceId, series.allDay);
  });
}

/**
 * Is `recurrenceId` an instance of the series — an existing override, or an
 * occurrence the RRULE/RDATE produces that no EXDATE removed?
 */
export function isSeriesOccurrence(icalText: string, recurrenceId: Date): boolean {
  const series = loadSeries(icalText);
  if (!series) return false;
  if (overrideIndex(series, recurrenceId) >= 0) return true;
  const main = parseVEventComponent(series.master, series.root)!;
  const duration = main.end.getTime() - main.start.getTime();
  const occ = expandOccurrences(
    { start: main.start, end: main.end, allDay: main.allDay, tzid: main.tzid, rrule: main.rrule, exdates: main.exdates, rdates: main.rdates },
    new Date(recurrenceId.getTime() - DAY_MS),
    new Date(recurrenceId.getTime() + duration + DAY_MS),
  );
  return occ.some((o) => sameInstance(o.recurrenceId, recurrenceId, main.allDay));
}

/** Remove one occurrence: EXDATE on the master, a stored override for it is dropped. Null when not a series. */
export function excludeOccurrence(icalText: string, recurrenceId: Date): string | null {
  const series = loadSeries(icalText);
  if (!series) return null;
  const idx = overrideIndex(series, recurrenceId);
  if (idx >= 0) series.root.components.splice(idx, 1);
  const excluded = parseDateList(getProperties(series.master, 'EXDATE'), series.root);
  if (!excluded.some((x) => sameInstance(x.date, recurrenceId, series.allDay))) {
    const at = series.master.properties.findIndex((p) => p.name === 'RRULE');
    const exdate = seriesDateProp('EXDATE', recurrenceId, series.master, series.root);
    series.master.properties.splice(at >= 0 ? at + 1 : series.master.properties.length, 0, exdate);
  }
  return serializeComponent(series.root) + '\r\n';
}

/**
 * Undo an exception: the override for `recurrenceId` and its EXDATE value are removed, so
 * the RRULE instance is back as generated. Null when the object is not a series.
 */
export function restoreOccurrence(icalText: string, recurrenceId: Date): string | null {
  const series = loadSeries(icalText);
  if (!series) return null;
  const idx = overrideIndex(series, recurrenceId);
  if (idx >= 0) series.root.components.splice(idx, 1);
  const kept: IcalProperty[] = [];
  for (const p of series.master.properties) {
    if (p.name !== 'EXDATE') { kept.push(p); continue; }
    const values = p.value.split(',').filter((v) => {
      const date = parseDateList([{ ...p, value: v }], series.root)[0]?.date;
      return !date || !sameInstance(date, recurrenceId, series.allDay);
    });
    if (values.length > 0) kept.push({ ...p, value: values.join(',') });
  }
  series.master.properties = kept;
  return serializeComponent(series.root) + '\r\n';
}

/** A fresh override for `recurrenceId`: the master without recurrence rules, at the original time. */
function newOverride(series: Series, recurrenceId: Date): IcalComponent {
  const main = parseVEventComponent(series.master, series.root)!;
  const duration = main.end.getTime() - main.start.getTime();
  const at = Math.max(0, series.master.properties.findIndex((p) => p.name === 'UID') + 1);
  const properties = series.master.properties
    .filter((p) => !SERIES_PROPS.has(p.name))
    .map((p) => ({ ...p, params: { ...p.params } }));
  properties.splice(at, 0,
    seriesDateProp('RECURRENCE-ID', recurrenceId, series.master, series.root),
    seriesDateProp('DTSTART', recurrenceId, series.master, series.root),
    seriesDateProp('DTEND', new Date(recurrenceId.getTime() + duration), series.master, series.root),
  );
  const components = series.master.components.map((c) => ({ ...c, properties: c.properties.map((p) => ({ ...p })) }));
  return { name: 'VEVENT', properties, components };
}

/**
 * Change one occurrence: patch its override (created from the master when there is
 * none yet). Null when the object is not a series or `recurrenceId` is no instance.
 */
export function upsertOccurrence(
  icalText: string,
  recurrenceId: Date,
  patch: VEventFields & { dtstamp?: Date },
): string | null {
  if (!isSeriesOccurrence(icalText, recurrenceId)) return null;
  const series = loadSeries(icalText)!;
  const idx = overrideIndex(series, recurrenceId);
  let override: IcalComponent;
  if (idx >= 0) {
    override = series.root.components[idx]!;
  } else {
    override = newOverride(series, recurrenceId);
    const masterAt = series.root.components.indexOf(series.master);
    series.root.components.splice(masterAt + 1, 0, override);
  }
  const { rrule: _ignored, ...instancePatch } = patch;
  patchComponent(override, series.root, instancePatch);
  return serializeComponent(series.root) + '\r\n';
}
