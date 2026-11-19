/**
 * 9.5: VTODO ↔ Task mapping of the CalDAV task list (pure).
 *
 *   SUMMARY ↔ subject              DESCRIPTION ↔ body (plain text; a changed text drops bodyHtml)
 *   STATUS + PERCENT-COMPLETE + COMPLETED ↔ status / percentComplete / completedAt
 *     NEEDS-ACTION ↔ NOT_STARTED, IN-PROCESS ↔ IN_PROGRESS, COMPLETED ↔ COMPLETED,
 *     CANCELLED → DEFERRED; WAITING / DEFERRED are shown as NEEDS-ACTION or IN-PROCESS
 *     (by %) and stay as they are while a client sends that value back
 *   DTSTART ↔ startDate            DUE (or DTSTART + DURATION) ↔ dueDate
 *   PRIORITY 1–4 / 5 / 6–9 ↔ HIGH / NORMAL / LOW (0 or none = NORMAL)
 *   CLASS PRIVATE / CONFIDENTIAL ↔ isPrivate
 *   RRULE ↔ rrule (a task repeats at most daily)
 *   first VALARM (absolute, or relative to DTSTART / DUE) ↔ reminder
 *
 * The VTODO a client stored is kept (Task.icalData) and is the base of every read:
 * the task columns replace what they map, everything else — CATEGORIES, URL, X-
 * properties, further alarms — round-trips unchanged. A property whose stored value
 * already means the same as the column (e.g. PRIORITY:5 for NORMAL, DUE with TZID at
 * the same instant) is kept verbatim. Occurrence overrides (RECURRENCE-ID) are not
 * stored: one task is one occurrence; an override marked COMPLETED completes the task
 * (the task rules then create the next one).
 */
import {
  escapeText,
  formatDateOnly,
  formatUtcDateTime,
  getProperties,
  getProperty,
  parseDateProperty,
  parseDateString,
  parseDuration,
  parseIcal,
  serializeComponent,
  serializeProperty,
  unescapeText,
  type IcalComponent,
  type IcalProperty,
} from '@coremail/core/calendar';
import {
  normTaskRrule, normTaskStatus, TASK_RRULE_PATTERN,
  type TaskColumns, type TaskProgressPatch, type TaskStatus,
} from '@coremail/storage';

/** Largest VTODO a client may store (bytes). */
export const MAX_VTODO_BYTES = 1024 * 1024;
const MAX_SUBJECT = 500;
const MAX_BODY = 100_000;
const PRODID = '-//CoreMail//CoreMail Tasks//EN';

/** The task columns the mapping reads. */
export interface TaskRow {
  id: string;
  uid: string | null;
  icalData: string | null;
  subject: string;
  body: string;
  status: string;
  percentComplete: number;
  completedAt: Date | null;
  startDate: Date | null;
  dueDate: Date | null;
  reminder: Date | null;
  priority: string;
  isPrivate: boolean;
  rrule: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH';

/** What a client's VTODO says, in task terms. */
export interface VTodoFields {
  uid: string | null;
  summary: string;
  description: string;
  /** STATUS as sent (upper case), null when absent. */
  icalStatus: string | null;
  percent: number | null;
  completed: Date | null;
  start: Date | null;
  due: Date | null;
  priority: TaskPriority;
  isPrivate: boolean;
  rrule: string | null;
  reminder: Date | null;
  /** An occurrence override (RECURRENCE-ID) is marked COMPLETED. */
  occurrenceCompleted: boolean;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const prop = (name: string, value: string, params: Record<string, string> = {}): IcalProperty => ({ name, params, value });
const text = (c: IcalComponent, name: string): string => {
  const p = getProperty(c, name);
  return p ? unescapeText(p.value) : '';
};
const normNewlines = (s: string): string => s.replace(/\r\n?/g, '\n');
const isDateOnly = (p: IcalProperty): boolean => (p.params['VALUE'] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(p.value.trim());
const isMidnightUtc = (d: Date): boolean => d.getTime() % 86_400_000 === 0;

function dateOf(c: IcalComponent, name: string, root: IcalComponent): Date | null {
  const p = getProperty(c, name);
  const v = p ? parseDateProperty(p, root) : null;
  return v && !isNaN(v.date.getTime()) ? v.date : null;
}

function masterTodo(root: IcalComponent): IcalComponent | undefined {
  return root.components.find((c) => c.name === 'VTODO' && !getProperty(c, 'RECURRENCE-ID'));
}

/** PRIORITY (RFC scale 1 = highest … 9 = lowest, 0 = undefined) → task priority. */
export function priorityOf(value: string | undefined): TaskPriority {
  const n = Number.parseInt((value ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 9) return 'NORMAL';
  if (n <= 4) return 'HIGH';
  return n === 5 ? 'NORMAL' : 'LOW';
}

const PRIORITY_VALUE: Record<TaskPriority, string | null> = { HIGH: '1', NORMAL: null, LOW: '9' };

/** PRIORITY of a task: the stored value when it means the same, else 1 / none / 9. */
function priorityProp(stored: IcalProperty | undefined, priority: string): IcalProperty | null {
  if (priorityOf(stored?.value) === priority) return stored ?? null;
  const value = PRIORITY_VALUE[priority as TaskPriority] ?? null;
  return value === null ? null : prop('PRIORITY', value);
}

/** STATUS shown for a task. `stored` = the STATUS of the stored VTODO (CANCELLED stays CANCELLED). */
export function icalStatusOf(status: TaskStatus, percent: number, stored: string | null): string {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'DEFERRED' && stored === 'CANCELLED') return 'CANCELLED';
  if (status === 'NOT_STARTED') return 'NEEDS-ACTION';
  if (status === 'IN_PROGRESS') return 'IN-PROCESS';
  return percent > 0 ? 'IN-PROCESS' : 'NEEDS-ACTION'; // WAITING / DEFERRED have no iCalendar value
}

const STATUS_FROM_ICAL: Record<string, TaskStatus> = {
  'NEEDS-ACTION': 'NOT_STARTED', 'IN-PROCESS': 'IN_PROGRESS', COMPLETED: 'COMPLETED', CANCELLED: 'DEFERRED',
};

/** The instant of an alarm: absolute TRIGGER, or a duration relative to DTSTART (RELATED=END: DUE). */
function alarmInstant(alarm: IcalComponent, start: Date | null, due: Date | null): Date | null {
  const trigger = getProperty(alarm, 'TRIGGER');
  if (!trigger) return null;
  if ((trigger.params['VALUE'] ?? '').toUpperCase() === 'DATE-TIME') return parseDateString(trigger.value)?.date ?? null;
  const ms = parseDuration(trigger.value);
  const anchor = (trigger.params['RELATED'] ?? '').toUpperCase() === 'END' ? due ?? start : start ?? due;
  return ms === null || !anchor ? null : new Date(anchor.getTime() + ms);
}

function firstAlarmInstant(todo: IcalComponent, root: IcalComponent): Date | null {
  const alarm = todo.components.find((c) => c.name === 'VALARM');
  return alarm ? alarmInstant(alarm, dateOf(todo, 'DTSTART', root), dueOf(todo, root)) : null;
}

/** DUE, else DTSTART + DURATION. */
function dueOf(todo: IcalComponent, root: IcalComponent): Date | null {
  const due = dateOf(todo, 'DUE', root);
  if (due) return due;
  const start = dateOf(todo, 'DTSTART', root);
  const duration = getProperty(todo, 'DURATION');
  const ms = duration ? parseDuration(duration.value) : null;
  return start && ms !== null ? new Date(start.getTime() + ms) : null;
}

// ─── VTODO → task (PUT) ──────────────────────────────────────────────────────

export type VTodoValidation =
  | { ok: true; fields: VTodoFields }
  | { ok: false; status: number; element: string; message: string };

const ALLOWED_COMPONENTS = new Set(['VTODO', 'VTIMEZONE']);

/** Validate a calendar object for the task list and read its VTODO. */
export function parseVTodoObject(icalText: string): VTodoValidation {
  if (Buffer.byteLength(icalText, 'utf8') > MAX_VTODO_BYTES) {
    return { ok: false, status: 403, element: 'c:max-resource-size', message: 'calendar object too large' };
  }
  const root = parseIcal(icalText);
  if (!root || root.name !== 'VCALENDAR') return { ok: false, status: 400, element: 'c:valid-calendar-data', message: 'no VCALENDAR' };
  const unsupported = root.components.find((c) => !ALLOWED_COMPONENTS.has(c.name));
  if (unsupported) {
    return { ok: false, status: 403, element: 'c:supported-calendar-component', message: `${unsupported.name} is not supported (VTODO only)` };
  }
  if (getProperty(root, 'METHOD')) {
    return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'METHOD is not allowed in a stored calendar object' };
  }
  const todos = root.components.filter((c) => c.name === 'VTODO');
  if (new Set(todos.map((t) => getProperty(t, 'UID')?.value.trim() ?? '')).size > 1) {
    return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'all components must share one UID' };
  }
  const todo = masterTodo(root);
  if (!todo) return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'no VTODO without RECURRENCE-ID' };
  const rruleValue = getProperty(todo, 'RRULE')?.value.trim() ?? null;
  if (rruleValue !== null && (rruleValue.length > 500 || !TASK_RRULE_PATTERN.test(rruleValue))) {
    return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'a task repeats at most daily' };
  }
  const percent = Number.parseInt(getProperty(todo, 'PERCENT-COMPLETE')?.value.trim() ?? '', 10);
  const cls = (getProperty(todo, 'CLASS')?.value ?? '').trim().toUpperCase();
  const start = dateOf(todo, 'DTSTART', root);
  const due = dueOf(todo, root);
  const alarm = todo.components.find((c) => c.name === 'VALARM');
  return {
    ok: true,
    fields: {
      uid: getProperty(todo, 'UID')?.value.trim() || null,
      summary: text(todo, 'SUMMARY').slice(0, MAX_SUBJECT),
      description: text(todo, 'DESCRIPTION').slice(0, MAX_BODY),
      icalStatus: getProperty(todo, 'STATUS')?.value.trim().toUpperCase() || null,
      percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null,
      completed: dateOf(todo, 'COMPLETED', root),
      start,
      due,
      priority: priorityOf(getProperty(todo, 'PRIORITY')?.value),
      isPrivate: cls === 'PRIVATE' || cls === 'CONFIDENTIAL',
      rrule: rruleValue ? normTaskRrule(rruleValue) : null,
      reminder: alarm ? alarmInstant(alarm, start, due) : null,
      occurrenceCompleted: todos.some((t) => t !== todo && (getProperty(t, 'STATUS')?.value ?? '').trim().toUpperCase() === 'COMPLETED'),
    },
  };
}

/** STATUS of the stored VTODO of a task (null when none is stored). */
function storedStatusOf(task: Pick<TaskRow, 'icalData'>): string | null {
  const root = task.icalData ? parseIcal(task.icalData) : null;
  const todo = root ? masterTodo(root) : undefined;
  return todo ? getProperty(todo, 'STATUS')?.value.trim().toUpperCase() ?? null : null;
}

/**
 * The status-rule patch of a client's VTODO. A STATUS that is what the task already
 * shows keeps the task's own status (WAITING / DEFERRED survive a round trip); a
 * completion date only counts with STATUS:COMPLETED (or without STATUS).
 */
export function progressFromVTodo(f: VTodoFields, current: TaskRow | null): TaskProgressPatch {
  const icalStatus = f.occurrenceCompleted || (f.icalStatus === null && f.completed) ? 'COMPLETED' : f.icalStatus ?? 'NEEDS-ACTION';
  const patch: TaskProgressPatch = {};
  const unchanged = current !== null
    && icalStatusOf(normTaskStatus(current.status), current.percentComplete, storedStatusOf(current)) === icalStatus;
  if (!unchanged) {
    const mapped = STATUS_FROM_ICAL[icalStatus] ?? 'NOT_STARTED';
    // NEEDS-ACTION with a percentage: the percentage decides (the rules start the task)
    if (!(mapped === 'NOT_STARTED' && (f.percent ?? 0) > 0)) patch.status = mapped;
  }
  if (icalStatus === 'COMPLETED') {
    if (f.completed) patch.completedAt = f.completed;
  } else if (f.percent !== null) {
    patch.percentComplete = f.percent;
  }
  return patch;
}

/** Task columns of a client's VTODO (a changed plain text drops the rich-text note). */
export function columnsFromVTodo(f: VTodoFields, current: TaskRow | null, icalData: string): TaskColumns & { subject: string } {
  const bodyChanged = !current || normNewlines(f.description) !== normNewlines(current.body);
  return {
    subject: f.summary,
    body: f.description,
    ...(bodyChanged ? { bodyHtml: '' } : {}),
    priority: f.priority,
    isPrivate: f.isPrivate,
    startDate: f.start,
    dueDate: f.due,
    reminder: f.reminder,
    rrule: f.rrule,
    uid: f.uid,
    icalData,
  };
}

// ─── Task → VTODO (GET / REPORT) ─────────────────────────────────────────────

/** Replace every `name` property by `next` (null removes); true when the component changed. */
function putProp(c: IcalComponent, name: string, next: IcalProperty | null): boolean {
  const current = getProperties(c, name);
  if (current.map(serializeProperty).join('\n') === (next ? serializeProperty(next) : '')) return false;
  const at = c.properties.findIndex((p) => p.name === name);
  c.properties = c.properties.filter((p) => p.name !== name);
  if (next) c.properties.splice(at >= 0 ? Math.min(at, c.properties.length) : c.properties.length, 0, next);
  return true;
}

/** The stored property when it already means `date`, else a new one (date-only for a UTC-midnight day). */
function dateProp(name: string, date: Date | null, todo: IcalComponent, root: IcalComponent): IcalProperty | null {
  if (!date) return null;
  const stored = getProperty(todo, name);
  if (stored && parseDateProperty(stored, root)?.date.getTime() === date.getTime()) return stored;
  const dateOnly = isMidnightUtc(date) && (stored ? isDateOnly(stored) : true);
  return dateOnly ? prop(name, formatDateOnly(date), { VALUE: 'DATE' }) : prop(name, formatUtcDateTime(date));
}

/** DTSTART and DUE must share one value type: a date-only one becomes UTC date-time. */
function alignDateTypes(start: IcalProperty | null, due: IcalProperty | null): [IcalProperty | null, IcalProperty | null] {
  if (!start || !due || isDateOnly(start) === isDateOnly(due)) return [start, due];
  const asDateTime = (p: IcalProperty): IcalProperty => prop(p.name, formatUtcDateTime(parseDateString(p.value)!.date));
  return isDateOnly(start) ? [asDateTime(start), due] : [start, asDateTime(due)];
}

function reminderAlarms(todo: IcalComponent, root: IcalComponent, reminder: Date | null, summary: string): boolean {
  const alarms = todo.components.filter((c) => c.name === 'VALARM');
  if (reminder === null) {
    if (alarms.length === 0) return false;
    todo.components = todo.components.filter((c) => c.name !== 'VALARM');
    return true;
  }
  if (firstAlarmInstant(todo, root)?.getTime() === reminder.getTime()) return false;
  todo.components = [
    ...todo.components.filter((c) => c.name !== 'VALARM'),
    {
      name: 'VALARM',
      properties: [
        prop('ACTION', 'DISPLAY'),
        prop('TRIGGER', formatUtcDateTime(reminder), { VALUE: 'DATE-TIME' }),
        prop('DESCRIPTION', escapeText(summary || 'Erinnerung')),
      ],
      components: [],
    },
  ];
  return true;
}

/** Apply the task columns to the VTODO; true when something changed. */
function applyTask(todo: IcalComponent, root: IcalComponent, task: TaskRow): boolean {
  const status = normTaskStatus(task.status);
  const storedStatus = getProperty(todo, 'STATUS')?.value.trim().toUpperCase() ?? null;
  const storedPercent = Number.parseInt(getProperty(todo, 'PERCENT-COMPLETE')?.value.trim() ?? '0', 10) || 0;
  const cls = (getProperty(todo, 'CLASS')?.value ?? 'PUBLIC').trim().toUpperCase();
  const storedRrule = getProperty(todo, 'RRULE');
  const [start, due] = alignDateTypes(dateProp('DTSTART', task.startDate, todo, root), dateProp('DUE', task.dueDate, todo, root));
  const icalStatus = icalStatusOf(status, task.percentComplete, storedStatus);

  const changes = [
    putProp(todo, 'SUMMARY', text(todo, 'SUMMARY') === task.subject ? getProperty(todo, 'SUMMARY') ?? null : prop('SUMMARY', escapeText(task.subject))),
    putProp(todo, 'DESCRIPTION', !task.body ? null
      : normNewlines(text(todo, 'DESCRIPTION')) === normNewlines(task.body) ? getProperty(todo, 'DESCRIPTION')! : prop('DESCRIPTION', escapeText(task.body))),
    putProp(todo, 'STATUS', storedStatus === icalStatus ? getProperty(todo, 'STATUS')! : prop('STATUS', icalStatus)),
    putProp(todo, 'PERCENT-COMPLETE', storedPercent === task.percentComplete
      ? getProperty(todo, 'PERCENT-COMPLETE') ?? null
      : task.percentComplete > 0 ? prop('PERCENT-COMPLETE', String(task.percentComplete)) : null),
    putProp(todo, 'COMPLETED', !task.completedAt ? null
      : dateOf(todo, 'COMPLETED', root)?.getTime() === task.completedAt.getTime() ? getProperty(todo, 'COMPLETED')! : prop('COMPLETED', formatUtcDateTime(task.completedAt))),
    putProp(todo, 'DTSTART', start),
    putProp(todo, 'DUE', due),
    putProp(todo, 'DURATION', task.dueDate || !getProperty(todo, 'DURATION') ? null : getProperty(todo, 'DURATION')!),
    putProp(todo, 'PRIORITY', priorityProp(getProperty(todo, 'PRIORITY'), task.priority)),
    putProp(todo, 'CLASS', task.isPrivate
      ? (cls === 'PRIVATE' || cls === 'CONFIDENTIAL' ? getProperty(todo, 'CLASS')! : prop('CLASS', 'PRIVATE'))
      : (cls === 'PUBLIC' ? getProperty(todo, 'CLASS') ?? null : null)),
    putProp(todo, 'RRULE', !task.rrule ? null
      : storedRrule && normTaskRrule(storedRrule.value.trim()) === task.rrule ? storedRrule : prop('RRULE', task.rrule)),
    ...(task.rrule ? [] : [putProp(todo, 'RDATE', null), putProp(todo, 'EXDATE', null)]),
    reminderAlarms(todo, root, task.reminder, task.subject),
  ];
  return changes.some(Boolean);
}

function freshCalendar(): IcalComponent {
  return { name: 'VCALENDAR', properties: [prop('VERSION', '2.0'), prop('PRODID', PRODID)], components: [] };
}

/** The VTODO of a task: the stored client VTODO with the task columns applied. */
export function renderVTodo(task: TaskRow): string {
  const stored = task.icalData ? parseIcal(task.icalData) : null;
  const root = stored?.name === 'VCALENDAR' && masterTodo(stored) ? stored : freshCalendar();
  const todo = masterTodo(root) ?? { name: 'VTODO', properties: [], components: [] };
  root.properties = root.properties.filter((p) => p.name !== 'METHOD');
  if (!getProperty(root, 'VERSION')) root.properties.unshift(prop('VERSION', '2.0'));
  if (!getProperty(root, 'PRODID')) root.properties.push(prop('PRODID', PRODID));
  // one task = one occurrence: no other VTODO (overrides) and nothing but time zones besides
  root.components = [...root.components.filter((c) => c.name === 'VTIMEZONE'), todo];

  putProp(todo, 'UID', prop('UID', task.uid ?? task.id));
  if (!getProperty(todo, 'DTSTAMP')) todo.properties.push(prop('DTSTAMP', formatUtcDateTime(task.updatedAt)));
  if (!getProperty(todo, 'CREATED')) todo.properties.push(prop('CREATED', formatUtcDateTime(task.createdAt)));
  const changed = applyTask(todo, root, task);
  if (changed || !getProperty(todo, 'LAST-MODIFIED')) putProp(todo, 'LAST-MODIFIED', prop('LAST-MODIFIED', formatUtcDateTime(task.updatedAt)));
  return serializeComponent(root) + '\r\n';
}

/** A calendar object in the serialisation renderVTodo produces (to compare a PUT body with the stored result). */
export function normalizeCalendarText(icalText: string): string | null {
  const root = parseIcal(icalText);
  return root ? serializeComponent(root) + '\r\n' : null;
}

/**
 * CALDAV:time-range on a VTODO (the RFC 4791 §9.9 table): DTSTART / DUE span,
 * else the completion date, else always.
 */
export function taskInRange(task: Pick<TaskRow, 'startDate' | 'dueDate' | 'completedAt'>, start: Date, end: Date): boolean {
  const { startDate: s, dueDate: d, completedAt: c } = task;
  const startIn = (t: Date): boolean => start <= t && end > t;
  const dueIn = (t: Date): boolean => start < t && end >= t;
  if (s && d) return startIn(s) || dueIn(d) || (s <= start && d >= end);
  if (s) return startIn(s);
  if (d) return dueIn(d);
  if (c) return start <= c && end >= c;
  return true;
}
