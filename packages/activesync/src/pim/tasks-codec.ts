/**
 * Tasks class codec ([MS-ASTASK]) — pure. Maps the 9.4 task model:
 *
 *   Subject / airsyncbase:Body      subject, body (+ bodyHtml)
 *   Importance 0 / 1 / 2            priority LOW / NORMAL / HIGH
 *   UtcStartDate + StartDate        startDate (StartDate = local time in the user's zone)
 *   UtcDueDate + DueDate            dueDate
 *   Complete + DateCompleted        status COMPLETED + completedAt (task-rules.ts keep % in step)
 *   ReminderSet + ReminderTime      reminder
 *   Sensitivity 0 / 2               isPrivate
 *   Recurrence                      rrule (a recurring task repeats on completion)
 *
 * Fields without an ActiveSync form (% complete, effort, mileage, billing, companies, mail
 * reminder) stay untouched by device changes.
 */
import { parseDateString, utcToWallClockMs } from '@coremail/core/calendar';
import type { TaskColumns, TaskProgressPatch, TaskRecord } from '@coremail/storage';
import { pel, CP, type WbxmlElement } from '../wbxml.js';
import { supports } from '../protocol-version.js';
import { buildTextBody } from '../commands/body.js';
import { formatCompactDate, formatEasDate, formatLocalEasDate, parseEasDate } from './dates.js';
import { easToRrule, isRepresentable, parseRecurrence, rruleToEas, taskRecurrenceElements, type EasRecurrence } from './recurrence.js';
import { changedBody, clears, intIn, itemData, type BodyInput, type ItemData } from './codec.js';
import type { RenderContext, WriteContext } from './types.js';

const T = CP.Tasks;
const IMPORTANCE: Record<string, string> = { LOW: '0', NORMAL: '1', HIGH: '2' };
const IMPORTANCE_IN: Record<string, string> = { 0: 'LOW', 1: 'NORMAL', 2: 'HIGH' };
/** Subject of a task the device sent without one (the column is required). */
export const NO_SUBJECT = '(no subject)';

export type TaskRow = Pick<TaskRecord,
  'id' | 'subject' | 'body' | 'bodyHtml' | 'status' | 'priority' | 'startDate' | 'dueDate' | 'completedAt'
  | 'reminder' | 'isPrivate' | 'rrule' | 'updatedAt'>;

const recurrenceOf = (rrule: string, anchor: Date): EasRecurrence | null =>
  rruleToEas(rrule, anchor, (raw) => parseDateString(raw)?.date ?? null);

/** tasks:* properties of a stored task, in [MS-ASTASK] order. */
export function renderTask(t: TaskRow, ctx: RenderContext): WbxmlElement[] {
  const zone = ctx.user.timeZone ?? 'UTC';
  const local = (d: Date) => formatLocalEasDate(utcToWallClockMs(d.getTime(), zone));
  const complete = t.status === 'COMPLETED';
  const anchor = t.startDate ?? t.dueDate;
  const recurrence = t.rrule && anchor ? recurrenceOf(t.rrule, anchor) : null;
  return [
    buildTextBody(ctx.bodyPref, { bodyText: t.body, bodyHtml: t.bodyHtml }, ctx.version),
    pel(T, 'Subject', t.subject),
    pel(T, 'Importance', IMPORTANCE[t.priority] ?? '1'),
    ...(t.startDate ? [pel(T, 'UtcStartDate', formatEasDate(t.startDate)), pel(T, 'StartDate', local(t.startDate))] : []),
    ...(t.dueDate ? [pel(T, 'UtcDueDate', formatEasDate(t.dueDate)), pel(T, 'DueDate', local(t.dueDate))] : []),
    ...(recurrence && anchor
      ? [pel(T, 'Recurrence', taskRecurrenceElements(recurrence, anchor, formatEasDate, supports(ctx.version, 'recurrenceFirstDayOfWeek')))]
      : []),
    pel(T, 'Complete', complete ? '1' : '0'),
    ...(complete && t.completedAt ? [pel(T, 'DateCompleted', formatEasDate(t.completedAt))] : []),
    pel(T, 'Sensitivity', t.isPrivate ? '2' : '0'),
    ...(t.reminder ? [pel(T, 'ReminderTime', formatEasDate(t.reminder))] : []),
    pel(T, 'ReminderSet', t.reminder ? '1' : '0'),
  ];
}

export interface TaskInput {
  data: ItemData;
  subject?: string;
  body?: BodyInput;
  priority?: string;
  startDate?: Date;
  dueDate?: Date;
  complete?: boolean;
  dateCompleted?: Date;
  reminderSet?: boolean;
  reminderTime?: Date;
  isPrivate?: boolean;
  recurrence?: EasRecurrence;
  /** Recurrence Start (the anchor of a recurring task without start / due date). */
  recurrenceStart?: Date;
}

/** The client's ApplicationData of a task. UtcStartDate / UtcDueDate win over the local forms. */
export function parseTask(appData: WbxmlElement): TaskInput {
  const d = itemData(appData);
  const date = (utc: string, local: string) => parseEasDate(d.text(utc) ?? d.text(local) ?? '') ?? undefined;
  const set = <K extends keyof TaskInput>(out: TaskInput, key: K, v: TaskInput[K] | undefined) => { if (v !== undefined) out[key] = v; };
  const out: TaskInput = { data: d };
  set(out, 'subject', d.text('Subject'));
  set(out, 'body', d.body());
  set(out, 'priority', IMPORTANCE_IN[d.text('Importance') ?? '']);
  set(out, 'startDate', date('UtcStartDate', 'StartDate'));
  set(out, 'dueDate', date('UtcDueDate', 'DueDate'));
  const complete = d.text('Complete');
  if (complete !== undefined) out.complete = complete === '1';
  set(out, 'dateCompleted', parseEasDate(d.text('DateCompleted') ?? '') ?? undefined);
  const reminderSet = d.text('ReminderSet');
  if (reminderSet !== undefined) out.reminderSet = reminderSet === '1';
  set(out, 'reminderTime', parseEasDate(d.text('ReminderTime') ?? '') ?? undefined);
  const sensitivity = intIn(d.text('Sensitivity'), 0, 3);
  if (sensitivity !== undefined) out.isPrivate = sensitivity !== 0;
  const recurrence = d.child('Recurrence');
  if (recurrence) {
    set(out, 'recurrence', parseRecurrence(recurrence, parseEasDate) ?? undefined);
    set(out, 'recurrenceStart', parseEasDate(itemData(recurrence).text('Start') ?? '') ?? undefined);
  }
  return out;
}

export interface TaskChange { columns: TaskColumns; patch: TaskProgressPatch }

/**
 * Columns and progress change of a client Add (`stored` null) or Change ([MS-ASCMD]: an
 * element missing from a Change is cleared unless the client ghosts it).
 */
export function taskChange(input: TaskInput, stored: TaskRow | null, ctx: WriteContext): TaskChange {
  const has = (name: string) => input.data.present.has(name);
  const clear = (name: string) => stored !== null && !has(name) && clears(ctx.supported, name);
  const columns: TaskColumns = {};
  if (input.subject !== undefined || !stored) columns.subject = input.subject?.trim() || NO_SUBJECT;
  if (input.body) {
    const text = changedBody(stored?.body ?? '', input.body.text, ctx.truncatedAt);
    // unchanged text keeps the rich-text note of the webmail
    if (!stored || text !== stored.body) { columns.body = text; columns.bodyHtml = input.body.html; }
  } else if (clear('Body')) { columns.body = ''; columns.bodyHtml = ''; }
  if (input.priority) columns.priority = input.priority; else if (clear('Importance')) columns.priority = 'NORMAL';
  const start = input.startDate ?? (input.recurrence && !input.dueDate ? input.recurrenceStart : undefined);
  if (start) columns.startDate = start; else if (clear('UtcStartDate')) columns.startDate = null;
  if (input.dueDate) columns.dueDate = input.dueDate; else if (clear('UtcDueDate')) columns.dueDate = null;
  if (input.reminderSet === false) columns.reminder = null;
  else if (input.reminderSet && input.reminderTime) columns.reminder = input.reminderTime;
  else if (clear('ReminderSet')) columns.reminder = null;
  if (input.isPrivate !== undefined) columns.isPrivate = input.isPrivate; else if (clear('Sensitivity')) columns.isPrivate = false;
  if (input.recurrence) columns.rrule = easToRrule(input.recurrence, formatCompactDate);
  else if (has('Recurrence')) columns.rrule = null;
  else if (clear('Recurrence') && stored?.rrule && isRepresentable(stored.rrule, stored.startDate ?? stored.dueDate ?? new Date(0))) columns.rrule = null;

  const patch: TaskProgressPatch = {};
  if (input.complete === true) {
    patch.status = 'COMPLETED';
    patch.completedAt = input.dateCompleted ?? stored?.completedAt ?? ctx.now;
  } else if (input.complete === false && stored?.status === 'COMPLETED') {
    patch.completedAt = null;
  }
  return { columns, patch };
}
