/**
 * w3: Calendar, Tasks and Notes over ActiveSync against the in-memory Prisma fake —
 * FolderSync announcement (own calendars only, webmail module policies, Notes from 14.0),
 * Sync with the per-device item state (priming, Add / Change / Delete both ways, ClientId →
 * ServerId, retries, no echo, normalised items), GetItemEstimate, MoveItems (inside the class
 * only), ItemOperations Fetch, Ping (item changes, hierarchy changes) and MeetingResponse
 * feeding the calendar sync.
 * Run: node --import tsx --test src/pim/pim-sync.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildVCalendar } from '@coremail/core/calendar';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const ical = (uid: string, summary: string, start: string, end: string, rrule?: string) =>
  buildVCalendar({ uid, summary, start: new Date(start), end: new Date(end), ...(rrule ? { rrule } : {}) });
const event = (id: string, calendarId: string, summary: string, start: string, rrule?: string) => ({
  id, calendarId, uid: `${id}@test`, icalData: ical(`${id}@test`, summary, start, new Date(new Date(start).getTime() + 3_600_000).toISOString(), rrule),
  summary, description: '', location: '', dtStart: new Date(start), dtEnd: new Date(new Date(start).getTime() + 3_600_000), allDay: false,
  recurring: !!rrule, rrule: rrule ?? null, organizer: null, attendees: [], classification: 'PUBLIC', showAs: 'BUSY', status: 'CONFIRMED',
  sequence: 0, updatedAt: new Date('2026-11-01T00:00:00Z'),
});

const db = installFakeDb({
  user: [
    { id: 'u1', email: 'bob@example.com', displayName: 'Bob B', domainId: 'dom1', active: true },
    { id: 'u2', email: 'carol@example.com', displayName: 'Carol', domainId: 'dom1', active: true },
  ],
  emailAlias: [],
  userSettings: [{ userId: 'u1', preferences: { regional: { timeZone: 'Europe/Berlin' } } }],
  webmailPolicy: [],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 5n }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Posteingang', parentId: null },
    { id: 'trash', mailboxId: 'mb1', name: 'Trash', displayName: 'Gelöschte Elemente', parentId: null },
  ],
  message: [],
  calendar: [
    { id: 'calA', userId: 'u1', name: 'Kalender', isDefault: true, sortOrder: 0, createdAt: new Date(1) },
    { id: 'calB', userId: 'u1', name: 'Projekte', isDefault: false, sortOrder: 1, createdAt: new Date(2) },
    { id: 'calX', userId: 'u2', name: 'Carols Kalender', isDefault: true, sortOrder: 0, createdAt: new Date(3) },
  ],
  calendarEvent: [
    event('ev1', 'calA', 'Zahnarzt', '2026-11-20T08:00:00Z'),
    event('ev2', 'calA', 'Jour fixe', '2026-11-02T09:00:00Z', 'FREQ=WEEKLY;BYDAY=MO'),
    event('evOld', 'calA', 'Alt', '2025-01-10T09:00:00Z'),
    event('evX', 'calX', 'Fremd', '2026-11-20T08:00:00Z'),
  ],
  task: [{ id: 't1', userId: 'u1', subject: 'Steuer', body: '', bodyHtml: '', status: 'NOT_STARTED', priority: 'NORMAL', percentComplete: 0,
    startDate: null, dueDate: new Date('2026-11-30T16:00:00Z'), completedAt: null, reminder: null, isPrivate: false, rrule: null, updatedAt: new Date('2026-11-01T00:00:00Z') }],
  note: [{ id: 'n1', userId: 'u1', subject: 'Idee', body: 'Text', color: 'YELLOW', categories: ['Privat'], updatedAt: new Date('2026-11-01T00:00:00Z') }],
  activeSyncDevice: [
    { id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', protocolVersion: '14.1', syncKeys: {} },
    { id: 'd12', userId: 'u1', deviceId: 'dev12', status: 'OK', policyKey: '42', protocolVersion: '12.1', syncKeys: {} },
  ],
  activeSyncItem: [],
});

const { handleSync } = await import('../commands/sync.js');
const { handleFolderSync } = await import('../commands/folder-sync.js');
const { handleGetItemEstimate } = await import('../commands/get-item-estimate.js');
const { handleMoveItems } = await import('../commands/move-items.js');
const { handleItemOperations, prismaItemOperationsDeps } = await import('../commands/item-operations.js');
const { handlePing } = await import('../commands/ping.js');
const { handleMeetingResponse } = await import('../commands/meeting-response.js');
const { decodeWbxml, tagsNewerThan } = await import('../wbxml.js');
const { invalidateWebmailPolicyCache } = await import('@coremail/storage');
type E = import('../wbxml.js').WbxmlElement;
type V = '12.1' | '14.0' | '14.1';
type Model = { create(a: unknown): Promise<Record<string, unknown>>; update(a: unknown): Promise<Record<string, unknown>>; delete(a: unknown): Promise<unknown> };
const model = (name: string) => (db as unknown as Record<string, Model>)[name]!;

const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
const C = (t: number, k?: WNode[] | string): WNode => [4, t, k];
const T = (t: number, k?: WNode[] | string): WNode => [9, t, k];
const B = (t: number, k?: WNode[] | string): WNode => [17, t, k];
const kid = (e: E | undefined, n: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === n);
const kids = (e: E | undefined, n: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === n);
const rows = (table: string) => db.tables[table]!;
const row = (table: string, id: string) => rows(table).find((r) => r['id'] === id)!;

interface SyncOpts { dev?: string; version?: V; commands?: WNode[]; extra?: WNode[] }
async function sync(collectionId: string, key: string, o: SyncOpts = {}) {
  const version = o.version ?? '14.1';
  const col: WNode[] = [A(0x0b, key), A(0x12, collectionId), ...(o.extra ?? []), ...(o.commands?.length ? [A(0x16, o.commands)] : [])];
  const buf = await handleSync(decodeWbxml(clientWbxml(A(0x05, [A(0x1c, [A(0x0f, col)])]))), 'u1', o.dev ?? 'dev1', { now: () => NOW }, version);
  assert.deepEqual(tagsNewerThan(buf, version), [], `tags newer than ${version}`);
  const c = kid(kid(decodeWbxml(buf), 'Collections'), 'Collection')!;
  const cmds = kid(c, 'Commands');
  const ids = (n: string) => kids(cmds, n).map((x) => kid(x, 'ServerId')!.text!);
  return {
    cls: kid(c, 'Class')?.text, key: kid(c, 'SyncKey')!.text!, status: kid(c, 'Status')!.text!,
    adds: ids('Add'), changes: ids('Change'), deletes: ids('Delete'), more: !!kid(c, 'MoreAvailable'),
    data: (id: string) => kid([...kids(cmds, 'Add'), ...kids(cmds, 'Change')].find((x) => kid(x, 'ServerId')!.text === id), 'ApplicationData'),
    responses: kids(kid(c, 'Responses'), 'Add').concat(kids(kid(c, 'Responses'), 'Change'), kids(kid(c, 'Responses'), 'Delete')),
  };
}
async function folderSync(key: string, dev = 'dev1', version: V = '14.1') {
  const t = decodeWbxml(await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, key]]])), 'u1', dev, version));
  const ch = kid(t, 'Changes');
  return {
    status: kid(t, 'Status')!.text, key: kid(t, 'SyncKey')?.text ?? '',
    add: kids(ch, 'Add').map((a) => `${kid(a, 'ServerId')!.text}=${kid(a, 'DisplayName')!.text}/${kid(a, 'Type')!.text}`),
    del: kids(ch, 'Delete').map((a) => kid(a, 'ServerId')!.text),
  };
}
async function setPolicy(feature: string | null) {
  db.tables['webmailPolicy'] = feature ? [{ id: 'p1', domainId: 'dom1', userId: null, [feature]: 'OFF' }] : [];
  invalidateWebmailPolicyCache();
}

let folderKey = '';
test('FolderSync: own calendars (default 8, others 13), tasks 7, notes 10 — nothing of other users; 12.1 without notes', async () => {
  const fs = await folderSync('0');
  assert.equal(fs.status, '1');
  assert.deepEqual(fs.add.filter((a) => a.includes(':')), ['cal:calA=Kalender/8', 'cal:calB=Projekte/13', 'tasks:default=Aufgaben/7', 'notes:default=Notizen/10', 'contacts:default=Kontakte/9']);
  folderKey = fs.key;
  const old = await folderSync('0', 'dev12', '12.1');
  assert.deepEqual(old.add.filter((a) => a.includes(':')), ['cal:calA=Kalender/8', 'cal:calB=Projekte/13', 'tasks:default=Aufgaben/7', 'contacts:default=Kontakte/9']);
});

let calKey = '';
test('calendar Sync: priming, Adds inside the FilterType window (series always), a lost response is resent', async () => {
  const p = await sync('cal:calA', '0', { extra: [A(0x17, [A(0x18, '5'), B(0x05, [B(0x06, '1'), B(0x07, '20000')])])] });
  assert.deepEqual([p.cls, p.key, p.status, p.adds], ['Calendar', '1', '1', []]);
  const first = await sync('cal:calA', '1');
  assert.deepEqual([first.key, first.adds.sort()], ['2', ['ev1', 'ev2']], 'evOld lies before the one-month window');
  assert.equal(kid(first.data('ev1'), 'Subject')?.text, 'Zahnarzt');
  assert.equal(kid(kid(first.data('ev2'), 'Recurrence'), 'DayOfWeek')?.text, '2');
  const retry = await sync('cal:calA', '1');
  assert.deepEqual([retry.key, retry.adds.sort()], ['2', ['ev1', 'ev2']]);
  const quiet = await sync('cal:calA', '2');
  assert.deepEqual([quiet.key, quiet.adds, quiet.changes, quiet.deletes], ['3', [], [], []]);
  calKey = quiet.key;
  assert.equal((await sync('cal:calA', '99')).status, '3', 'unknown key');
  assert.equal((await sync('cal:calX', '0')).status, '8', 'another user\'s calendar');
});

test('server-side changes reach the device: Change (complete item) and Delete', async () => {
  await model('calendarEvent').update({ where: { id: 'ev1' }, data: { summary: 'Zahnarzt (neu)', icalData: ical('ev1@test', 'Zahnarzt (neu)', '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z') } });
  await model('calendarEvent').delete({ where: { id: 'ev2' } });
  const r = await sync('cal:calA', calKey);
  assert.deepEqual([r.changes, r.deletes], [['ev1'], ['ev2']]);
  assert.deepEqual(['Subject', 'StartTime', 'UID'].map((n) => kid(r.data('ev1'), n)?.text), ['Zahnarzt (neu)', '20261120T090000Z', 'ev1@test']);
  calKey = (await sync('cal:calA', r.key)).key;
});

let added = '';
test('device Add: ClientId → ServerId, stored through the writer, no echo; a retried Add creates nothing twice', async () => {
  const addCmd = A(0x07, [A(0x0c, 'client-1'), A(0x1d, [
    C(0x06, '0'), C(0x26, 'Mittag mit Carol'), C(0x27, '20261121T110000Z'), C(0x12, '20261121T120000Z'),
    C(0x0d, '1'), C(0x24, '30'), C(0x07, [C(0x08, [C(0x09, 'carol@example.com'), C(0x0a, 'Carol'), C(0x2a, '1')])]),
  ])]);
  const r = await sync('cal:calA', calKey, { commands: [addCmd] });
  const resp = r.responses[0]!;
  added = kid(resp, 'ServerId')!.text!;
  assert.deepEqual([kid(resp, 'ClientId')?.text, kid(resp, 'Status')?.text], ['client-1', '1']);
  const ev = row('calendarEvent', added);
  assert.deepEqual([ev['calendarId'], ev['summary'], ev['showAs'], ev['organizer']], ['calA', 'Mittag mit Carol', 'TENTATIVE', 'bob@example.com']);
  assert.deepEqual(r.adds, [], 'not echoed');
  const count = rows('calendarEvent').length;
  // the response got lost: the device repeats the request with the same key and ClientId
  const again = await sync('cal:calA', calKey, { commands: [addCmd] });
  assert.equal(kid(again.responses[0], 'ServerId')?.text, added);
  assert.equal(rows('calendarEvent').length, count, 'no duplicate');
  calKey = (await sync('cal:calA', again.key)).key;
});

test('device Change and Delete: written, not echoed; unknown item → Status 8 in Responses', async () => {
  const change = A(0x08, [A(0x0d, added), A(0x1d, [C(0x06, '0'), C(0x26, 'Mittag (verschoben)'), C(0x27, '20261121T120000Z'), C(0x12, '20261121T130000Z')])]);
  const r = await sync('cal:calA', calKey, { commands: [change, A(0x08, [A(0x0d, 'nope'), A(0x1d, [C(0x26, 'x')])])] });
  assert.equal(row('calendarEvent', added)['summary'], 'Mittag (verschoben)');
  assert.deepEqual([r.changes, r.responses.map((x) => `${kid(x, 'ServerId')?.text}:${kid(x, 'Status')?.text}`)], [[], ['nope:8']]);
  const d = await sync('cal:calA', r.key, { commands: [A(0x09, [A(0x0d, added)])] });
  assert.equal(rows('calendarEvent').some((e) => e['id'] === added), false);
  assert.deepEqual(d.deletes, []);
  calKey = (await sync('cal:calA', d.key)).key;
});

test('GetItemEstimate: what the next Sync would send (issued vs acknowledged key, not primed)', async () => {
  const gie = async (col: string, key: string) => {
    const req = [6, 0x05, [[6, 0x07, [[6, 0x08, [[0, 0x0b, key], [6, 0x0a, col]]]]]]] as WNode;
    const t = decodeWbxml(await handleGetItemEstimate(decodeWbxml(clientWbxml(req)), 'u1', 'dev1', () => NOW, '14.1'));
    const resp = kid(t, 'Response')!;
    return `${kid(resp, 'Status')?.text}:${kid(kid(resp, 'Collection'), 'Estimate')?.text ?? '-'}`;
  };
  assert.equal(await gie('cal:calA', calKey), '1:0');
  await model('calendarEvent').create({ data: { ...event('ev3', 'calA', 'Neu', '2026-11-25T10:00:00Z') } });
  assert.equal(await gie('cal:calA', calKey), '1:1');
  assert.equal(await gie('cal:calA', '0'), '3:-');
  assert.equal(await gie('cal:calA', '12345'), '4:-');
  assert.equal(await gie('cal:calX', '1'), '2:-');
});

test('MoveItems: an event into the other own calendar keeps its ServerId; across classes / into mail → Status 2', async () => {
  const move = async (id: string, src: string, dst: string) => {
    const req = [5, 0x05, [[5, 0x06, [[5, 0x07, id], [5, 0x08, src], [5, 0x09, dst]]]]] as WNode;
    const r = kid(decodeWbxml(await handleMoveItems(decodeWbxml(clientWbxml(req)), 'u1', 'dev1', '14.1')), 'Response')!;
    return `${kid(r, 'Status')?.text}:${kid(r, 'DstMsgId')?.text ?? ''}`;
  };
  const sync1 = await sync('cal:calA', calKey);
  assert.deepEqual(sync1.adds, ['ev3']);
  calKey = (await sync('cal:calA', sync1.key)).key;
  const primedB = await sync('cal:calB', '0');
  const keyB = (await sync('cal:calB', primedB.key)).key;
  assert.equal(await move('ev3', 'cal:calA', 'tasks:default'), '2:');
  assert.equal(await move('ev3', 'cal:calA', 'inbox'), '2:');
  assert.equal(await move('ev3', 'cal:calA', 'cal:calX'), '2:', 'not an own calendar');
  assert.equal(await move('nope', 'cal:calA', 'cal:calB'), '1:');
  assert.equal(await move('ev3', 'cal:calA', 'cal:calB'), '3:ev3');
  assert.equal(row('calendarEvent', 'ev3')['calendarId'], 'calB');
  const src = await sync('cal:calA', calKey);
  assert.deepEqual(src.deletes, [], 'the device moved it itself');
  calKey = src.key;
  const dst = await sync('cal:calB', keyB);
  assert.deepEqual(dst.adds, [], 'already held in the destination');
});

test('ItemOperations Fetch of a calendar item and of a task; foreign / unknown → Status 6', async () => {
  const fetch = async (col: string, id: string) => {
    const req = [20, 0x05, [[20, 0x06, [[20, 0x07, 'Mailbox'], [0, 0x12, col], [0, 0x0d, id]]]]] as WNode;
    const f = kid(kid(decodeWbxml(await handleItemOperations(decodeWbxml(clientWbxml(req)), 'u1', prismaItemOperationsDeps(), '14.1')), 'Response'), 'Fetch')!;
    return { status: kid(f, 'Status')?.text, cls: kid(f, 'Class')?.text, props: kid(f, 'Properties') };
  };
  const ev = await fetch('cal:calA', 'ev1');
  assert.deepEqual([ev.status, ev.cls, kid(ev.props, 'Subject')?.text], ['1', 'Calendar', 'Zahnarzt (neu)']);
  const t = await fetch('tasks:default', 't1');
  assert.deepEqual([t.status, t.cls, kid(t.props, 'Subject')?.text], ['1', 'Tasks', 'Steuer']);
  assert.equal((await fetch('cal:calX', 'evX')).status, '6');
  assert.equal((await fetch('cal:calA', 'evX')).status, '6');
});

test('tasks: Sync Add of the REST task; device Add of a task is a task row; completing a recurring task brings the next one', async () => {
  const p = await sync('tasks:default', '0');
  const first = await sync('tasks:default', p.key);
  assert.deepEqual([first.cls, first.adds], ['Tasks', ['t1']]);
  assert.equal(kid(first.data('t1'), 'UtcDueDate')?.text, '2026-11-30T16:00:00.000Z');
  const taskData = (complete: WNode[]) => [
    T(0x20, 'Blumen giessen'), T(0x0e, '1'), T(0x1f, '2026-11-20T07:00:00.000Z'), T(0x1e, '2026-11-20T08:00:00.000Z'),
    T(0x0d, '2026-11-20T07:00:00.000Z'), T(0x0c, '2026-11-20T08:00:00.000Z'), ...complete,
    T(0x0f, [T(0x10, '1'), T(0x11, '2026-11-20T07:00:00.000Z'), T(0x14, '1'), T(0x16, '32')]),
  ];
  const addTask = A(0x07, [A(0x0c, 'ct-1'), A(0x1d, taskData([T(0x0a, '0')]))]);
  const r = await sync('tasks:default', first.key, { commands: [addTask] });
  const id = kid(r.responses[0], 'ServerId')!.text!;
  assert.deepEqual([row('task', id)['subject'], row('task', id)['rrule'], row('task', id)['status']], ['Blumen giessen', 'FREQ=WEEKLY;BYDAY=FR', 'NOT_STARTED']);
  const after = await sync('tasks:default', r.key);
  assert.deepEqual([after.adds, after.changes], [[], []]);
  const done = await sync('tasks:default', after.key, { commands: [A(0x08, [A(0x0d, id),
    A(0x1d, taskData([T(0x0a, '1'), T(0x0b, '2026-11-20T09:00:00.000Z')]))])] });
  assert.equal(row('task', id)['status'], 'COMPLETED');
  const next = rows('task').find((t) => t['subject'] === 'Blumen giessen' && t['id'] !== id)!;
  assert.deepEqual([next['status'], next['rrule'], (next['dueDate'] as Date).toISOString()], ['NOT_STARTED', 'FREQ=WEEKLY;BYDAY=FR', '2026-11-27T07:00:00.000Z']);
  assert.deepEqual([done.adds, done.changes.sort()].flat().sort(), [id, next['id']].sort(), 'next one added, the completed one (rule moved on) changed');
  assert.equal(kid(done.data(id), 'Recurrence'), undefined);
  await sync('tasks:default', done.key);
  // FilterType 8: incomplete tasks only; another FilterType later asks for a resync (Status 3)
  const p8 = await sync('tasks:default', '0', { extra: [A(0x17, [A(0x18, '8')])] });
  const open = await sync('tasks:default', p8.key);
  assert.deepEqual(open.adds.sort(), ['t1', next['id']].sort());
  assert.equal((await sync('tasks:default', open.key, { extra: [A(0x17, [A(0x18, '0')])] })).status, '3');
});

test('notes: 14.1 Sync Add / device Add; 12.1 has no Notes class (Status 12, hierarchy changed)', async () => {
  const p = await sync('notes:default', '0');
  const first = await sync('notes:default', p.key);
  assert.deepEqual([first.cls, first.adds], ['Notes', ['n1']]);
  assert.equal(kid(first.data('n1'), 'MessageClass')?.text, 'IPM.StickyNote');
  assert.equal(kid(kid(first.data('n1'), 'Categories'), 'Category')?.text, 'Privat', '9.5 note categories');
  const r = await sync('notes:default', first.key, { commands: [A(0x07, [A(0x0c, 'cn'), A(0x1d, [[23, 0x05, 'Einkauf'], B(0x0a, [B(0x06, '1'), B(0x0b, 'Brot')])])])] });
  const id = kid(r.responses[0], 'ServerId')!.text!;
  assert.deepEqual([row('note', id)['subject'], row('note', id)['body']], ['Einkauf', 'Brot']);
  assert.equal((await sync('notes:default', '0', { dev: 'dev12', version: '12.1' })).status, '12');
});

test('12.1 device: calendar and tasks Sync with 12.1 tags only (no ResponseType, no FirstDayOfWeek)', async () => {
  for (const col of ['cal:calA', 'tasks:default']) {
    const p = await sync(col, '0', { dev: 'dev12', version: '12.1' });
    const r = await sync(col, p.key, { dev: 'dev12', version: '12.1' });
    assert.ok(r.adds.length > 0, col);
  }
});

test('webmail policy: calendar module off → no calendar folders, Sync Status 12, Ping Status 7; back on → announced again', async () => {
  await setPolicy('calendar');
  try {
    const fs = await folderSync(folderKey);
    assert.deepEqual(fs.del.sort(), ['cal:calA', 'cal:calB']);
    folderKey = fs.key;
    assert.equal((await sync('cal:calA', calKey)).status, '12');
  } finally {
    await setPolicy(null);
  }
  const back = await folderSync(folderKey);
  assert.deepEqual(back.add.sort(), ['cal:calA=Kalender/8', 'cal:calB=Projekte/13']);
  folderKey = back.key;
});

/** Minimal Express Response stand-in for Ping. */
class FakeRes extends EventEmitter {
  statusCode = 0; body: Buffer | null = null; writableEnded = false; headers: Record<string, string> = {};
  set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k: string, v: string) { return this.set(k, v); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  status(c: number) { this.statusCode = c; return this; }
  send(b: Buffer | string) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(b); this.writableEnded = true; this.emit('finish'); return this; }
}
async function ping(ids: string[], heartbeat = '1') {
  const P = (t: number, k?: WNode[] | string): WNode => [13, t, k];
  const res = new FakeRes();
  await handlePing(decodeWbxml(clientWbxml(P(0x05, [P(0x08, heartbeat), P(0x09, ids.map((id) => P(0x0a, [P(0x0b, id), P(0x0c, 'Calendar')])))]))),
    'u1', res as never, {}, { deviceId: 'dev1', pollIntervalMs: 5, minHeartbeatSec: 1, version: '14.1' });
  const t = decodeWbxml(res.body!);
  return `${kid(t, 'Status')?.text}:${kids(kid(t, 'Folders'), 'Folder').map((f) => f.text).join(',')}`;
}

test('Ping: quiet PIM folders expire; a change made before or during the Ping is reported; foreign / new hierarchy → 7', async () => {
  calKey = (await sync('cal:calA', calKey)).key;
  const tasksPrimed = await sync('tasks:default', '0'); // the FilterType change above → resync
  await sync('tasks:default', (await sync('tasks:default', tasksPrimed.key)).key);
  assert.equal(await ping(['cal:calA', 'tasks:default']), '1:');
  await model('task').update({ where: { id: 't1' }, data: { subject: 'Steuererklärung' } });
  assert.equal(await ping(['cal:calA', 'tasks:default']), '2:tasks:default');
  const during = ping(['cal:calA'], '3');
  setTimeout(() => { void model('calendarEvent').update({ where: { id: 'ev1' }, data: { location: 'Praxis' } }); }, 30);
  assert.equal(await during, '2:cal:calA');
  assert.equal(await ping(['cal:calX']), '7:');
  rows('calendar').push({ id: 'calC', userId: 'u1', name: 'Urlaub', isDefault: false, sortOrder: 2, createdAt: new Date(4) });
  assert.equal(await ping(['inbox']), '7:', 'a new calendar → FolderSync first');
  const fs = await folderSync(folderKey);
  assert.deepEqual(fs.add, ['cal:calC=Urlaub/13']);
});

test('MeetingResponse: the accepted meeting is in the default calendar and reaches the device with ServerId = CalendarId', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ext//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:inv-9@ext.test', 'SEQUENCE:0',
    'DTSTAMP:20261110T090000Z', 'DTSTART:20261126T100000Z', 'DTEND:20261126T110000Z', 'SUMMARY:Review', 'ORGANIZER;CN=Olga:mailto:olga@ext.test',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const raw = Buffer.from(['From: olga@ext.test', 'To: bob@example.com', 'Subject: Review', 'MIME-Version: 1.0',
    'Content-Type: text/calendar; method=REQUEST; charset=UTF-8', '', ics].join('\r\n'));
  rows('message').push({ id: 'req9', folderId: 'inbox', uid: 9, modSeq: 5n, deletedAt: null, storagePath: 'raw/req9', flags: [] });
  const MR = (t: number, k?: WNode[] | string): WNode => [8, t, k];
  const out = decodeWbxml(await handleMeetingResponse(decodeWbxml(clientWbxml(MR(0x07, [MR(0x09, [MR(0x0c, '1'), MR(0x06, 'inbox'), MR(0x08, 'req9')])]))),
    'u1', { loadRaw: async () => raw, enqueue: async () => 'job' }, '14.1'));
  const calendarId = kid(kid(out, 'Result'), 'CalendarId')!.text!;
  const r = await sync('cal:calA', calKey);
  assert.ok(r.adds.includes(calendarId), `${calendarId} in ${r.adds}`);
  assert.deepEqual(['MeetingStatus', 'ResponseType', 'OrganizerEmail'].map((n) => kid(r.data(calendarId), n)?.text), ['3', '3', 'olga@ext.test']);
});
