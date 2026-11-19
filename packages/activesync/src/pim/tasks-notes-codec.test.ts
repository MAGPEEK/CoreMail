/**
 * w3: Tasks ([MS-ASTASK], code page 9) and Notes ([MS-ASNOTE], code page 23) codecs —
 * byte fixtures of server items, client items written with the [MS-ASWBXML] tokens, and the
 * Change rules (absent = cleared unless ghosted, truncated bodies, completion).
 * Run: node --import tsx --test src/pim/tasks-notes-codec.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientWbxml, type WNode } from '../test-support/fake-db.js';
import { decodeWbxml, encodeWbxml, el, tagsNewerThan, type WbxmlElement } from '../wbxml.js';
import { DEFAULT_BODY_PREFERENCE } from '../commands/body.js';
import { parseTask, renderTask, taskChange, NO_SUBJECT, type TaskRow } from './tasks-codec.js';
import { noteChange, renderNote, DEFAULT_NOTE_SUBJECT } from './notes-codec.js';
import type { PimUser, RenderContext, WriteContext } from './types.js';

const USER: PimUser = { id: 'u1', email: 'bob@example.com', displayName: 'Bob', addresses: ['bob@example.com'], timeZone: 'Europe/Berlin' };
const render = (version: '12.1' | '14.1' = '14.1'): RenderContext => ({ version, bodyPref: DEFAULT_BODY_PREFERENCE, user: USER });
const NOW = new Date('2026-11-18T12:00:00Z');
const write = (over: Partial<WriteContext> = {}): WriteContext => ({ version: '14.1', user: USER, now: NOW, supported: null, ...over });
const s = (t: string) => [0x03, ...Buffer.from(t), 0x00, 0x01];
const appData = (children: WNode[]): WbxmlElement => decodeWbxml(clientWbxml([0, 0x1d, children]));
const kid = (e: WbxmlElement | undefined, n: string) => e?.children?.find((c): c is WbxmlElement => typeof c !== 'string' && c.name === n);
const T = (t: number, k?: WNode[] | string): WNode => [9, t, k];
const B = (t: number, k?: WNode[] | string): WNode => [17, t, k];
const N = (t: number, k?: WNode[] | string): WNode => [23, t, k];

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1', subject: 'A', body: '', bodyHtml: '', status: 'NOT_STARTED', priority: 'NORMAL', startDate: null, dueDate: null,
  completedAt: null, reminder: null, isPrivate: false, rrule: null, updatedAt: NOW, ...over,
});
const BODY_EMPTY = [0x00, 0x11, 0x4a, 0x46, ...s('1'), 0x4c, ...s('0'), 0x4d, ...s('0'), 0x01];

test('byte fixture: minimal task on code page 9 (Subject 0x20, Importance 0x0E, Complete 0x0A, Sensitivity 0x1D, ReminderSet 0x1B)', () => {
  const buf = encodeWbxml(el('ApplicationData', undefined, renderTask(task(), render())));
  assert.deepEqual([...buf], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x5d, ...BODY_EMPTY,
    0x00, 0x09, 0x60, ...s('A'), 0x4e, ...s('1'), 0x4a, ...s('0'), 0x5d, ...s('0'), 0x5b, ...s('0'), 0x01,
  ]);
});

test('task → Sync item: UTC and local dates, recurrence with Start, completion, reminder; 12.1 tags only', () => {
  const t = task({
    subject: 'Bericht', priority: 'HIGH', startDate: new Date('2026-11-20T08:00:00Z'), dueDate: new Date('2026-11-27T16:00:00Z'),
    status: 'COMPLETED', completedAt: new Date('2026-11-26T10:00:00Z'), reminder: new Date('2026-11-27T07:00:00Z'), isPrivate: true,
    rrule: 'FREQ=WEEKLY;BYDAY=FR;WKST=MO',
  });
  const v14 = encodeWbxml(el('ApplicationData', undefined, renderTask(t, render())));
  const tree = decodeWbxml(v14);
  assert.deepEqual(['Importance', 'UtcStartDate', 'StartDate', 'UtcDueDate', 'DueDate', 'Complete', 'DateCompleted', 'Sensitivity', 'ReminderSet', 'ReminderTime']
    .map((n) => kid(tree, n)?.text), ['2', '2026-11-20T08:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-27T16:00:00.000Z', '2026-11-27T17:00:00.000Z',
    '1', '2026-11-26T10:00:00.000Z', '2', '1', '2026-11-27T07:00:00.000Z']);
  const rec = kid(tree, 'Recurrence')!;
  assert.deepEqual(['Type', 'Start', 'Interval', 'DayOfWeek', 'Regenerate', 'DeadOccur', 'FirstDayOfWeek'].map((n) => kid(rec, n)?.text),
    ['1', '2026-11-20T08:00:00.000Z', '1', '32', '0', '0', '1']);
  const v12 = encodeWbxml(el('ApplicationData', undefined, renderTask(t, render('12.1'))));
  assert.deepEqual(tagsNewerThan(v12, '12.1'), []);
  assert.equal(kid(kid(decodeWbxml(v12), 'Recurrence'), 'FirstDayOfWeek'), undefined, 'FirstDayOfWeek is 14.1');
});

const DEVICE_TASK: WNode[] = [
  B(0x0a, [B(0x06, '1'), B(0x0b, 'Milch kaufen')]), T(0x20, 'Einkauf'), T(0x0e, '2'),
  T(0x1f, '2026-11-20T08:00:00.000Z'), T(0x1e, '2026-11-20T09:00:00.000Z'), T(0x0d, '2026-11-22T17:00:00.000Z'), T(0x0c, '2026-11-22T18:00:00.000Z'),
  T(0x0a, '0'), T(0x1d, '2'), T(0x1b, '1'), T(0x1c, '2026-11-22T08:00:00.000Z'),
  T(0x0f, [T(0x10, '1'), T(0x11, '2026-11-20T08:00:00.000Z'), T(0x14, '1'), T(0x16, '32')]),
];

test('device task Add → task columns (UTC dates win, Importance, Sensitivity, reminder, rule)', () => {
  const { columns, patch } = taskChange(parseTask(appData(DEVICE_TASK)), null, write());
  assert.deepEqual(columns, {
    subject: 'Einkauf', body: 'Milch kaufen', bodyHtml: '', priority: 'HIGH',
    startDate: new Date('2026-11-20T08:00:00Z'), dueDate: new Date('2026-11-22T17:00:00Z'),
    reminder: new Date('2026-11-22T08:00:00Z'), isPrivate: true, rrule: 'FREQ=WEEKLY;BYDAY=FR',
  });
  assert.deepEqual(patch, {});
  assert.equal(taskChange(parseTask(appData([T(0x0a, '0')])), null, write()).columns.subject, NO_SUBJECT);
});

test('device task Change: completion and reopening go through the progress rules', () => {
  const done = taskChange(parseTask(appData([T(0x20, 'x'), T(0x0a, '1'), T(0x0b, '2026-11-18T09:00:00.000Z')])), task(), write({ supported: new Set(['Subject', 'Complete']) }));
  assert.deepEqual(done.patch, { status: 'COMPLETED', completedAt: new Date('2026-11-18T09:00:00Z') });
  const reopened = taskChange(parseTask(appData([T(0x20, 'x'), T(0x0a, '0')])), task({ status: 'COMPLETED', completedAt: NOW }), write({ supported: new Set(['Subject', 'Complete']) }));
  assert.deepEqual(reopened.patch, { completedAt: null });
  const open = taskChange(parseTask(appData([T(0x20, 'x'), T(0x0a, '0')])), task({ status: 'IN_PROGRESS' }), write({ supported: new Set(['Subject', 'Complete']) }));
  assert.deepEqual(open.patch, {}, 'an open task stays in progress');
});

test('device task Change: absent elements cleared, ghosted ones kept; same text keeps the rich-text note; truncated echo ignored', () => {
  const stored = task({
    body: 'Lang '.repeat(20), bodyHtml: '<p>Lang</p>', priority: 'HIGH', startDate: NOW, dueDate: NOW, reminder: NOW, isPrivate: true, rrule: 'FREQ=DAILY',
  });
  const cleared = taskChange(parseTask(appData([T(0x20, 'A'), T(0x0a, '0')])), stored, write());
  assert.deepEqual(cleared.columns, {
    subject: 'A', body: '', bodyHtml: '', priority: 'NORMAL', startDate: null, dueDate: null, reminder: null, isPrivate: false, rrule: null,
  });
  const ghosted = taskChange(parseTask(appData([T(0x20, 'A'), T(0x0a, '0')])), stored, write({ supported: new Set(['Subject', 'Complete']) }));
  assert.deepEqual(ghosted.columns, { subject: 'A' });
  const same = taskChange(parseTask(appData([T(0x20, 'A'), B(0x0a, [B(0x06, '1'), B(0x0b, stored.body)])])), stored, write({ supported: new Set(['Subject', 'Body']) }));
  assert.deepEqual(same.columns, { subject: 'A' }, 'unchanged text → bodyHtml stays');
  const truncated = taskChange(parseTask(appData([T(0x20, 'A'), B(0x0a, [B(0x06, '1'), B(0x0b, stored.body.slice(0, 30))])])), stored,
    write({ supported: new Set(['Subject', 'Body']), truncatedAt: 30 }));
  assert.deepEqual(truncated.columns, { subject: 'A' }, 'the truncated copy the device got is not a change');
  const html = taskChange(parseTask(appData([T(0x20, 'A'), B(0x0a, [B(0x06, '2'), B(0x0b, '<p>Neu &amp; mehr</p>')])])), stored, write({ supported: new Set(['Subject', 'Body']) }));
  assert.deepEqual(html.columns, { subject: 'A', body: 'Neu & mehr', bodyHtml: '<p>Neu &amp; mehr</p>' });
});

test('byte fixture: note on code page 23 (Subject 0x05, MessageClass 0x06, LastModifiedDate 0x07)', () => {
  const buf = encodeWbxml(el('ApplicationData', undefined, renderNote({ id: 'n1', subject: 'Idee', body: '', categories: [], updatedAt: new Date('2026-11-18T10:00:00Z') }, render())));
  assert.deepEqual([...buf], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x5d, 0x00, 0x17, 0x45, ...s('Idee'), ...BODY_EMPTY,
    0x00, 0x17, 0x46, ...s('IPM.StickyNote'), 0x47, ...s('2026-11-18T10:00:00.000Z'), 0x01,
  ]);
  assert.deepEqual(tagsNewerThan(buf, '12.1').map((x) => x.name), ['Subject', 'MessageClass', 'LastModifiedDate'], 'Notes is a 14.0 class');
  // 9.5: note categories as notes:Categories / Category (0x08 / 0x09)
  const tagged = encodeWbxml(el('ApplicationData', undefined, renderNote({ id: 'n1', subject: 'Idee', body: '', categories: ['Privat'], updatedAt: new Date('2026-11-18T10:00:00Z') }, render())));
  assert.deepEqual([...tagged], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x5d, 0x00, 0x17, 0x45, ...s('Idee'), ...BODY_EMPTY,
    0x00, 0x17, 0x48, 0x49, ...s('Privat'), 0x01, 0x46, ...s('IPM.StickyNote'), 0x47, ...s('2026-11-18T10:00:00.000Z'), 0x01,
  ]);
});

test('device note Add / Change: subject default, HTML body as text, absent body cleared unless ghosted', () => {
  assert.deepEqual(noteChange(appData([N(0x05, 'Liste'), B(0x0a, [B(0x06, '2'), B(0x0b, '<div>Brot<br>Käse</div>')]), N(0x06, 'IPM.StickyNote')]), null, write()),
    { subject: 'Liste', body: 'Brot\nKäse', categories: [] });
  assert.deepEqual(noteChange(appData([B(0x0a, [B(0x06, '1'), B(0x0b, 'x')])]), null, write()), { subject: DEFAULT_NOTE_SUBJECT, body: 'x', categories: [] });
  assert.deepEqual(noteChange(appData([N(0x05, 'Liste')]), { body: 'alt' }, write()), { subject: 'Liste', body: '', categories: [] });
  assert.deepEqual(noteChange(appData([N(0x05, 'Liste')]), { body: 'alt' }, write({ supported: new Set(['Subject']) })), { subject: 'Liste' });
  // 9.5: categories trimmed, unique (case-insensitive), capped like the REST API
  const cats = noteChange(appData([N(0x05, 'Liste'), N(0x08, [N(0x09, ' Privat '), N(0x09, 'privat'), N(0x09, 'x'.repeat(80)), N(0x09, '')])]), { body: 'alt' }, write({ supported: new Set(['Subject', 'Categories']) }));
  assert.deepEqual(cats, { subject: 'Liste', categories: ['Privat', 'x'.repeat(60)] });
});
