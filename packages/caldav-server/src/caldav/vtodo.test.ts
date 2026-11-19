/**
 * 9.5: VTODO ↔ Task mapping of the CalDAV task list (pure).
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/caldav/vtodo.test.ts  (in packages/caldav-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRow, VTodoFields } from './vtodo.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const {
  parseVTodoObject, progressFromVTodo, columnsFromVTodo, renderVTodo, icalStatusOf, priorityOf, taskInRange,
  normalizeCalendarText,
} = await import('./vtodo.js');

const vcal = (...todo: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Client//EN', 'BEGIN:VTODO', ...todo, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
const fields = (text: string): VTodoFields => {
  const r = parseVTodoObject(text);
  assert.ok(r.ok, `invalid: ${JSON.stringify(r)}`);
  return r.fields;
};
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1', uid: null, icalData: null, subject: 'Bericht', body: '', status: 'NOT_STARTED', percentComplete: 0,
  completedAt: null, startDate: null, dueDate: null, reminder: null, priority: 'NORMAL', isPrivate: false, rrule: null,
  createdAt: new Date('2026-11-01T08:00:00Z'), updatedAt: new Date('2026-11-02T08:00:00Z'), ...over,
});
const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '');

test('VTODO → task fields: every mapped property', () => {
  const f = fields(vcal(
    'UID:abc@client', 'SUMMARY:Bericht\\, final', 'DESCRIPTION:Zeile 1\\nZeile 2', 'STATUS:IN-PROCESS', 'PERCENT-COMPLETE:40',
    'DTSTART;VALUE=DATE:20261201', 'DUE;TZID=Europe/Berlin:20261205T170000', 'PRIORITY:2', 'CLASS:CONFIDENTIAL',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'CATEGORIES:Arbeit',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT1H', 'END:VALARM',
  ));
  assert.equal(f.uid, 'abc@client');
  assert.equal(f.summary, 'Bericht, final');
  assert.equal(f.description, 'Zeile 1\nZeile 2');
  assert.equal(f.icalStatus, 'IN-PROCESS');
  assert.equal(f.percent, 40);
  assert.equal(f.start?.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(f.due?.toISOString(), '2026-12-05T16:00:00.000Z');
  assert.equal(f.priority, 'HIGH');
  assert.equal(f.isPrivate, true);
  assert.equal(f.rrule, 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(f.reminder?.toISOString(), '2026-12-05T15:00:00.000Z', 'RELATED=END: one hour before DUE');
});

test('alarms: absolute trigger, relative to DTSTART by default; DURATION gives the due date', () => {
  assert.equal(fields(vcal('UID:a', 'SUMMARY:x', 'BEGIN:VALARM', 'TRIGGER;VALUE=DATE-TIME:20261203T080000Z', 'END:VALARM')).reminder?.toISOString(), '2026-12-03T08:00:00.000Z');
  const rel = fields(vcal('UID:a', 'SUMMARY:x', 'DTSTART:20261203T090000Z', 'DURATION:PT2H', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM'));
  assert.equal(rel.reminder?.toISOString(), '2026-12-03T08:45:00.000Z');
  assert.equal(rel.due?.toISOString(), '2026-12-03T11:00:00.000Z');
});

test('PRIORITY scale and STATUS shown for each task status', () => {
  assert.deepEqual(['0', '1', '4', '5', '6', '9', 'x', undefined].map(priorityOf), ['NORMAL', 'HIGH', 'HIGH', 'NORMAL', 'LOW', 'LOW', 'NORMAL', 'NORMAL']);
  assert.equal(icalStatusOf('NOT_STARTED', 0, null), 'NEEDS-ACTION');
  assert.equal(icalStatusOf('IN_PROGRESS', 30, null), 'IN-PROCESS');
  assert.equal(icalStatusOf('COMPLETED', 100, null), 'COMPLETED');
  assert.equal(icalStatusOf('WAITING', 0, null), 'NEEDS-ACTION');
  assert.equal(icalStatusOf('WAITING', 20, null), 'IN-PROCESS');
  assert.equal(icalStatusOf('DEFERRED', 0, 'CANCELLED'), 'CANCELLED');
  assert.equal(icalStatusOf('DEFERRED', 0, null), 'NEEDS-ACTION');
});

test('preconditions: VEVENT, METHOD, two UIDs, override only, unsupported rule, size', () => {
  const bad = (text: string): string => { const r = parseVTodoObject(text); assert.equal(r.ok, false); return r.ok ? '' : r.element; };
  assert.equal(bad(vcal('UID:a').replace('BEGIN:VTODO', 'BEGIN:VEVENT\r\nUID:e\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nBEGIN:VTODO')), 'c:supported-calendar-component');
  assert.equal(bad(vcal('UID:a').replace('PRODID', 'METHOD:PUBLISH\r\nPRODID')), 'c:valid-calendar-object-resource');
  assert.equal(bad(vcal('UID:a').replace('END:VTODO', 'END:VTODO\r\nBEGIN:VTODO\r\nUID:b\r\nRECURRENCE-ID:20260101T000000Z\r\nEND:VTODO')), 'c:valid-calendar-object-resource');
  assert.equal(bad(vcal('UID:a', 'RECURRENCE-ID:20260101T000000Z')), 'c:valid-calendar-object-resource');
  assert.equal(bad(vcal('UID:a', 'RRULE:FREQ=HOURLY')), 'c:valid-calendar-object-resource');
  assert.equal(bad('BEGIN:VCARD\r\nEND:VCARD'), 'c:valid-calendar-data');
  assert.equal(bad(vcal('UID:a', `DESCRIPTION:${'x'.repeat(1024 * 1024)}`)), 'c:max-resource-size');
});

test('status patch: mapped values, round trip of WAITING / DEFERRED, NEEDS-ACTION with %, completion', () => {
  const f = (...props: string[]): VTodoFields => fields(vcal('UID:a', 'SUMMARY:x', ...props));
  assert.deepEqual(progressFromVTodo(f('STATUS:NEEDS-ACTION'), null), { status: 'NOT_STARTED' });
  assert.deepEqual(progressFromVTodo(f('STATUS:IN-PROCESS', 'PERCENT-COMPLETE:30'), null), { status: 'IN_PROGRESS', percentComplete: 30 });
  assert.deepEqual(progressFromVTodo(f('STATUS:NEEDS-ACTION', 'PERCENT-COMPLETE:30'), null), { percentComplete: 30 }, 'the percentage starts the task');
  assert.deepEqual(progressFromVTodo(f('STATUS:CANCELLED'), null), { status: 'DEFERRED' });
  assert.deepEqual(progressFromVTodo(f('STATUS:COMPLETED', 'COMPLETED:20261201T100000Z', 'PERCENT-COMPLETE:100'), null),
    { status: 'COMPLETED', completedAt: new Date('2026-12-01T10:00:00Z') });
  assert.deepEqual(progressFromVTodo(f('COMPLETED:20261201T100000Z'), null), { status: 'COMPLETED', completedAt: new Date('2026-12-01T10:00:00Z') }, 'a completion date without STATUS completes');
  // a stale COMPLETED with STATUS:NEEDS-ACTION never completes
  assert.deepEqual(progressFromVTodo(f('STATUS:NEEDS-ACTION', 'COMPLETED:20261201T100000Z'), null), { status: 'NOT_STARTED' });
  // WAITING is shown as NEEDS-ACTION — sending that back keeps WAITING
  assert.deepEqual(progressFromVTodo(f('STATUS:NEEDS-ACTION'), task({ status: 'WAITING' })), {});
  assert.deepEqual(progressFromVTodo(f('STATUS:IN-PROCESS', 'PERCENT-COMPLETE:60'), task({ status: 'WAITING', percentComplete: 20 })), { percentComplete: 60 });
  // reopening a completed task
  assert.deepEqual(progressFromVTodo(f('STATUS:NEEDS-ACTION'), task({ status: 'COMPLETED', percentComplete: 100 })), { status: 'NOT_STARTED' });
  // a completed occurrence override completes the task
  const occ = fields(vcal('UID:a', 'SUMMARY:x', 'RRULE:FREQ=DAILY').replace('END:VCALENDAR', 'BEGIN:VTODO\r\nUID:a\r\nRECURRENCE-ID:20261201T000000Z\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR'));
  assert.equal(occ.occurrenceCompleted, true);
  assert.deepEqual(progressFromVTodo(occ, task({ rrule: 'FREQ=DAILY' })), { status: 'COMPLETED' });
});

test('columns: a changed description drops the rich-text note, the same one keeps it', () => {
  const text = vcal('UID:a', 'SUMMARY:x', 'DESCRIPTION:Notiz');
  const f = fields(text);
  assert.equal(columnsFromVTodo(f, task({ body: 'Notiz' }), text).bodyHtml, undefined);
  assert.equal(columnsFromVTodo(f, task({ body: 'Alt' }), text).bodyHtml, '');
  assert.equal(columnsFromVTodo(f, null, text).icalData, text);
});

test('render: a webmail task becomes a valid VTODO (dates as days, private, priority, alarm, rule)', () => {
  const out = unfold(renderVTodo(task({
    subject: 'Steuer; Erklärung', body: 'a\nb', status: 'IN_PROGRESS', percentComplete: 50, priority: 'LOW', isPrivate: true,
    startDate: new Date('2026-12-01T00:00:00Z'), dueDate: new Date('2026-12-10T00:00:00Z'), reminder: new Date('2026-12-09T08:00:00Z'),
    rrule: 'FREQ=MONTHLY',
  })));
  for (const line of [
    'UID:t1', 'SUMMARY:Steuer\\; Erklärung', 'DESCRIPTION:a\\nb', 'STATUS:IN-PROCESS', 'PERCENT-COMPLETE:50', 'PRIORITY:9',
    'CLASS:PRIVATE', 'DTSTART;VALUE=DATE:20261201', 'DUE;VALUE=DATE:20261210', 'RRULE:FREQ=MONTHLY',
    'TRIGGER;VALUE=DATE-TIME:20261209T080000Z', 'LAST-MODIFIED:20261102T080000Z', 'CREATED:20261101T080000Z',
  ]) assert.ok(out.includes(`\r\n${line}\r\n`), `missing ${line}:\n${out}`);
  assert.ok(!/PRIORITY:5|COMPLETED:/.test(out));
  const back = fields(out);
  assert.equal(back.priority, 'LOW');
  assert.equal(back.reminder?.toISOString(), '2026-12-09T08:00:00.000Z');
});

test('render keeps the client VTODO: unknown properties, equivalent values and an unchanged object stay verbatim', () => {
  const stored = vcal(
    'UID:abc@client', 'DTSTAMP:20261101T000000Z', 'CREATED:20261101T000000Z', 'LAST-MODIFIED:20261101T000000Z', 'SUMMARY:Bericht',
    'STATUS:NEEDS-ACTION', 'PRIORITY:5', 'DUE;TZID=Europe/Berlin:20261205T170000', 'CATEGORIES:Arbeit,Q4', 'X-APPLE-SORT-ORDER:12',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT1H', 'X-WR-ALARMUID:1', 'END:VALARM',
  );
  const row = task({ uid: 'abc@client', icalData: stored, dueDate: new Date('2026-12-05T16:00:00Z'), reminder: new Date('2026-12-05T15:00:00Z') });
  assert.equal(renderVTodo(row), normalizeCalendarText(stored), 'nothing changed → the stored object exactly');

  // the webmail completes it and moves the reminder: mapped properties change, the rest stays
  const done = unfold(renderVTodo({ ...row, status: 'COMPLETED', percentComplete: 100, completedAt: new Date('2026-12-04T09:00:00Z'), reminder: new Date('2026-12-05T07:00:00Z'), updatedAt: new Date('2026-12-04T09:00:00Z') }));
  for (const line of ['STATUS:COMPLETED', 'PERCENT-COMPLETE:100', 'COMPLETED:20261204T090000Z', 'CATEGORIES:Arbeit,Q4', 'X-APPLE-SORT-ORDER:12',
    'PRIORITY:5', 'DUE;TZID=Europe/Berlin:20261205T170000', 'TRIGGER;VALUE=DATE-TIME:20261205T070000Z', 'LAST-MODIFIED:20261204T090000Z']) {
    assert.ok(done.includes(`\r\n${line}\r\n`), `missing ${line}:\n${done}`);
  }
  assert.ok(!done.includes('X-WR-ALARMUID'), 'the replaced alarm is gone');

  // removing the rule drops RRULE/EXDATE; CANCELLED survives as DEFERRED
  const cancelled = vcal('UID:c', 'SUMMARY:x', 'STATUS:CANCELLED', 'RRULE:FREQ=DAILY', 'EXDATE:20261202T000000Z');
  const out = renderVTodo(task({ uid: 'c', subject: 'x', icalData: cancelled, status: 'DEFERRED' }));
  assert.match(out, /STATUS:CANCELLED/);
  assert.doesNotMatch(out, /RRULE|EXDATE/);
});

test('render: occurrence overrides are dropped, DTSTART/DUE share one value type', () => {
  const stored = vcal('UID:a', 'SUMMARY:x', 'RRULE:FREQ=DAILY').replace('END:VCALENDAR', 'BEGIN:VTODO\r\nUID:a\r\nRECURRENCE-ID:20261201T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR');
  const out = renderVTodo(task({ uid: 'a', subject: 'x', icalData: stored, rrule: 'FREQ=DAILY' }));
  assert.equal((out.match(/BEGIN:VTODO/g) ?? []).length, 1);
  const mixed = unfold(renderVTodo(task({ startDate: new Date('2026-12-01T00:00:00Z'), dueDate: new Date('2026-12-01T15:30:00Z') })));
  assert.match(mixed, /\r\nDTSTART:20261201T000000Z\r\n/);
  assert.match(mixed, /\r\nDUE:20261201T153000Z\r\n/);
});

test('time-range on tasks (start/due span, due only, completion only, no dates)', () => {
  const s = new Date('2026-12-01T00:00:00Z');
  const e = new Date('2026-12-08T00:00:00Z');
  const t = (startDate: string | null, dueDate: string | null, completedAt: string | null = null) => ({
    startDate: startDate ? new Date(startDate) : null, dueDate: dueDate ? new Date(dueDate) : null, completedAt: completedAt ? new Date(completedAt) : null,
  });
  assert.equal(taskInRange(t('2026-11-20T00:00:00Z', '2026-12-20T00:00:00Z'), s, e), true, 'spans the range');
  assert.equal(taskInRange(t('2026-11-20T00:00:00Z', '2026-11-25T00:00:00Z'), s, e), false);
  assert.equal(taskInRange(t(null, '2026-12-08T00:00:00Z'), s, e), true, 'due at the range end');
  assert.equal(taskInRange(t(null, '2026-12-01T00:00:00Z'), s, e), false, 'due at the range start');
  assert.equal(taskInRange(t('2026-12-03T00:00:00Z', null), s, e), true);
  assert.equal(taskInRange(t(null, null, '2026-12-02T00:00:00Z'), s, e), true);
  assert.equal(taskInRange(t(null, null), s, e), true);
});
