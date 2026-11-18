/**
 * Minimal, dependency-free iCalendar (RFC 5545) toolkit shared by the
 * api-gateway (REST) and the caldav-server (CalDAV PUT/GET).
 *
 * Scope:
 *  - line unfolding/folding (75 octets, UTF-8 safe) and TEXT escaping
 *  - a generic component tree parser (VCALENDAR → VTIMEZONE / VEVENT → VALARM …)
 *  - date-time values: UTC (`Z`), floating, `VALUE=DATE` and `TZID=` (IANA via Intl,
 *    common Windows zone names, VTIMEZONE `X-LIC-LOCATION` / fixed-offset fallback)
 *  - building a fresh VCALENDAR and patching the main VEVENT of a stored document
 *    in place (everything the patch does not touch — RRULE, VALARM, ATTENDEE,
 *    VTIMEZONE, X- properties — is preserved verbatim)
 *
 * All-day convention used across CoreMail: an all-day event is stored with
 * `dtStart`/`dtEnd` at UTC midnight of its first day / of the day AFTER its last
 * day (DTEND is exclusive, RFC 5545 §3.6.1), and its date-only form is `YYYY-MM-DD`.
 */

export interface IcalProperty {
  name: string;
  params: Record<string, string>;
  /** Raw (still escaped) value as it appears after the colon. */
  value: string;
}

export interface IcalComponent {
  name: string;
  properties: IcalProperty[];
  components: IcalComponent[];
}

// ─── Lines ───────────────────────────────────────────────────────────────────

/** Split into logical lines: CRLF/LF tolerant, continuation lines (leading SP/HTAB) joined. */
export function unfoldLines(text: string): string[] {
  const physical = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

/** Fold a content line to at most 75 octets per physical line without splitting UTF-8 sequences. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + b > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74; // continuation lines start with one space
    }
    current += ch;
    currentBytes += b;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

/** RFC 5545 §3.3.11 TEXT escaping — also neutralises CR/LF (no property injection). */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Parameter values: strip DQUOTE/control chars, quote when they contain `:;,`. */
function formatParamValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/["\x00-\x1f\x7f]/g, '');
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/** Parse `NAME;P1=v;P2="q:v":value` — colons inside quoted parameter values are honoured. */
export function parseContentLine(line: string): IcalProperty | null {
  let i = 0;
  let inQuotes = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const segments: string[] = [];
  let seg = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') { inQuotes = !inQuotes; seg += ch; continue; }
    if (ch === ';' && !inQuotes) { segments.push(seg); seg = ''; continue; }
    seg += ch;
  }
  segments.push(seg);

  const name = (segments.shift() ?? '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of segments) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toUpperCase();
    let val = p.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

export function serializeProperty(p: IcalProperty): string {
  let head = p.name;
  for (const [k, v] of Object.entries(p.params)) head += `;${k}=${formatParamValue(v)}`;
  // A raw value must never contain a line break (would start a new property)
  return foldLine(`${head}:${p.value.replace(/\r\n|\r|\n/g, '\\n')}`);
}

// ─── Component tree ─────────────────────────────────────────────────────────

/** Parse an iCalendar document into a component tree. Returns the first top-level component. */
export function parseIcal(text: string): IcalComponent | null {
  const lines = unfoldLines(text);
  const stack: IcalComponent[] = [];
  let root: IcalComponent | null = null;
  for (const line of lines) {
    const prop = parseContentLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp: IcalComponent = { name: prop.value.trim().toUpperCase(), properties: [], components: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(comp);
      else if (!root) root = comp;
      else continue; // ignore a second top-level object
      stack.push(comp);
    } else if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      // pop up to (and including) the matching component — tolerates missing ENDs
      const idx = stack.map((c) => c.name).lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
    } else {
      const current = stack[stack.length - 1];
      if (current) current.properties.push(prop);
    }
  }
  return root;
}

export function serializeComponent(c: IcalComponent): string {
  const lines: string[] = [`BEGIN:${c.name}`];
  for (const p of c.properties) lines.push(serializeProperty(p));
  for (const sub of c.components) lines.push(serializeComponent(sub));
  lines.push(`END:${c.name}`);
  return lines.join('\r\n');
}

export function getProperty(c: IcalComponent, name: string): IcalProperty | undefined {
  const n = name.toUpperCase();
  return c.properties.find((p) => p.name === n);
}

export function getProperties(c: IcalComponent, name: string): IcalProperty[] {
  const n = name.toUpperCase();
  return c.properties.filter((p) => p.name === n);
}

function vevents(root: IcalComponent): IcalComponent[] {
  if (root.name === 'VEVENT') return [root];
  return root.components.filter((c) => c.name === 'VEVENT');
}

/** The master VEVENT (no RECURRENCE-ID), otherwise the first VEVENT. Never a VTIMEZONE sub-part. */
export function findMainVEvent(root: IcalComponent): IcalComponent | null {
  const all = vevents(root);
  return all.find((e) => !getProperty(e, 'RECURRENCE-ID')) ?? all[0] ?? null;
}

// ─── Time zones ─────────────────────────────────────────────────────────────

/** Common Windows (Outlook/Exchange) zone names → IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC',
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** True when the runtime knows this IANA zone. */
export function isValidTimeZone(tz: string): boolean {
  try { dtf(tz); return true; } catch { return false; }
}

/** Wall clock of `utcMs` in `tz`, expressed as "fake UTC" milliseconds. */
export function utcToWallClockMs(utcMs: number, tz: string): number {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    + (utcMs % 1000 + 1000) % 1000;
}

function offsetAt(utcMs: number, tz: string): number {
  return utcToWallClockMs(utcMs, tz) - utcMs;
}

/**
 * Wall clock ("fake UTC" ms) in `tz` → real UTC ms (RFC 5545 §3.3.5 semantics):
 * an ambiguous time (DST fall-back) resolves to its FIRST occurrence, a non-existent
 * time (spring-forward gap) is interpreted with the offset in effect before the gap.
 */
export function wallClockToUtcMs(wallMs: number, tz: string): number {
  const offBefore = offsetAt(wallMs - 86_400_000, tz);
  const offAfter = offsetAt(wallMs + 86_400_000, tz);
  const candidates = [wallMs - offBefore, wallMs - offAfter]
    .filter((c) => utcToWallClockMs(c, tz) === wallMs)
    .sort((a, b) => a - b);
  return candidates[0] ?? wallMs - offBefore;
}

/** Map a TZID (IANA, `/`-prefixed, Windows name, or VTIMEZONE id) to an IANA zone, if possible. */
export function resolveTzid(tzid: string, root?: IcalComponent | null): string | null {
  const raw = tzid.trim();
  const candidates = [raw, raw.replace(/^\/+/, ''), WINDOWS_ZONES[raw] ?? ''];
  if (root) {
    const vtz = root.components.find((c) => c.name === 'VTIMEZONE' && getProperty(c, 'TZID')?.value.trim() === raw);
    const lic = vtz ? getProperty(vtz, 'X-LIC-LOCATION')?.value.trim() : undefined;
    if (lic) candidates.push(lic);
  }
  for (const c of candidates) if (c && isValidTimeZone(c)) return c;
  return null;
}

function parseUtcOffset(v: string | undefined): number | null {
  const m = v ? /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim()) : null;
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? '0')) * 1000;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Onset (wall clock, "fake UTC" ms) of a VTIMEZONE STANDARD/DAYLIGHT rule in `year`:
 * supports the yearly rules zones are written with — `FREQ=YEARLY;BYMONTH=m;BYDAY=±nDD`
 * and `BYDAY=DD;BYMONTHDAY=d1,d2,…`. Null when the rule is not of that shape.
 */
function yearlyOnset(rrule: string, dtstartWall: number, year: number): number | null {
  const parts = new Map(rrule.toUpperCase().split(';').map((kv) => kv.split('=') as [string, string]));
  if (parts.get('FREQ') !== 'YEARLY') return null;
  const month = Number(parts.get('BYMONTH') ?? NaN) - 1;
  if (!(month >= 0 && month < 12)) return null;
  const until = parts.get('UNTIL');
  const untilDate = until ? parseDateString(until)?.date.getTime() ?? null : null;
  const t = new Date(dtstartWall);
  const timeOfDay = ((t.getUTCHours() * 60 + t.getUTCMinutes()) * 60 + t.getUTCSeconds()) * 1000;
  const byday = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(parts.get('BYDAY') ?? '');
  const wd = byday ? WEEKDAYS.indexOf(byday[2]!) : -1;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let day: number | null = null;
  if (wd >= 0 && byday?.[1]) {
    const n = Number(byday[1]);
    if (n > 0) {
      const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
      day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    } else {
      const last = new Date(Date.UTC(year, month, daysInMonth)).getUTCDay();
      day = daysInMonth - ((last - wd + 7) % 7) + (n + 1) * 7;
    }
  } else if (wd >= 0 && parts.get('BYMONTHDAY')) {
    const candidates = parts.get('BYMONTHDAY')!.split(',').map(Number).sort((a, b) => a - b);
    day = candidates.find((d) => d >= 1 && d <= daysInMonth && new Date(Date.UTC(year, month, d)).getUTCDay() === wd) ?? null;
  } else if (!parts.has('BYDAY') && parts.get('BYMONTHDAY')) {
    day = Number(parts.get('BYMONTHDAY'));
  }
  if (day === null || day < 1 || day > daysInMonth) return null;
  const onset = Date.UTC(year, month, day) + timeOfDay;
  if (onset < dtstartWall) return null;
  if (untilDate !== null && onset > untilDate + 86_400_000) return null;
  return onset;
}

/**
 * UTC offset (ms) a VTIMEZONE defines for the wall-clock time `wallMs`, evaluated
 * from its STANDARD/DAYLIGHT sub-components (DTSTART, yearly RRULE, RDATE).
 * Used for custom zones without an IANA id or X-LIC-LOCATION (RFC 5545 §3.6.5).
 */
export function vtimezoneOffsetAt(tzid: string, root: IcalComponent | null | undefined, wallMs: number): number | null {
  if (!root) return null;
  const vtz = root.components.find((c) => c.name === 'VTIMEZONE' && getProperty(c, 'TZID')?.value.trim() === tzid.trim());
  if (!vtz) return null;
  const year = new Date(wallMs).getUTCFullYear();
  let best: { onset: number; offset: number } | null = null;
  let earliest: { onset: number; offsetFrom: number } | null = null;
  for (const sub of vtz.components) {
    if (sub.name !== 'STANDARD' && sub.name !== 'DAYLIGHT') continue;
    const to = parseUtcOffset(getProperty(sub, 'TZOFFSETTO')?.value);
    const from = parseUtcOffset(getProperty(sub, 'TZOFFSETFROM')?.value);
    // A sub-component without DTSTART (invalid, but seen in the wild) applies from the beginning of time
    const dtstart = getProperty(sub, 'DTSTART')?.value;
    const start = dtstart ? parseDateString(dtstart)?.date.getTime() : Number.NEGATIVE_INFINITY;
    if (to === null || start === undefined) continue;
    const onsets = [start];
    const rrule = getProperty(sub, 'RRULE')?.value;
    if (rrule && Number.isFinite(start)) {
      for (const y of [year - 1, year]) {
        const o = yearlyOnset(rrule, start, y);
        if (o !== null) onsets.push(o);
      }
    }
    for (const rd of getProperties(sub, 'RDATE')) {
      for (const v of rd.value.split(',')) {
        const d = parseDateString(v)?.date.getTime();
        if (d !== undefined) onsets.push(d);
      }
    }
    for (const onset of onsets) {
      if (onset <= wallMs && (!best || onset > best.onset)) best = { onset, offset: to };
      if (!earliest || onset < earliest.onset) earliest = { onset, offsetFrom: from ?? to };
    }
  }
  if (best) return best.offset;
  return earliest ? earliest.offsetFrom : null;
}

// ─── Date values ─────────────────────────────────────────────────────────────

export interface IcalDateValue {
  /** Real UTC instant. For date-only values: UTC midnight of that date. */
  date: Date;
  dateOnly: boolean;
  /** IANA zone the value was expressed in (null for UTC, floating or date-only). */
  tzid: string | null;
}

/** Parse one DATE / DATE-TIME string (`20260101`, `20260101T100000`, `20260101T100000Z`). */
export function parseDateString(
  value: string,
  tzid?: string | null,
  root?: IcalComponent | null,
): IcalDateValue | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) {
    // Lenient: ISO strings some clients emit (2026-01-01T10:00:00Z)
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : { date: d, dateOnly: false, tzid: null };
  }
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? '0'), Number(mi ?? '0'), Number(s ?? '0'));
  if (h === undefined) return { date: new Date(wall), dateOnly: true, tzid: null };
  if (z) return { date: new Date(wall), dateOnly: false, tzid: null };
  if (tzid) {
    const iana = resolveTzid(tzid, root);
    if (iana) return { date: new Date(wallClockToUtcMs(wall, iana)), dateOnly: false, tzid: iana };
    const offset = vtimezoneOffsetAt(tzid, root, wall);
    if (offset !== null) return { date: new Date(wall - offset), dateOnly: false, tzid: null };
  }
  // Floating time (or unknown zone): interpreted as UTC — deterministic on every server
  return { date: new Date(wall), dateOnly: false, tzid: null };
}

export function parseDateProperty(p: IcalProperty, root?: IcalComponent | null): IcalDateValue | null {
  return parseDateString(p.value.split(',')[0] ?? '', p.params['TZID'] ?? null, root);
}

/** EXDATE/RDATE may carry comma lists and appear several times. */
export function parseDateList(props: IcalProperty[], root?: IcalComponent | null): IcalDateValue[] {
  const out: IcalDateValue[] = [];
  for (const p of props) {
    if ((p.params['VALUE'] ?? '').toUpperCase() === 'PERIOD') continue;
    for (const part of p.value.split(',')) {
      const v = parseDateString(part, p.params['TZID'] ?? null, root);
      if (v) out.push(v);
    }
  }
  return out;
}

/** RFC 5545 §3.3.6 DURATION → ms (`P1D`, `PT1H30M`, `P2W`, `-PT15M`). */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 + Number(h ?? 0)) * 60 + Number(mi ?? 0)) * 60 + Number(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatUtcDateTime(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function formatDateOnly(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DD` of a UTC-midnight date. */
export function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

/**
 * Normalise an all-day range given as `YYYY-MM-DD` (or any ISO string — only the date
 * part is used, no timezone conversion) to UTC-midnight Dates with an EXCLUSIVE end.
 * An end that is not after the start becomes start + 1 day.
 */
export function normalizeAllDayRange(start: string | Date, end: string | Date): { start: Date; end: Date } {
  const toDay = (v: string | Date): Date => {
    if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v.trim());
    if (!m) throw new Error(`invalid date: ${v}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  };
  const s = toDay(start);
  let e = toDay(end);
  if (e.getTime() <= s.getTime()) e = new Date(s.getTime() + DAY_MS);
  return { start: s, end: e };
}

// ─── Show as (free/busy) and alarms ──────────────────────────────────────────

/**
 * 9.4: how an event blocks time ("Anzeigen als"). Stored as TRANSP (FREE =
 * TRANSPARENT, everything else OPAQUE) plus X-MICROSOFT-CDO-BUSYSTATUS, which
 * the common desktop clients read and write; reading falls back to TRANSP.
 */
export type ShowAs = 'FREE' | 'TENTATIVE' | 'BUSY' | 'OOF';
export const SHOW_AS_VALUES: readonly ShowAs[] = ['FREE', 'TENTATIVE', 'BUSY', 'OOF'];
const BUSY_STATUS_PROP = 'X-MICROSOFT-CDO-BUSYSTATUS';

export function normShowAs(v: string | null | undefined): ShowAs {
  const s = (v ?? '').trim().toUpperCase();
  if (s === 'WORKINGELSEWHERE') return 'BUSY';
  return (SHOW_AS_VALUES as readonly string[]).includes(s) ? (s as ShowAs) : 'BUSY';
}

function componentShowAs(ev: IcalComponent): ShowAs {
  const cdo = getProperty(ev, BUSY_STATUS_PROP)?.value;
  if (cdo) return normShowAs(cdo);
  return (getProperty(ev, 'TRANSP')?.value ?? '').trim().toUpperCase() === 'TRANSPARENT' ? 'FREE' : 'BUSY';
}

function showAsProps(showAs: ShowAs): IcalProperty[] {
  return [
    { name: 'TRANSP', params: {}, value: showAs === 'FREE' ? 'TRANSPARENT' : 'OPAQUE' },
    { name: BUSY_STATUS_PROP, params: {}, value: showAs },
  ];
}

/**
 * 9.4: the reminder of an event — minutes before the start, and whether an
 * e-mail reminder (VALARM ACTION:EMAIL to `mailTo`) accompanies the display alarm.
 */
export interface AlarmSpec {
  minutes: number;
  byMail?: boolean;
  /** Recipient of the e-mail alarm (the calendar owner). */
  mailTo?: string;
}

function triggerMinutes(alarm: IcalComponent): number | null {
  const trigger = getProperty(alarm, 'TRIGGER');
  if (!trigger || (trigger.params['VALUE'] ?? '').toUpperCase() === 'DATE-TIME') return null;
  const ms = parseDuration(trigger.value);
  return ms === null ? null : Math.max(0, Math.round(-ms / 60_000));
}

/** First display/audio alarm (else the e-mail alarm) of a component; null without alarms. */
function componentAlarm(ev: IcalComponent): AlarmSpec | null {
  const alarms = ev.components.filter((c) => c.name === 'VALARM');
  const action = (a: IcalComponent): string => (getProperty(a, 'ACTION')?.value ?? '').trim().toUpperCase();
  const mail = alarms.find((a) => action(a) === 'EMAIL');
  const shown = alarms.find((a) => action(a) !== 'EMAIL' && triggerMinutes(a) !== null);
  const minutes = shown ? triggerMinutes(shown) : mail ? triggerMinutes(mail) : null;
  if (minutes === null) return null;
  return { minutes, byMail: mail !== undefined };
}

function alarmComponents(alarm: AlarmSpec, summary: string): IcalComponent[] {
  const trigger: IcalProperty = { name: 'TRIGGER', params: {}, value: `-PT${Math.max(0, Math.floor(alarm.minutes))}M` };
  const out: IcalComponent[] = [{
    name: 'VALARM',
    properties: [{ name: 'ACTION', params: {}, value: 'DISPLAY' }, trigger, textProp('DESCRIPTION', summary)],
    components: [],
  }];
  if (alarm.byMail) {
    out.push({
      name: 'VALARM',
      properties: [
        { name: 'ACTION', params: {}, value: 'EMAIL' },
        { ...trigger },
        textProp('SUMMARY', summary),
        textProp('DESCRIPTION', summary),
        ...(alarm.mailTo ? [{ name: 'ATTENDEE', params: {}, value: `mailto:${alarm.mailTo.replace(/[\s"]/g, '')}` }] : []),
      ],
      components: [],
    });
  }
  return out;
}

// ─── Parsed VEVENT ───────────────────────────────────────────────────────────

export interface ParsedAttendee {
  email: string;
  cn?: string;
  partstat: string;
  role: string;
  rsvp: boolean;
  /** CUTYPE (INDIVIDUAL, ROOM, RESOURCE, …), upper case; INDIVIDUAL when absent. */
  cutype: string;
}

export interface ParsedVEvent {
  uid: string | null;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** IANA zone of DTSTART (null = UTC/floating/date-only). */
  tzid: string | null;
  rrule: string | null;
  exdates: IcalDateValue[];
  rdates: IcalDateValue[];
  recurrenceId: IcalDateValue | null;
  classification: 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL';
  status: string | null;
  sequence: number | null;
  organizer: string | null;
  attendees: ParsedAttendee[];
  showAs: ShowAs;
  alarm: AlarmSpec | null;
}

function mailto(v: string): string {
  return v.trim().replace(/^mailto:/i, '');
}

export function parseVEventComponent(ev: IcalComponent, root: IcalComponent | null): ParsedVEvent | null {
  const dtStartProp = getProperty(ev, 'DTSTART');
  if (!dtStartProp) return null;
  const start = parseDateProperty(dtStartProp, root);
  if (!start || isNaN(start.date.getTime())) return null;
  const allDay = start.dateOnly || (dtStartProp.params['VALUE'] ?? '').toUpperCase() === 'DATE';

  let end: Date | null = null;
  const dtEndProp = getProperty(ev, 'DTEND');
  const durProp = getProperty(ev, 'DURATION');
  if (dtEndProp) {
    const e = parseDateProperty(dtEndProp, root);
    if (e && !isNaN(e.date.getTime())) end = e.date;
  } else if (durProp) {
    const ms = parseDuration(durProp.value);
    if (ms !== null) end = new Date(start.date.getTime() + ms);
  }
  if (!end || end.getTime() < start.date.getTime()) {
    end = new Date(start.date.getTime() + (allDay ? DAY_MS : 0));
  }
  if (allDay && end.getTime() === start.date.getTime()) end = new Date(start.date.getTime() + DAY_MS);

  const text = (n: string): string => {
    const p = getProperty(ev, n);
    return p ? unescapeText(p.value) : '';
  };
  const cls = (getProperty(ev, 'CLASS')?.value ?? 'PUBLIC').trim().toUpperCase();
  const seq = getProperty(ev, 'SEQUENCE')?.value;
  const rid = getProperty(ev, 'RECURRENCE-ID');
  const rrule = getProperty(ev, 'RRULE')?.value.trim();
  const org = getProperty(ev, 'ORGANIZER')?.value;

  return {
    uid: getProperty(ev, 'UID')?.value.trim() || null,
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    start: start.date,
    end,
    allDay,
    tzid: start.tzid,
    rrule: rrule || null,
    exdates: parseDateList(getProperties(ev, 'EXDATE'), root),
    rdates: parseDateList(getProperties(ev, 'RDATE'), root),
    recurrenceId: rid ? parseDateProperty(rid, root) : null,
    classification: cls === 'PRIVATE' || cls === 'CONFIDENTIAL' ? cls : 'PUBLIC',
    status: getProperty(ev, 'STATUS')?.value.trim().toUpperCase() || null,
    sequence: seq !== undefined && /^\d+$/.test(seq.trim()) ? Number(seq.trim()) : null,
    organizer: org ? mailto(org) : null,
    attendees: getProperties(ev, 'ATTENDEE').map((a) => ({
      email: mailto(a.value),
      ...(a.params['CN'] ? { cn: a.params['CN'] } : {}),
      partstat: (a.params['PARTSTAT'] ?? 'NEEDS-ACTION').toUpperCase(),
      role: (a.params['ROLE'] ?? 'REQ-PARTICIPANT').toUpperCase(),
      rsvp: (a.params['RSVP'] ?? '').toUpperCase() === 'TRUE',
      cutype: (a.params['CUTYPE'] ?? 'INDIVIDUAL').toUpperCase(),
    })).filter((a) => a.email.includes('@')),
    showAs: componentShowAs(ev),
    alarm: componentAlarm(ev),
  };
}

/** Parse a stored/uploaded calendar object: master VEVENT + overridden instances. */
export function parseCalendarObject(text: string): { main: ParsedVEvent; overrides: ParsedVEvent[] } | null {
  const root = parseIcal(text);
  if (!root) return null;
  const mainComp = findMainVEvent(root);
  if (!mainComp) return null;
  const main = parseVEventComponent(mainComp, root);
  if (!main) return null;
  const overrides = vevents(root)
    .filter((c) => c !== mainComp && getProperty(c, 'RECURRENCE-ID'))
    .map((c) => parseVEventComponent(c, root))
    .filter((e): e is ParsedVEvent => e !== null && e.recurrenceId !== null);
  return { main, overrides };
}

// ─── Building / patching ─────────────────────────────────────────────────────

export interface AttendeeInput {
  email: string;
  cn?: string;
  partstat?: string;
  role?: string;
  rsvp?: boolean;
  /** CUTYPE parameter (ROOM / RESOURCE for booked rooms); omitted = individual. */
  cutype?: string;
}

export interface VEventFields {
  summary?: string;
  description?: string;
  location?: string;
  /** Timed: instant. All-day: `YYYY-MM-DD` (or UTC-midnight Date). */
  start?: Date | string;
  end?: Date | string;
  allDay?: boolean;
  /** `null` removes the RRULE. */
  rrule?: string | null;
  classification?: string;
  status?: string;
  sequence?: number;
  organizer?: { email: string; cn?: string } | null;
  attendees?: AttendeeInput[];
  /** 9.4: free/busy status (TRANSP + X-MICROSOFT-CDO-BUSYSTATUS). */
  showAs?: ShowAs;
  /** 9.4: replaces every VALARM of the component; null removes the reminder. */
  alarm?: AlarmSpec | null;
}

function textProp(name: string, value: string): IcalProperty {
  return { name, params: {}, value: escapeText(value) };
}

function sanitizeRrule(r: string): string {
  // RRULE is a RECUR value: only [A-Z0-9=;,:+-] are legal — drop anything else (incl. CR/LF)
  return r.replace(/^RRULE:/i, '').replace(/[^A-Za-z0-9=;,:+\-]/g, '').toUpperCase();
}

function attendeeProp(a: AttendeeInput): IcalProperty {
  const params: Record<string, string> = {};
  if (a.cn) params['CN'] = a.cn;
  params['ROLE'] = (a.role ?? 'REQ-PARTICIPANT').toUpperCase();
  params['PARTSTAT'] = (a.partstat ?? 'NEEDS-ACTION').toUpperCase();
  params['RSVP'] = a.rsvp === false ? 'FALSE' : 'TRUE';
  if (a.cutype) params['CUTYPE'] = a.cutype.toUpperCase().replace(/[^A-Z-]/g, '');
  return { name: 'ATTENDEE', params, value: `mailto:${a.email.replace(/[\s"]/g, '')}` };
}

function dateProps(
  start: Date | string,
  end: Date | string,
  allDay: boolean,
  tzid: string | null,
): IcalProperty[] {
  if (allDay) {
    const r = normalizeAllDayRange(start, end);
    return [
      { name: 'DTSTART', params: { VALUE: 'DATE' }, value: formatDateOnly(r.start) },
      { name: 'DTEND', params: { VALUE: 'DATE' }, value: formatDateOnly(r.end) },
    ];
  }
  const s = start instanceof Date ? start : new Date(start);
  let e = end instanceof Date ? end : new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new Error('invalid date-time');
  if (e.getTime() < s.getTime()) e = s;
  if (tzid && isValidTimeZone(tzid)) {
    const local = (d: Date): string => formatUtcDateTime(new Date(utcToWallClockMs(d.getTime(), tzid))).slice(0, -1);
    return [
      { name: 'DTSTART', params: { TZID: tzid }, value: local(s) },
      { name: 'DTEND', params: { TZID: tzid }, value: local(e) },
    ];
  }
  return [
    { name: 'DTSTART', params: {}, value: formatUtcDateTime(s) },
    { name: 'DTEND', params: {}, value: formatUtcDateTime(e) },
  ];
}

/** Build a complete VCALENDAR with one VEVENT (UID + DTSTAMP included, text escaped, lines folded). */
export function buildVCalendar(opts: VEventFields & {
  uid: string;
  start: Date | string;
  end: Date | string;
  summary: string;
  dtstamp?: Date;
  method?: string;
  /** RECURRENCE-ID of a single instance (iTIP replies for one occurrence, RFC 5546 §3.2.3). */
  recurrenceId?: { date: Date; dateOnly: boolean };
  /** 9.4: display alarm this many minutes before the start (VALARM); `alarm` wins when both are set. */
  alarmMinutes?: number;
  /**
   * IANA zone of a timed DTSTART/DTEND (written as local time with TZID, so a series keeps
   * its wall-clock time across DST changes); omitted or unknown = UTC.
   */
  tzid?: string;
}): string {
  const ev: IcalComponent = { name: 'VEVENT', properties: [], components: [] };
  const now = opts.dtstamp ?? new Date();
  ev.properties.push({ name: 'UID', params: {}, value: opts.uid.replace(/[\r\n]/g, '') });
  ev.properties.push({ name: 'DTSTAMP', params: {}, value: formatUtcDateTime(now) });
  if (opts.recurrenceId) {
    ev.properties.push(opts.recurrenceId.dateOnly
      ? { name: 'RECURRENCE-ID', params: { VALUE: 'DATE' }, value: formatDateOnly(opts.recurrenceId.date) }
      : { name: 'RECURRENCE-ID', params: {}, value: formatUtcDateTime(opts.recurrenceId.date) });
  }
  ev.properties.push(...dateProps(opts.start, opts.end, opts.allDay ?? false, opts.tzid ?? null));
  ev.properties.push(textProp('SUMMARY', opts.summary));
  if (opts.description) ev.properties.push(textProp('DESCRIPTION', opts.description));
  if (opts.location) ev.properties.push(textProp('LOCATION', opts.location));
  if (opts.rrule) ev.properties.push({ name: 'RRULE', params: {}, value: sanitizeRrule(opts.rrule) });
  const cls = (opts.classification ?? 'PUBLIC').toUpperCase();
  if (cls === 'PRIVATE' || cls === 'CONFIDENTIAL') ev.properties.push({ name: 'CLASS', params: {}, value: cls });
  if (opts.status) ev.properties.push({ name: 'STATUS', params: {}, value: opts.status.toUpperCase().replace(/[^A-Z-]/g, '') });
  if (opts.sequence !== undefined) ev.properties.push({ name: 'SEQUENCE', params: {}, value: String(Math.max(0, Math.floor(opts.sequence))) });
  if (opts.organizer) {
    ev.properties.push({
      name: 'ORGANIZER',
      params: opts.organizer.cn ? { CN: opts.organizer.cn } : {},
      value: `mailto:${opts.organizer.email.replace(/[\s"]/g, '')}`,
    });
  }
  for (const a of opts.attendees ?? []) ev.properties.push(attendeeProp(a));
  if (opts.showAs) ev.properties.push(...showAsProps(opts.showAs));
  const alarm = opts.alarm !== undefined
    ? opts.alarm
    : opts.alarmMinutes !== undefined && Number.isFinite(opts.alarmMinutes) && opts.alarmMinutes >= 0
      ? { minutes: opts.alarmMinutes }
      : null;
  if (alarm) ev.components.push(...alarmComponents(alarm, opts.summary));

  const cal: IcalComponent = {
    name: 'VCALENDAR',
    properties: [
      { name: 'VERSION', params: {}, value: '2.0' },
      { name: 'PRODID', params: {}, value: '-//CoreMail//CoreMail Calendar//EN' },
      { name: 'CALSCALE', params: {}, value: 'GREGORIAN' },
      ...(opts.method ? [{ name: 'METHOD', params: {}, value: opts.method }] : []),
    ],
    components: [ev],
  };
  return serializeComponent(cal) + '\r\n';
}

/**
 * Patch the main VEVENT of a stored calendar object. Only the fields present in
 * `patch` are rewritten; every other property/sub-component (RRULE, EXDATE, VALARM,
 * ATTENDEE, VTIMEZONE, X-…) is preserved. A timed DTSTART that carried a TZID keeps
 * its zone (the new instant is written as wall-clock time in that zone).
 * Returns null when the document has no VEVENT (caller should rebuild).
 */
export function patchVEvent(icalText: string, patch: VEventFields & { dtstamp?: Date }): string | null {
  const root = parseIcal(icalText);
  if (!root) return null;
  const ev = findMainVEvent(root);
  if (!ev) return null;
  patchComponent(ev, root, patch);
  return serializeComponent(root) + '\r\n';
}

/**
 * Apply `patch` to one VEVENT component in place (the master in patchVEvent, a
 * RECURRENCE-ID override in calendar/exceptions.ts). Untouched properties and
 * sub-components are kept verbatim.
 */
export function patchComponent(ev: IcalComponent, root: IcalComponent, patch: VEventFields & { dtstamp?: Date }): void {
  const current = parseVEventComponent(ev, root);

  const setSingle = (name: string, prop: IcalProperty | null): void => {
    const idx = ev.properties.findIndex((p) => p.name === name);
    ev.properties = ev.properties.filter((p) => p.name !== name);
    if (prop) ev.properties.splice(idx >= 0 ? idx : ev.properties.length, 0, prop);
  };

  if (patch.summary !== undefined) setSingle('SUMMARY', textProp('SUMMARY', patch.summary));
  if (patch.description !== undefined) setSingle('DESCRIPTION', patch.description ? textProp('DESCRIPTION', patch.description) : null);
  if (patch.location !== undefined) setSingle('LOCATION', patch.location ? textProp('LOCATION', patch.location) : null);

  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    const allDay = patch.allDay ?? current?.allDay ?? false;
    const start = patch.start ?? current?.start ?? new Date();
    const end = patch.end ?? current?.end ?? start;
    const startProp = getProperty(ev, 'DTSTART');
    const tz = !allDay && startProp?.params['TZID'] ? resolveTzid(startProp.params['TZID'], root) : null;
    const [s, e] = dateProps(start, end, allDay, tz);
    setSingle('DTSTART', s ?? null);
    ev.properties = ev.properties.filter((p) => p.name !== 'DURATION');
    setSingle('DTEND', e ?? null);
  }
  if (patch.rrule !== undefined) setSingle('RRULE', patch.rrule ? { name: 'RRULE', params: {}, value: sanitizeRrule(patch.rrule) } : null);
  if (patch.classification !== undefined) {
    const cls = patch.classification.toUpperCase();
    setSingle('CLASS', cls === 'PRIVATE' || cls === 'CONFIDENTIAL' ? { name: 'CLASS', params: {}, value: cls } : null);
  }
  if (patch.status !== undefined) setSingle('STATUS', { name: 'STATUS', params: {}, value: patch.status.toUpperCase().replace(/[^A-Z-]/g, '') });
  if (patch.sequence !== undefined) setSingle('SEQUENCE', { name: 'SEQUENCE', params: {}, value: String(Math.max(0, Math.floor(patch.sequence))) });
  if (patch.organizer !== undefined) {
    setSingle('ORGANIZER', patch.organizer
      ? { name: 'ORGANIZER', params: patch.organizer.cn ? { CN: patch.organizer.cn } : {}, value: `mailto:${patch.organizer.email.replace(/[\s"]/g, '')}` }
      : null);
  }
  if (patch.attendees !== undefined) {
    // Keep the original parameters (e.g. CUTYPE, DELEGATED-*) of attendees that stay
    const old = new Map(getProperties(ev, 'ATTENDEE').map((p) => [mailto(p.value).toLowerCase(), p]));
    ev.properties = ev.properties.filter((p) => p.name !== 'ATTENDEE');
    for (const a of patch.attendees) {
      const fresh = attendeeProp(a);
      const prev = old.get(a.email.toLowerCase());
      ev.properties.push(prev ? { ...prev, params: { ...prev.params, ...fresh.params } } : fresh);
    }
  }
  if (patch.showAs !== undefined) {
    const [transp, busy] = showAsProps(patch.showAs);
    setSingle('TRANSP', transp ?? null);
    setSingle(BUSY_STATUS_PROP, busy ?? null);
  }
  if (patch.alarm !== undefined) {
    ev.components = ev.components.filter((c) => c.name !== 'VALARM');
    if (patch.alarm) ev.components.push(...alarmComponents(patch.alarm, patch.summary ?? current?.summary ?? ''));
  }
  if (!getProperty(ev, 'UID')) ev.properties.unshift({ name: 'UID', params: {}, value: `${Date.now()}@coremail` });
  setSingle('DTSTAMP', { name: 'DTSTAMP', params: {}, value: formatUtcDateTime(patch.dtstamp ?? new Date()) });
  setSingle('LAST-MODIFIED', { name: 'LAST-MODIFIED', params: {}, value: formatUtcDateTime(patch.dtstamp ?? new Date()) });
}

// ─── Grantee privacy (CLASS, RFC 5545 §3.8.1.3) ──────────────────────────────
// Shared by CalDAV and the REST API (8.0.0: moved here from caldav-server so both
// apply the same rule, including CLASS of individual recurrence overrides).

/** SUMMARY of a masked PRIVATE event (CalDAV and REST show the same text). */
export const MASKED_SUMMARY = 'Beschäftigt';

export type Classification = 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL';

export function normClass(v: string | null | undefined): Classification {
  const c = (v ?? 'PUBLIC').trim().toUpperCase();
  return c === 'PRIVATE' || c === 'CONFIDENTIAL' ? c : 'PUBLIC';
}

const CLASS_RANK: Record<Classification, number> = { PUBLIC: 0, PRIVATE: 1, CONFIDENTIAL: 2 };
const stricterClass = (a: Classification, b: Classification): Classification => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);
const componentClass = (c: IcalComponent | null): Classification => normClass(c ? getProperty(c, 'CLASS')?.value : null);

/**
 * 9.4: classification of one occurrence as a grantee sees it — the stricter of the
 * series and its override (an override never makes an occurrence more visible).
 */
export function stricterClassification(a: string | null | undefined, b: string | null | undefined): Classification {
  return stricterClass(normClass(a), normClass(b));
}

/**
 * Properties a grantee may see of a PRIVATE component: the scheduling skeleton only.
 * Everything else — SUMMARY, DESCRIPTION, LOCATION, attendees, CONFERENCE, GEO,
 * STYLED-DESCRIPTION, RELATED-TO, IMAGE, URL, X-…, alarms — is dropped.
 */
const MASK_KEEP_VEVENT = new Set([
  'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE',
  'RECURRENCE-ID', 'TRANSP', 'STATUS', 'SEQUENCE', 'CLASS',
]);
const MASK_KEEP_VCALENDAR = new Set(['VERSION', 'PRODID', 'CALSCALE']);

function maskComponent(ev: IcalComponent): void {
  ev.properties = ev.properties.filter((p) => MASK_KEEP_VEVENT.has(p.name));
  ev.properties.push({ name: 'SUMMARY', params: {}, value: escapeText(MASKED_SUMMARY) });
  ev.components = [];
}

export interface EventView {
  /** Calendar object text the viewer may see. */
  data: string;
  /** true when at least one component was masked (the view differs from the stored object). */
  masked: boolean;
}

/**
 * What a viewer may see of a stored event:
 *  - owner: everything
 *  - CONFIDENTIAL (column or master CLASS): null → hidden
 *  - PRIVATE master: every VEVENT masked to the allowlist + SUMMARY "Busy"
 *  - PUBLIC master: overridden instances with their own CLASS:PRIVATE/CONFIDENTIAL are masked
 */
export function granteeView(icalData: string, classification: string | null, isOwner: boolean): EventView | null {
  if (isOwner) return { data: icalData, masked: false };
  const columnCls = normClass(classification);
  if (columnCls === 'CONFIDENTIAL') return null;
  const root = parseIcal(icalData);
  if (!root) return columnCls === 'PUBLIC' ? { data: icalData, masked: false } : null;
  const master = findMainVEvent(root);
  const masterCls = stricterClass(columnCls, componentClass(master));
  if (masterCls === 'CONFIDENTIAL') return null;

  const events = root.name === 'VEVENT' ? [root] : root.components.filter((c) => c.name === 'VEVENT');
  let masked = false;
  for (const ev of events) {
    const cls = ev === master || masterCls === 'PRIVATE' ? masterCls : componentClass(ev);
    if (cls === 'PUBLIC') continue;
    maskComponent(ev); // an override marked CONFIDENTIAL is shown as "busy" like PRIVATE
    masked = true;
  }
  if (!masked) return { data: icalData, masked: false };
  if (root.name === 'VCALENDAR') {
    root.properties = root.properties.filter((p) => MASK_KEEP_VCALENDAR.has(p.name));
    root.components = root.components.filter((c) => c.name === 'VEVENT' || c.name === 'VTIMEZONE');
  }
  return { data: serializeComponent(root) + '\r\n', masked: true };
}

/**
 * May a grantee (not the owner) with write permission modify or delete this event?
 * Only when it sees the stored object unmasked: never a PRIVATE/CONFIDENTIAL event, and
 * never a PUBLIC series with a PRIVATE/CONFIDENTIAL override — writing the masked copy
 * back would overwrite (or deleting would destroy) data the grantee may not see.
 */
export function granteeMayWrite(icalData: string | null | undefined, classification: string | null): boolean {
  const view = granteeView(icalData ?? '', classification, false);
  return view !== null && !view.masked;
}
