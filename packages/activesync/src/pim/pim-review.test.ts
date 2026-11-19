/**
 * w3 review of the ActiveSync PIM classes against the in-memory Prisma fake: ClientIds of
 * earlier requests, re-priming without Supported, rooms of meetings written by a phone (the
 * REST booking path), a UTC event turned into a series (device / Region zone), the calendar
 * FilterType window, a completed task sent again with its rule, FolderSync retried with the
 * previous key (no endless Ping Status 7) and Ping with an unreadable policy (Status 8).
 * Run: node --import tsx --test src/pim/pim-review.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildVCalendar, parseCalendarObject } from '@coremail/core/calendar';
import { expandStoredEvent } from '@coremail/core/recurrence';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';
import { decodeTimeZone, encodeTimeZone, ianaForTimeZone, timeZoneOf } from './timezone.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const HOUR = 3_600_000;
const event = (id: string, start: string, opts: { organizer?: string; attendees?: Array<{ email: string; cutype?: string; partstat?: string }> } = {}) => {
  const s = new Date(start);
  const e = new Date(s.getTime() + HOUR);
  return {
    id, calendarId: 'calA', uid: `${id}@test`, summary: id, description: '', location: '', dtStart: s, dtEnd: e, allDay: false,
    recurring: false, rrule: null, organizer: opts.organizer ?? null, attendees: opts.attendees ?? [], classification: 'PUBLIC',
    showAs: 'BUSY', status: 'CONFIRMED', sequence: 0, updatedAt: new Date('2026-11-01T00:00:00Z'),
    icalData: buildVCalendar({
      uid: `${id}@test`, summary: id, start: s, end: e,
      ...(opts.organizer ? { organizer: { email: opts.organizer } } : {}), attendees: opts.attendees ?? [],
    }),
  };
};

const db = installFakeDb({
  user: [{ id: 'u1', email: 'bob@example.com', displayName: 'Bob', domainId: 'dom1', active: true }],
  emailAlias: [],
  userSettings: [{ userId: 'u1', preferences: { regional: { timeZone: 'Europe/Berlin' } } }],
  webmailPolicy: [],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 5n }],
  folder: [{ id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Posteingang', parentId: null }],
  message: [],
  calendar: [{ id: 'calA', userId: 'u1', name: 'Kalender', isDefault: true, sortOrder: 0, createdAt: new Date(1) }],
  calendarEvent: [
    event('evUtc', '2026-11-23T09:00:00Z'),
    event('evCopy', '2026-11-24T09:00:00Z', { organizer: 'olga@example.com', attendees: [{ email: 'bob@example.com' }, { email: 'raum@example.com', cutype: 'ROOM', partstat: 'ACCEPTED' }] }),
  ],
  task: [],
  note: [],
  resourceMailbox: [{
    id: 'r1', email: 'raum@example.com', displayName: 'Raum 1', resourceType: 'ROOM', capacity: 4, location: '', domainId: 'dom1',
    active: true, autoAccept: true, autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: null, bookingWindowDays: 365, requireApproval: false,
  }],
  resourceCalendar: [{ id: 'rc1', resourceId: 'r1', bookingSeq: 0 }],
  resourceBooking: [{
    id: 'b-other', calendarId: 'rc1', uid: 'other@test', summary: 'Andere', organizer: 'mallory@example.com',
    dtStart: new Date('2026-11-26T09:00:00Z'), dtEnd: new Date('2026-11-26T10:00:00Z'), status: 'ACCEPTED', conflicts: [],
    icalData: buildVCalendar({ uid: 'other@test', summary: 'Andere', start: new Date('2026-11-26T09:00:00Z'), end: new Date('2026-11-26T10:00:00Z') }),
  }],
  activeSyncDevice: [{ id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', protocolVersion: '14.1', syncKeys: {} }],
  activeSyncItem: [],
});

const { handleSync } = await import('../commands/sync.js');
const { handleFolderSync } = await import('../commands/folder-sync.js');
const { handlePing } = await import('../commands/ping.js');
const { decodeWbxml, tagsNewerThan } = await import('../wbxml.js');
const { invalidateWebmailPolicyCache } = await import('@coremail/storage');
type E = import('../wbxml.js').WbxmlElement;
type Model = { update(a: unknown): Promise<Record<string, unknown>>; findMany(a: unknown): Promise<unknown[]> };
const model = (name: string) => (db as unknown as Record<string, Model>)[name]!;

const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
const C = (t: number, k?: WNode[] | string): WNode => [4, t, k];
const T = (t: number, k?: WNode[] | string): WNode => [9, t, k];
const kid = (e: E | undefined, n: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === n);
const kids = (e: E | undefined, n: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === n);
const rows = (table: string) => db.tables[table]!;
const row = (table: string, id: string) => rows(table).find((r) => r['id'] === id)!;
const syncKeys = () => row('activeSyncDevice', 'd1')['syncKeys'] as Record<string, string>;

async function sync(collectionId: string, key: string, o: { commands?: WNode[]; extra?: WNode[] } = {}) {
  const col: WNode[] = [A(0x0b, key), A(0x12, collectionId), ...(o.extra ?? []), ...(o.commands?.length ? [A(0x16, o.commands)] : [])];
  const buf = await handleSync(decodeWbxml(clientWbxml(A(0x05, [A(0x1c, [A(0x0f, col)])]))), 'u1', 'dev1', { now: () => NOW }, '14.1');
  assert.deepEqual(tagsNewerThan(buf, '14.1'), []);
  const c = kid(kid(decodeWbxml(buf), 'Collections'), 'Collection')!;
  const cmds = kid(c, 'Commands');
  const ids = (n: string) => kids(cmds, n).map((x) => kid(x, 'ServerId')!.text!);
  const responses = kid(c, 'Responses');
  return {
    key: kid(c, 'SyncKey')!.text!, status: kid(c, 'Status')!.text!, adds: ids('Add'), changes: ids('Change'), deletes: ids('Delete'),
    data: (id: string) => kid([...kids(cmds, 'Add'), ...kids(cmds, 'Change')].find((x) => kid(x, 'ServerId')!.text === id), 'ApplicationData'),
    addIds: kids(responses, 'Add').map((x) => `${kid(x, 'ClientId')?.text}>${kid(x, 'ServerId')?.text}`),
  };
}
const add = (clientId: string, data: WNode[]) => A(0x07, [A(0x0c, clientId), A(0x1d, data)]);
const change = (serverId: string, data: WNode[]) => A(0x08, [A(0x0d, serverId), A(0x1d, data)]);
const utcZone = encodeTimeZone(timeZoneOf('UTC', 2026));
const meeting = (subject: string, start: string, end: string, attendees: string[], extra: WNode[] = []) => [
  C(0x05, utcZone), C(0x06, '0'), C(0x26, subject), C(0x27, start), C(0x12, end), C(0x0d, '2'),
  C(0x07, attendees.map((email) => C(0x08, [C(0x09, email), C(0x0a, email), C(0x29, '0'), C(0x2a, '1')]))), ...extra,
];
const roomEntry = (id: string) => parseCalendarObject(String(row('calendarEvent', id)['icalData']))!.main.attendees.find((a) => a.email === 'raum@example.com');
const booking = (uid: string) => rows('resourceBooking').find((b) => b['uid'] === uid);

let calKey = '';
test('setup: calendar primed with a two-week window', async () => {
  const p = await sync('cal:calA', '0', { extra: [A(0x17, [A(0x18, '4')])] });
  const first = await sync('cal:calA', p.key);
  assert.deepEqual(first.adds.sort(), ['evCopy', 'evUtc']);
  // a single timed event without zone is sent in the user's zone, so a phone keeps it there
  const zone = decodeTimeZone(kid(first.data('evUtc'), 'TimeZone')!.text!)!;
  assert.equal(ianaForTimeZone(zone, 2026, ['Europe/Berlin']), 'Europe/Berlin');
  calKey = (await sync('cal:calA', first.key)).key;
});

test('ClientIds of an earlier request are never matched (devices reuse them); a retry of the same request is', async () => {
  const one = await sync('cal:calA', calKey, { commands: [add('1', meeting('Erster', '20261125T080000Z', '20261125T090000Z', []))] });
  const firstId = one.addIds[0]!.split('>')[1]!;
  calKey = (await sync('cal:calA', one.key)).key;
  const two = await sync('cal:calA', calKey, { commands: [add('1', meeting('Zweiter', '20261127T080000Z', '20261127T090000Z', []))] });
  const secondId = two.addIds[0]!.split('>')[1]!;
  assert.notEqual(secondId, firstId, 'a new item, not the earlier one');
  assert.equal(row('calendarEvent', secondId)['summary'], 'Zweiter');
  const retry = await sync('cal:calA', calKey, { commands: [add('1', meeting('Zweiter', '20261127T080000Z', '20261127T090000Z', []))] });
  assert.deepEqual(retry.addIds, [`1>${secondId}`]);
  assert.equal(rows('calendarEvent').filter((e) => e['summary'] === 'Zweiter').length, 1);
  calKey = (await sync('cal:calA', retry.key)).key;
});

let meetingId = '';
test('rooms: a meeting added on the phone books the room (any AttendeeType); the answer replaces what the phone sent', async () => {
  const r = await sync('cal:calA', calKey, { commands: [add('m1', meeting('Planung', '20261125T130000Z', '20261125T140000Z', ['carol@example.com', 'raum@example.com']))] });
  meetingId = r.addIds[0]!.split('>')[1]!;
  const uid = String(row('calendarEvent', meetingId)['uid']);
  assert.deepEqual([booking(uid)?.['status'], booking(uid)?.['organizer']], ['ACCEPTED', 'bob@example.com']);
  assert.deepEqual([roomEntry(meetingId)?.cutype, roomEntry(meetingId)?.partstat, roomEntry(meetingId)?.role], ['ROOM', 'ACCEPTED', 'NON-PARTICIPANT']);
  // the device gets the stored meeting back (room answer, room type 3)
  assert.ok(r.changes.includes(meetingId));
  const room = kids(kid(r.data(meetingId), 'Attendees'), 'Attendee').find((a) => kid(a, 'Email')?.text === 'raum@example.com')!;
  assert.deepEqual([kid(room, 'AttendeeType')?.text, kid(room, 'AttendeeStatus')?.text], ['3', '3']);
  calKey = (await sync('cal:calA', r.key)).key;
});

test('rooms: moved onto another booking → declined; the phone cannot mark it accepted; removed → released', async () => {
  const uid = String(row('calendarEvent', meetingId)['uid']);
  const moved = await sync('cal:calA', calKey, { commands: [change(meetingId, meeting('Planung', '20261126T090000Z', '20261126T100000Z', ['carol@example.com', 'raum@example.com']))] });
  assert.deepEqual([roomEntry(meetingId)?.partstat, booking(uid)?.['status']], ['DECLINED', 'DECLINED']);
  calKey = (await sync('cal:calA', moved.key)).key;
  // same time, the phone claims the room accepted (AttendeeStatus 3): the stored answer stays
  const claim = meeting('Planung', '20261126T090000Z', '20261126T100000Z', []).map((n) => (n[1] === 0x07
    ? C(0x07, [C(0x08, [C(0x09, 'carol@example.com'), C(0x0a, 'Carol')]), C(0x08, [C(0x09, 'raum@example.com'), C(0x0a, 'Raum'), C(0x29, '3'), C(0x2a, '3')])])
    : n));
  calKey = (await sync('cal:calA', (await sync('cal:calA', calKey, { commands: [change(meetingId, claim)] })).key)).key;
  assert.equal(roomEntry(meetingId)?.partstat, 'DECLINED');
  // the room removed from the meeting → its booking is released
  const removed = await sync('cal:calA', calKey, { commands: [change(meetingId, meeting('Planung', '20261126T090000Z', '20261126T100000Z', ['carol@example.com']))] });
  assert.equal(booking(uid), undefined);
  calKey = (await sync('cal:calA', removed.key)).key;
});

test('rooms: a deleted meeting releases its room; the copy of another organizer\'s meeting and a foreign UID touch no booking', async () => {
  const r = await sync('cal:calA', calKey, { commands: [add('m2', meeting('Kurz', '20261130T080000Z', '20261130T090000Z', ['raum@example.com']))] });
  const id = r.addIds[0]!.split('>')[1]!;
  const uid = String(row('calendarEvent', id)['uid']);
  assert.equal(booking(uid)?.['status'], 'ACCEPTED');
  calKey = (await sync('cal:calA', r.key)).key;
  calKey = (await sync('cal:calA', (await sync('cal:calA', calKey, { commands: [A(0x09, [A(0x0d, id)])] })).key)).key;
  assert.equal(booking(uid), undefined);

  // the user's copy of Olga's meeting moved on the phone: Olga's room booking is not the user's
  const before = rows('resourceBooking').length;
  const copy = await sync('cal:calA', calKey, { commands: [change('evCopy', [...meeting('evCopy', '20261124T100000Z', '20261124T110000Z', ['raum@example.com']), C(0x19, 'olga@example.com')])] });
  assert.equal(rows('resourceBooking').length, before);
  assert.equal(booking('evCopy@test'), undefined);
  calKey = (await sync('cal:calA', copy.key)).key;

  // a phone meeting with the UID of someone else's booking: declined, the booking stays theirs
  const takeover = await sync('cal:calA', calKey, { commands: [add('m3', [...meeting('Kapern', '20261201T080000Z', '20261201T090000Z', ['raum@example.com']), C(0x28, 'other@test')])] });
  const tid = takeover.addIds[0]!.split('>')[1]!;
  assert.equal(roomEntry(tid)?.partstat, 'DECLINED');
  assert.deepEqual([booking('other@test')?.['organizer'], (booking('other@test')?.['dtStart'] as Date).toISOString()], ['mallory@example.com', '2026-11-26T09:00:00.000Z']);
  calKey = (await sync('cal:calA', takeover.key)).key;
});

test('a timed UTC event turned into a weekly series on the phone keeps its local time across DST (Region zone)', async () => {
  // the phone echoes the zone the event had (UTC before 9.5) and adds a weekly rule (Monday)
  const r = await sync('cal:calA', calKey, { commands: [change('evUtc', [
    C(0x05, utcZone), C(0x06, '0'), C(0x26, 'evUtc'), C(0x27, '20261123T090000Z'), C(0x12, '20261123T100000Z'),
    C(0x1b, [C(0x1c, '1'), C(0x1f, '1'), C(0x20, '2')]),
  ])] });
  const stored = String(row('calendarEvent', 'evUtc')['icalData']);
  assert.match(stored, /DTSTART;TZID=Europe\/Berlin:20261123T100000/);
  const occ = expandStoredEvent({ dtStart: new Date('2026-11-23T09:00:00Z'), dtEnd: new Date('2026-11-23T10:00:00Z'), allDay: false, recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=MO', icalData: stored },
    new Date('2027-04-05T00:00:00Z'), new Date('2027-04-06T00:00:00Z'));
  assert.deepEqual(occ.map((o) => o.dtStart.toISOString()), ['2027-04-05T08:00:00.000Z'], '10:00 local after the DST change');
  // the device gets it back with the zone the series now has
  assert.ok(r.changes.includes('evUtc'));
  assert.equal(ianaForTimeZone(decodeTimeZone(kid(r.data('evUtc'), 'TimeZone')!.text!)!, 2026, ['Europe/Berlin']), 'Europe/Berlin');
  calKey = (await sync('cal:calA', r.key)).key;
});

test('calendar FilterType window: the Sync reads the window and the held items; a held event that left the window still changes / deletes', async () => {
  const id = rows('calendarEvent').find((e) => e['summary'] === 'Erster')!['id'] as string;
  await model('calendarEvent').update({ where: { id }, data: { dtStart: new Date('2025-01-01T08:00:00Z'), dtEnd: new Date('2025-01-01T09:00:00Z'), summary: 'Erster (alt)' } });
  db.calls.length = 0;
  const r = await sync('cal:calA', calKey);
  assert.deepEqual(r.changes, [id]);
  const read = db.calls.find((c) => c.model === 'calendarEvent' && c.op === 'findMany')!;
  assert.ok(Array.isArray((read.args['where'] as Record<string, unknown>)['OR']), 'window filter, not the whole calendar');
  calKey = (await sync('cal:calA', r.key)).key;
  rows('calendarEvent').splice(rows('calendarEvent').findIndex((e) => e['id'] === id), 1);
  const gone = await sync('cal:calA', calKey);
  assert.deepEqual(gone.deletes, [id]);
  calKey = (await sync('cal:calA', gone.key)).key;
});

test('re-priming without Supported ghosts nothing any more', async () => {
  const p = await sync('cal:calA', '0', { extra: [A(0x17, [A(0x18, '4')]), A(0x20, [C(0x17)])] });
  assert.equal(syncKeys()['sup:cal:calA'], '["Location"]');
  const again = await sync('cal:calA', '0', { extra: [A(0x17, [A(0x18, '4')])] });
  assert.equal(syncKeys()['sup:cal:calA'], '');
  assert.equal(p.status, again.status);
  calKey = (await sync('cal:calA', (await sync('cal:calA', again.key)).key)).key;
});

test('tasks: a completed recurring task sent again with its Recurrence does not revive the series', async () => {
  const p = await sync('tasks:default', '0');
  const k = (await sync('tasks:default', p.key)).key;
  const data = (complete: string) => [T(0x20, 'Müll'), T(0x0d, '2026-11-20T07:00:00.000Z'), T(0x0c, '2026-11-20T08:00:00.000Z'), T(0x0a, complete),
    T(0x0f, [T(0x10, '1'), T(0x11, '2026-11-20T07:00:00.000Z'), T(0x14, '1'), T(0x16, '32')])];
  const a = await sync('tasks:default', k, { commands: [add('t', data('0'))] });
  const id = a.addIds[0]!.split('>')[1]!;
  const done = await sync('tasks:default', (await sync('tasks:default', a.key)).key, { commands: [change(id, data('1'))] });
  const k2 = (await sync('tasks:default', done.key)).key;
  // the phone's stale copy still has the Recurrence and sends the completed task again
  await sync('tasks:default', k2, { commands: [change(id, data('1'))] });
  assert.deepEqual([row('task', id)['status'], row('task', id)['rrule']], ['COMPLETED', null]);
  assert.equal(rows('task').filter((t) => t['subject'] === 'Müll').length, 2, 'one next task, not two');
});

async function folderSync(key: string) {
  const t = decodeWbxml(await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, key]]])), 'u1', 'dev1', '14.1'));
  return { status: kid(t, 'Status')!.text, key: kid(t, 'SyncKey')?.text ?? '', count: kid(kid(t, 'Changes'), 'Count')?.text };
}
class FakeRes extends EventEmitter {
  body: Buffer | null = null; writableEnded = false; headers: Record<string, string> = {};
  set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k: string, v: string) { return this.set(k, v); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  status() { return this; }
  send(b: Buffer | string) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(b); this.writableEnded = true; this.emit('finish'); return this; }
}
async function ping(ids: string[]): Promise<string> {
  const P = (t: number, k?: WNode[] | string): WNode => [13, t, k];
  const res = new FakeRes();
  await handlePing(decodeWbxml(clientWbxml(P(0x05, [P(0x08, '1'), P(0x09, ids.map((id) => P(0x0a, [P(0x0b, id), P(0x0c, 'Calendar')])))]))),
    'u1', res as never, {}, { deviceId: 'dev1', pollIntervalMs: 5, minHeartbeatSec: 1, version: '14.1' });
  return kid(decodeWbxml(res.body!), 'Status')!.text!;
}

test('FolderSync retried with the previous key after the hierarchy went back: new key, Ping does not answer 7 forever', async () => {
  const first = await folderSync('0');
  rows('calendar').push({ id: 'calB', userId: 'u1', name: 'Urlaub', isDefault: false, sortOrder: 1, createdAt: new Date(2) });
  const added = await folderSync(first.key);
  assert.equal(added.count, '1');
  // the response got lost, and the calendar is gone again before the device retries
  rows('calendar').splice(rows('calendar').findIndex((c) => c['id'] === 'calB'), 1);
  const retry = await folderSync(first.key);
  assert.deepEqual([retry.status, retry.count], ['1', '0']);
  assert.notEqual(retry.key, first.key, 'the snapshot moves to what the device holds');
  assert.equal(await ping(['cal:calA']), '1', 'no Status 7 after the FolderSync');
});

test('Ping with an unreadable webmail policy: Status 8 (temporary), not 7 (a FolderSync would fail as well)', async () => {
  const policies = (db as unknown as Record<string, Record<string, unknown>>)['webmailPolicy']!;
  const findMany = policies['findMany'];
  const findFirst = policies['findFirst'];
  policies['findMany'] = async () => { throw new Error('db down'); };
  policies['findFirst'] = async () => { throw new Error('db down'); };
  invalidateWebmailPolicyCache();
  try {
    assert.equal(await ping(['cal:calA']), '8');
  } finally {
    policies['findMany'] = findMany;
    policies['findFirst'] = findFirst;
    invalidateWebmailPolicyCache();
  }
  assert.equal(await ping(['cal:calA']), '1');
});
