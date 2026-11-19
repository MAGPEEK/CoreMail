/**
 * The one task writer (task-store.ts) shared by REST, CalDAV and ActiveSync: status rules,
 * the next task of a completed recurring task exactly once, no revived rule on a completed
 * occurrence.
 * Run: node --import tsx --test src/task-store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

type Row = Record<string, unknown>;
const tasks: Row[] = [];
let seq = 0;
const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) =>
  (v && typeof v === 'object' && 'not' in (v as Row) ? row[k] !== (v as Row)['not'] : row[k] === v));
const taskModel = {
  create: async (a: { data: Row }) => {
    const row: Row = { id: `t${++seq}`, rrule: null, dueDate: null, startDate: null, reminder: null, completedAt: null, icalData: null, ...a.data };
    tasks.push(row);
    return { ...row };
  },
  update: async (a: { where: { id: string }; data: Row }) => {
    const row = tasks.find((t) => t['id'] === a.where.id)!;
    Object.assign(row, a.data);
    return { ...row };
  },
  updateMany: async (a: { where: Row; data: Row }) => {
    const rows = tasks.filter((t) => matches(t, a.where));
    for (const r of rows) Object.assign(r, a.data);
    return { count: rows.length };
  },
  findFirst: async (a: { where: Row }) => { const r = tasks.find((t) => matches(t, a.where)); return r ? { ...r } : null; },
};
const db = { $on: () => undefined, task: taskModel, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) };
(globalThis as Record<string, unknown>)['__prisma'] = db;

const { createTaskWithRules, updateTaskWithRules } = await import('./task-store.js');
type Task = Awaited<ReturnType<typeof createTaskWithRules>>;

const now = new Date('2026-11-18T10:00:00Z');
const stored = (id: string): Task => ({ ...tasks.find((t) => t['id'] === id)! }) as Task;

test('completing a recurring task: the occurrence keeps no rule, the next task is created exactly once', async () => {
  const task = await createTaskWithRules('u1', 'Weekly report', { rrule: 'FREQ=WEEKLY', dueDate: new Date('2026-11-20T00:00:00Z') }, {}, now);
  const first = await updateTaskWithRules(stored(task.id), {}, { status: 'COMPLETED' }, now);
  assert.equal(first.updated?.['status'], 'COMPLETED');
  assert.equal(first.updated?.['rrule'], null);
  assert.equal(first.created?.['rrule'], 'FREQ=WEEKLY');
  assert.equal((first.created?.['dueDate'] as Date).toISOString(), '2026-11-27T00:00:00.000Z');
  // a repeated completion (stale copy of the open task: a retry, a second client) creates nothing
  const again = await updateTaskWithRules(task, {}, { status: 'COMPLETED' }, now);
  assert.equal(again.created, null);
  assert.equal(tasks.filter((t) => t['subject'] === 'Weekly report').length, 2);
});

test('w3 review: a completed task sent again with its rule does not revive the series (REST, CalDAV, ActiveSync)', async () => {
  const task = await createTaskWithRules('u1', 'Daily check', { rrule: 'FREQ=DAILY', dueDate: new Date('2026-11-19T00:00:00Z') }, {}, now);
  const { created } = await updateTaskWithRules(stored(task.id), {}, { status: 'COMPLETED' }, now);
  assert.ok(created);
  // the device / client still has the occurrence with its rule and sends it completed again
  const resent = await updateTaskWithRules(stored(task.id), { rrule: 'FREQ=DAILY', subject: 'Daily check!' }, { status: 'COMPLETED' }, now);
  assert.equal(resent.updated?.['rrule'], null);
  assert.equal(resent.updated?.['subject'], 'Daily check!');
  assert.equal(resent.created, null);
  // reopening it with its rule is the client's explicit choice
  const reopened = await updateTaskWithRules(stored(task.id), { rrule: 'FREQ=DAILY' }, { status: 'IN_PROGRESS' }, now);
  assert.equal(reopened.updated?.['rrule'], 'FREQ=DAILY');
  assert.equal(reopened.updated?.['completedAt'], null);
});

test('status rules: a new task starts as not started; % complete follows completion', async () => {
  const task = await createTaskWithRules('u1', 'Plain', {}, {}, now);
  assert.deepEqual([task['status'], task['percentComplete'], task['completedAt']], ['NOT_STARTED', 0, null]);
  const { updated } = await updateTaskWithRules(stored(task.id), {}, { status: 'COMPLETED' }, now);
  assert.deepEqual([updated?.['status'], updated?.['percentComplete'], (updated?.['completedAt'] as Date).toISOString()], ['COMPLETED', 100, now.toISOString()]);
});
