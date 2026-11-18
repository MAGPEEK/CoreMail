/**
 * 9.4: task status transitions and recurring tasks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskProgress, nextTaskOccurrence, normTaskStatus, type TaskProgress } from './task-rules.js';

const now = new Date('2026-03-02T10:00:00Z');
const done = new Date('2026-03-01T08:00:00Z');
const p = (status: TaskProgress['status'], percentComplete: number, completedAt: Date | null = null): TaskProgress => ({ status, percentComplete, completedAt });

test('applyTaskProgress: status / percent / completion transitions', () => {
  const table: Array<[string, TaskProgress, Parameters<typeof applyTaskProgress>[1], TaskProgress]> = [
    ['complete via status', p('IN_PROGRESS', 40), { status: 'COMPLETED' }, p('COMPLETED', 100, now)],
    ['complete via 100 %', p('NOT_STARTED', 0), { percentComplete: 100 }, p('COMPLETED', 100, now)],
    ['complete via completion date', p('WAITING', 10), { completedAt: done }, p('COMPLETED', 100, done)],
    ['completed stays with its date', p('COMPLETED', 100, done), { status: 'COMPLETED' }, p('COMPLETED', 100, done)],
    ['percent starts the task', p('NOT_STARTED', 0), { percentComplete: 50 }, p('IN_PROGRESS', 50)],
    ['0 % resets an in-progress task', p('IN_PROGRESS', 30), { percentComplete: 0 }, p('NOT_STARTED', 0)],
    ['not started means 0 %', p('IN_PROGRESS', 60), { status: 'NOT_STARTED' }, p('NOT_STARTED', 0)],
    ['waiting keeps the percentage', p('IN_PROGRESS', 60), { status: 'WAITING' }, p('WAITING', 60)],
    ['deferred keeps 0 %', p('WAITING', 0), { percentComplete: 0 }, p('WAITING', 0)],
    ['reopen via null completion', p('COMPLETED', 100, done), { completedAt: null }, p('NOT_STARTED', 0)],
    ['reopen into progress', p('COMPLETED', 100, done), { status: 'IN_PROGRESS' }, p('IN_PROGRESS', 0)],
    ['reopen with a percentage', p('COMPLETED', 100, done), { percentComplete: 40 }, p('IN_PROGRESS', 40)],
    ['percent is clamped', p('IN_PROGRESS', 10), { percentComplete: 140, status: 'IN_PROGRESS' }, p('IN_PROGRESS', 99)],
  ];
  for (const [name, current, patch, expected] of table) assert.deepEqual(applyTaskProgress(current, patch, now), expected, name);
});

test('normTaskStatus: unknown values fall back to NOT_STARTED', () => {
  assert.equal(normTaskStatus('WAITING'), 'WAITING');
  assert.equal(normTaskStatus('bogus'), 'NOT_STARTED');
  assert.equal(normTaskStatus(null), 'NOT_STARTED');
});

test('nextTaskOccurrence: next due date, start/reminder keep their distance, COUNT counts down', () => {
  const next = nextTaskOccurrence({
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    dueDate: new Date('2026-03-02T00:00:00Z'),
    startDate: new Date('2026-02-27T00:00:00Z'),
    reminder: new Date('2026-03-02T07:00:00Z'),
  })!;
  assert.equal(next.dueDate!.toISOString(), '2026-03-09T00:00:00.000Z');
  assert.equal(next.startDate!.toISOString(), '2026-03-06T00:00:00.000Z');
  assert.equal(next.reminder!.toISOString(), '2026-03-09T07:00:00.000Z');
  assert.equal(next.rrule, 'FREQ=WEEKLY;BYDAY=MO;COUNT=2');
  assert.equal(nextTaskOccurrence({ ...next, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=1' }), null);
});

test('nextTaskOccurrence: monthly by day, until reached, no dates', () => {
  const monthly = nextTaskOccurrence({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=31', dueDate: new Date('2026-01-31T00:00:00Z'), startDate: null, reminder: null })!;
  assert.equal(monthly.dueDate!.toISOString(), '2026-03-31T00:00:00.000Z'); // February has no 31st
  assert.equal(nextTaskOccurrence({ rrule: 'FREQ=DAILY;UNTIL=20260302T000000Z', dueDate: new Date('2026-03-02T00:00:00Z'), startDate: null, reminder: null }), null);
  assert.equal(nextTaskOccurrence({ rrule: 'FREQ=DAILY', dueDate: null, startDate: null, reminder: null }), null);
});
