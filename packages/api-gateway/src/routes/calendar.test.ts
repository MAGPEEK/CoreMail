/**
 * REST calendar write/list paths: all-day + RRULE persistence, iCal patching on
 * PUT (CalDAV data survives), overlap + recurrence expansion on GET /events.
 * Express app on an ephemeral loopback port, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test src/routes/calendar.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

setTestEnv();

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c['in'] as unknown[]).includes(v);
      if ('lt' in c) return (v as Date).getTime() < (c['lt'] as Date).getTime();
      if ('gt' in c) return (v as Date).getTime() > (c['gt'] as Date).getTime();
      if ('not' in c) return c['not'] === null ? v !== null && v !== undefined : v !== c['not'];
      return false;
    }
    return v === cond;
  });
}

const events: Row[] = [];
const roomBookings: Row[] = [];
let seq = 0;
// 9.4: alice's stored preferences (default reminder)
let alicePrefs: Row = {};
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  $transaction: async (fn: (tx: unknown) => unknown) => fn((globalThis as Record<string, unknown>)['__prisma']),
  ...noProtocolPolicies(),
  calendar: {
    findUnique: async (a: { where: Row }) => (a.where['id'] === 'cal1' ? { id: 'cal1', userId: 'alice' }
      : a.where['id'] === 'calBob' ? { id: 'calBob', userId: 'bob' } : null),
    findMany: async (a: { where: Row }) => (a.where['userId'] === 'alice'
      ? [{ id: 'cal1', name: 'Work', color: '#000', icon: null, sortOrder: 0, isDefault: true, userId: 'alice' }]
      : a.where['userId'] === 'bob' ? [{ id: 'calBob' }] : []), // bob shared calBob with alice
  },
  // 9.4 review: one room of alice's domain with its bookings
  resourceMailbox: {
    findMany: async (a: { where: Row }) => (a.where['domainId'] === 'd1' ? [{
      id: 'r1', email: 'raum@example.com', displayName: 'Raum', resourceType: 'ROOM', capacity: 6, location: '', active: true,
      autoAccept: true, autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: null, bookingWindowDays: 3650,
      requireApproval: false, calendar: { id: 'rc1' },
    }] : []),
  },
  resourceCalendar: { update: async () => ({ id: 'rc1' }) },
  resourceBooking: {
    findMany: async () => roomBookings.map((b) => ({ ...b })),
    upsert: async (a: { where: { calendarId_uid: { uid: string } }; create: Row; update: Row }) => {
      const existing = roomBookings.find((b) => b['uid'] === a.where.calendarId_uid.uid);
      if (existing) Object.assign(existing, a.update); else roomBookings.push({ calendarId: 'rc1', ...a.create });
      return null;
    },
    updateMany: async (a: { where: { uid: string }; data: Row }) => {
      const rows = roomBookings.filter((b) => b['uid'] === a.where.uid);
      for (const b of rows) Object.assign(b, a.data);
      return { count: rows.length };
    },
    deleteMany: async () => ({ count: 0 }),
  },
  // alice holds a WRITE share on bob's calendar "calBob"
  calendarShare: {
    findUnique: async (a: { where: { calendarId_granteeId?: { calendarId: string; granteeId: string } } }) =>
      (a.where.calendarId_granteeId?.calendarId === 'calBob' && a.where.calendarId_granteeId.granteeId === 'alice' ? { permission: 'WRITE' } : null),
    findMany: async () => [],
  },
  user: { findUnique: async () => ({ email: 'alice@example.com', displayName: 'Alice' }) },
  serverSettings: { findUnique: async () => ({ publicHostname: 'mail.example.com' }) },
  userSettings: { findUnique: async () => ({ preferences: alicePrefs }) },
  calendarEvent: {
    create: async (a: { data: Row }) => {
      const row = { id: `ev${++seq}`, description: '', location: '', allDay: false, recurring: false, rrule: null,
        classification: 'PUBLIC', status: 'CONFIRMED', sequence: 0, attendees: [], organizer: null,
        createdAt: new Date(), updatedAt: new Date(), ...a.data };
      events.push(row);
      return row;
    },
    findUnique: async (a: { where: Row }) => events.find((e) => matches(e, a.where)) ?? null,
    findMany: async (a: { where: Row }) => events.filter((e) => matches(e, a.where))
      .sort((x, y) => (x['dtStart'] as Date).getTime() - (y['dtStart'] as Date).getTime()),
    update: async (a: { where: Row; data: Row }) => {
      const row = events.find((e) => matches(e, a.where))!;
      Object.assign(row, a.data, { updatedAt: new Date() });
      return row;
    },
  },
};

const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { calendarRouter } = await import('./calendar.js');
const { parseCalendarObject, parseIcal, findMainVEvent, getProperty, buildVCalendar } = await import('@coremail/core/calendar');

const token = signAccessToken({
  sub: 'alice', email: 'alice@example.com', role: 'USER',
  domainId: 'd1', sessionId: 's1', mfaVerified: false,
});

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/calendar', calendarRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/calendar`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000), // a handler that never answers fails the test instead of hanging it
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('POST all-day: date-only values, exclusive end, allDay persisted, valid iCal (UID/DTSTAMP/VALUE=DATE)', async () => {
  const r = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Holiday\r\nATTENDEE:mailto:evil@x.com', dtStart: '2026-05-01', dtEnd: '2026-05-01', allDay: true,
  });
  assert.equal(r.status, 201);
  const row = events.find((e) => e['id'] === r.json.id)!;
  assert.equal(row['allDay'], true);
  assert.equal((row['dtStart'] as Date).toISOString(), '2026-05-01T00:00:00.000Z');
  assert.equal((row['dtEnd'] as Date).toISOString(), '2026-05-02T00:00:00.000Z');
  const parsed = parseCalendarObject(String(row['icalData']))!.main;
  assert.equal(parsed.allDay, true);
  assert.equal(parsed.uid, row['uid']);
  assert.equal(parsed.attendees.length, 0, 'no CRLF injection');
  assert.match(String(row['icalData']), /DTSTAMP:\d{8}T\d{6}Z/);
  assert.match(String(row['icalData']), /DTEND;VALUE=DATE:20260502/);
});

test('POST with rrule persists rrule + recurring; invalid RRULE is rejected', async () => {
  const ok = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Standup', dtStart: '2026-05-04T08:00:00.000Z', dtEnd: '2026-05-04T08:15:00.000Z',
    rrule: 'FREQ=DAILY;COUNT=3',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.rrule, 'FREQ=DAILY;COUNT=3');
  assert.equal(ok.json.recurring, true);
  const bad = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'x', dtStart: '2026-05-04T08:00:00Z', dtEnd: '2026-05-04T09:00:00Z',
    rrule: 'FREQ=DAILY\r\nX-EVIL:1',
  });
  assert.equal(bad.status, 400);
});

let seriesId = '';

test('PUT patches the stored iCal: RRULE, VALARM, VTIMEZONE and TZID written by CalDAV clients survive', async () => {
  const caldavIcs = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:caldav-1@client', 'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Europe/Berlin:20260105T100000', 'DTEND;TZID=Europe/Berlin:20260105T110000',
    'SUMMARY:Weekly', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Berlin:20260112T100000',
    'X-CLIENT-PROP:keep-me',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const row = await (globalThis as any).__prisma.calendarEvent.create({ data: {
    calendarId: 'cal1', uid: 'caldav-1@client', summary: 'Weekly', icalData: caldavIcs,
    dtStart: new Date('2026-01-05T09:00:00Z'), dtEnd: new Date('2026-01-05T10:00:00Z'),
    recurring: true, rrule: null,
  } });

  const r = await call('PUT', `/events/${row.id}`, { summary: 'Weekly sync', location: 'Room 1' });
  assert.equal(r.status, 200);
  const ev = findMainVEvent(parseIcal(String(row['icalData']))!)!;
  assert.equal(getProperty(ev, 'SUMMARY')?.value, 'Weekly sync');
  assert.equal(getProperty(ev, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO');
  assert.ok(getProperty(ev, 'EXDATE'));
  assert.equal(getProperty(ev, 'X-CLIENT-PROP')?.value, 'keep-me');
  assert.ok(ev.components.some((c) => c.name === 'VALARM'));
  assert.equal(getProperty(ev, 'DTSTART')?.params['TZID'], 'Europe/Berlin', 'dates untouched');
  assert.equal(row['recurring'], true);

  assert.equal(row['sequence'], 1, 'summary change bumps SEQUENCE');
  seriesId = String(row.id);
});

test('GET /events: overlap semantics + server-side recurrence expansion (EXDATE honoured)', async () => {
  // Window: 2026-01-01 .. 2026-01-27 → series instances on Jan 5, 19, 26 (Jan 12 excluded)
  const r = await call('GET', '/events?start=2026-01-01T00:00:00.000Z&end=2026-01-27T00:00:00.000Z');
  assert.equal(r.status, 200);
  const weekly = (r.json as any[]).filter((e) => e.summary === 'Weekly sync');
  assert.deepEqual(weekly.map((e) => e.dtStart), [
    '2026-01-05T09:00:00.000Z', '2026-01-19T09:00:00.000Z', '2026-01-26T09:00:00.000Z',
  ]);
  assert.ok(weekly.every((e) => typeof e.recurrenceId === 'string' && e.instanceId.startsWith(e.id + ':')));

  // An all-day event that started before the window and ends inside it is returned
  const spanning = await call('POST', '/events', { calendarId: 'cal1', summary: 'Trip', dtStart: '2026-02-27', dtEnd: '2026-03-03', allDay: true });
  assert.equal(spanning.status, 201);
  const march = await call('GET', '/events?start=2026-03-01T00:00:00.000Z&end=2026-03-31T00:00:00.000Z');
  const trip = (march.json as any[]).find((e) => e.summary === 'Trip');
  assert.ok(trip, 'overlapping event must not be dropped');
  assert.equal(trip.allDay, true);
  assert.equal(trip.dtEnd, '2026-03-03T00:00:00.000Z');

  assert.equal((await call('GET', '/events?start=2026-03-01&end=2020-01-01')).status, 400);
});

test('PUT moving a TZID series keeps its zone, RRULE and bumps SEQUENCE', async () => {
  const eventTable = (globalThis as any).__prisma.calendarEvent;
  const stored = (await eventTable.findUnique({ where: { id: seriesId } }))!;
  // Moving the series keeps the zone (11:00 Berlin = 10:00Z in January)
  const moved = await call('PUT', `/events/${seriesId}`, { dtStart: '2026-01-05T10:00:00.000Z', dtEnd: '2026-01-05T11:00:00.000Z' });
  assert.equal(moved.status, 200);
  const ev2 = findMainVEvent(parseIcal(String(stored['icalData']))!)!;
  assert.deepEqual(getProperty(ev2, 'DTSTART'), { name: 'DTSTART', params: { TZID: 'Europe/Berlin' }, value: '20260105T110000' });
  assert.equal(getProperty(ev2, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(stored['sequence'], 2, 'date change bumps SEQUENCE');
});

test('WRITE grantee cannot PUT/DELETE a PRIVATE or CONFIDENTIAL event of the owner (masked copy would overwrite it)', async () => {
  const ics = buildVCalendar({ uid: 'bob-priv', summary: 'Doctor', description: 'diagnosis', start: new Date('2026-07-01T10:00:00Z'), end: new Date('2026-07-01T11:00:00Z'), classification: 'PRIVATE' });
  const base = { calendarId: 'calBob', description: 'diagnosis', location: 'Clinic', dtStart: new Date('2026-07-01T10:00:00Z'), dtEnd: new Date('2026-07-01T11:00:00Z'),
    allDay: false, recurring: false, rrule: null, status: 'CONFIRMED', sequence: 0, attendees: [], organizer: null, updatedAt: new Date() };
  events.push({ ...base, id: 'bobPriv', uid: 'bob-priv', summary: 'Doctor', classification: 'PRIVATE', icalData: ics });
  events.push({ ...base, id: 'bobConf', uid: 'bob-conf', summary: 'Secret', classification: 'CONFIDENTIAL', icalData: ics.replace('PRIVATE', 'CONFIDENTIAL') });
  events.push({ ...base, id: 'bobPub', uid: 'bob-pub', summary: 'Standup', classification: 'PUBLIC', icalData: ics.replace('CLASS:PRIVATE\r\n', '') });

  for (const id of ['bobPriv', 'bobConf']) {
    const put = await call('PUT', `/events/${id}`, { summary: 'Beschäftigt', description: '', location: '' });
    assert.equal(put.status, 403, id);
    assert.equal((await call('DELETE', `/events/${id}`)).status, 403, id);
  }
  const row = events.find((e) => e['id'] === 'bobPriv')!;
  assert.equal(row['summary'], 'Doctor');
  assert.match(String(row['icalData']), /DESCRIPTION:diagnosis/);

  const pub = await call('PUT', '/events/bobPub', { summary: 'Standup moved' });
  assert.equal(pub.status, 200);
});

test('8.0.0: WRITE grantee cannot PUT/DELETE a PUBLIC series with a PRIVATE override (same rule as CalDAV)', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
    'BEGIN:VEVENT', 'UID:bob-series', 'DTSTAMP:20260601T000000Z', 'DTSTART:20260701T100000Z', 'DTEND:20260701T110000Z',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly sync', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:bob-series', 'DTSTAMP:20260601T000000Z', 'RECURRENCE-ID:20260708T100000Z',
    'DTSTART:20260708T100000Z', 'DTEND:20260708T110000Z', 'SUMMARY:Salary talk', 'DESCRIPTION:raise', 'CLASS:PRIVATE', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  events.push({ id: 'bobSeries', uid: 'bob-series', calendarId: 'calBob', summary: 'Weekly sync', description: '', location: '',
    dtStart: new Date('2026-07-01T10:00:00Z'), dtEnd: new Date('2026-07-01T11:00:00Z'), allDay: false, recurring: true,
    rrule: 'FREQ=WEEKLY;COUNT=4', status: 'CONFIRMED', sequence: 0, attendees: [], organizer: null, classification: 'PUBLIC',
    icalData: ics, updatedAt: new Date() });

  assert.equal((await call('PUT', '/events/bobSeries', { summary: 'Weekly sync (moved)' })).status, 403);
  assert.equal((await call('DELETE', '/events/bobSeries')).status, 403);
  const row = events.find((e) => e['id'] === 'bobSeries')!;
  assert.match(String(row['icalData']), /DESCRIPTION:raise/, 'private override untouched');
});

test('9.4: POST without reminderMinutes adds the default reminder; null = none; explicit value wins', async () => {
  const body = { calendarId: 'cal1', summary: 'Sync', dtStart: '2026-06-01T08:00:00.000Z', dtEnd: '2026-06-01T08:30:00.000Z' };
  const def = await call('POST', '/events', body);
  assert.equal(def.status, 201);
  assert.match(String(events.find((e) => e['id'] === def.json.id)!['icalData']), /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M/);
  alicePrefs = { calendar: { defaultReminderMinutes: 60 } };
  const own = await call('POST', '/events', body);
  assert.match(String(events.find((e) => e['id'] === own.json.id)!['icalData']), /TRIGGER:-PT60M/);
  const none = await call('POST', '/events', { ...body, reminderMinutes: null });
  assert.doesNotMatch(String(events.find((e) => e['id'] === none.json.id)!['icalData']), /VALARM/);
  const explicit = await call('POST', '/events', { ...body, reminderMinutes: 5 });
  assert.match(String(events.find((e) => e['id'] === explicit.json.id)!['icalData']), /TRIGGER:-PT5M/);
  alicePrefs = { calendar: { defaultReminderMinutes: null } };
  const off = await call('POST', '/events', body);
  assert.doesNotMatch(String(events.find((e) => e['id'] === off.json.id)!['icalData']), /VALARM/);
  alicePrefs = {};
});

// ─── 9.4: occurrences, show-as, reminders, free/busy ─────────────────────────

test('9.4: PUT/DELETE ?occurrence= change or remove one instance; the series stays', async () => {
  const created = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Daily', dtStart: '2026-08-03T07:00:00.000Z', dtEnd: '2026-08-03T07:15:00.000Z',
    rrule: 'FREQ=DAILY;COUNT=5', reminderMinutes: null,
  });
  assert.equal(created.status, 201);
  const id = created.json.id as string;

  const moved = await call('PUT', `/events/${id}?occurrence=2026-08-04T07:00:00.000Z`, {
    summary: 'Daily (später)', dtStart: '2026-08-04T09:00:00.000Z', dtEnd: '2026-08-04T09:15:00.000Z', showAs: 'TENTATIVE',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.dtStart, '2026-08-04T09:00:00.000Z');
  assert.equal((await call('DELETE', `/events/${id}?occurrence=2026-08-06T07:00:00.000Z`)).status, 200);
  assert.equal((await call('DELETE', `/events/${id}?occurrence=2026-08-06T08:00:00.000Z`)).status, 404, 'not an occurrence');
  assert.equal((await call('PUT', `/events/${id}?occurrence=nonsense`, { summary: 'x' })).status, 400);

  const list = await call('GET', '/events?start=2026-08-01T00:00:00.000Z&end=2026-08-10T00:00:00.000Z');
  const daily = (list.json as any[]).filter((e) => e.id === id);
  assert.deepEqual(daily.map((e) => [e.dtStart, e.summary]), [
    ['2026-08-03T07:00:00.000Z', 'Daily'],
    ['2026-08-04T09:00:00.000Z', 'Daily (später)'],
    ['2026-08-05T07:00:00.000Z', 'Daily'],
    ['2026-08-07T07:00:00.000Z', 'Daily'],
  ]);
  const one = await call('GET', `/events/${id}?occurrence=2026-08-04T07:00:00.000Z`);
  assert.equal(one.status, 200);
  assert.equal(one.json.summary, 'Daily (später)');
  assert.equal(one.json.recurrenceId, '2026-08-04T07:00:00.000Z');
  assert.equal(one.json.showAs, 'TENTATIVE');
  const row = events.find((e) => e['id'] === id)!;
  assert.equal(row['summary'], 'Daily', 'master unchanged');
  assert.match(String(row['icalData']), /EXDATE:20260806T070000Z/);
  assert.match(String(row['icalData']), /RECURRENCE-ID:20260804T070000Z/);
});

test('9.4: show-as and reminder (incl. e-mail) are written to the iCal and returned to the owner', async () => {
  const created = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Urlaub', dtStart: '2026-09-01', dtEnd: '2026-09-05', allDay: true,
    showAs: 'OOF', reminderMinutes: 1440, reminderByMail: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.showAs, 'OOF');
  const row = events.find((e) => e['id'] === created.json.id)!;
  assert.match(String(row['icalData']), /X-MICROSOFT-CDO-BUSYSTATUS:OOF/);
  assert.match(String(row['icalData']), /ACTION:EMAIL/);
  const detail = await call('GET', `/events/${created.json.id}`);
  assert.equal(detail.json.reminderMinutes, 1440);
  assert.equal(detail.json.reminderByMail, true);
  assert.equal(detail.json.icalData, undefined, 'raw iCal not in the detail view');

  const put = await call('PUT', `/events/${created.json.id}`, { showAs: 'FREE', reminderByMail: false });
  assert.equal(put.status, 200);
  assert.equal(row['showAs'], 'FREE');
  assert.match(String(row['icalData']), /TRANSP:TRANSPARENT/);
  assert.doesNotMatch(String(row['icalData']), /ACTION:EMAIL/);
  assert.match(String(row['icalData']), /TRIGGER:-PT1440M/, 'minutes kept when only the e-mail flag changes');
  const list = await call('GET', '/events?start=2026-08-31T00:00:00.000Z&end=2026-09-10T00:00:00.000Z');
  const ev = (list.json as any[]).find((e) => e.id === created.json.id);
  assert.deepEqual(ev.reminder, { minutes: 1440, byMail: false });
});

test('9.4: free/busy — FREE events do not block, tentative/out-of-office are typed', async () => {
  (globalThis as any).__prisma.user.findMany = async () => [{ id: 'alice', email: 'alice@example.com', displayName: 'Alice' }];
  await call('POST', '/events', { calendarId: 'cal1', summary: 'Busy', dtStart: '2026-10-07T08:00:00.000Z', dtEnd: '2026-10-07T09:00:00.000Z', reminderMinutes: null });
  await call('POST', '/events', { calendarId: 'cal1', summary: 'Focus', dtStart: '2026-10-07T09:00:00.000Z', dtEnd: '2026-10-07T10:00:00.000Z', showAs: 'FREE', reminderMinutes: null });
  await call('POST', '/events', { calendarId: 'cal1', summary: 'Maybe', dtStart: '2026-10-07T10:00:00.000Z', dtEnd: '2026-10-07T11:00:00.000Z', showAs: 'TENTATIVE', reminderMinutes: null });
  const r = await call('POST', '/freebusy', { userEmails: ['alice@example.com', 'nobody@example.com'], start: '2026-10-07T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z' });
  assert.equal(r.status, 200);
  const alice = r.json.users[0];
  assert.equal(alice.visible, true);
  assert.deepEqual(alice.busy.map((b: any) => [b.start.slice(11, 16), b.type, b.subject]), [['08:00', 'busy', 'Busy'], ['10:00', 'tentative', 'Maybe']]);
  assert.deepEqual(r.json.users[1], { email: 'nobody@example.com', displayName: null, found: false, visible: false, busy: [] });
});

// ─── 9.4 review fixes ────────────────────────────────────────────────────────

test('9.4 review: free/busy looks addresses up only in the own address list or among sharers', async () => {
  let where: Row = {};
  (globalThis as any).__prisma.user.findMany = async (a: { where: Row }) => { where = a.where; return []; };
  await call('POST', '/freebusy', { userEmails: ['hidden@example.com'], start: '2026-10-07T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z' });
  assert.deepEqual(where['OR'], [
    { id: 'alice' },
    { domainId: 'd1', NOT: { mailFlowPolicy: { is: { hiddenFromGal: true } } } },
    { calendars: { some: { shares: { some: { granteeId: 'alice' } } } } },
  ]);
});

test('9.4 review: a PRIVATE occurrence of a PUBLIC series is masked in the list and in free/busy', async () => {
  // bob's series (earlier test) has a CLASS:PRIVATE override on 2026-07-08
  const list = await call('GET', '/events?calendarId=calBob&start=2026-07-07T00:00:00.000Z&end=2026-07-09T00:00:00.000Z');
  assert.equal(list.status, 200);
  const [occ] = list.json as any[];
  assert.equal(occ.summary, 'Beschäftigt');
  assert.equal(occ.description, '');
  assert.equal(occ.classification, 'PRIVATE');

  (globalThis as any).__prisma.user.findMany = async () => [{ id: 'bob', email: 'bob@example.com', displayName: 'Bob' }];
  const fb = await call('POST', '/freebusy', { userEmails: ['bob@example.com'], start: '2026-07-01T00:00:00.000Z', end: '2026-07-09T00:00:00.000Z' });
  const slots = fb.json.users[0].busy as Array<{ start: string; subject?: string }>;
  assert.deepEqual(slots.filter((s) => s.start.startsWith('2026-07-08')).map((s) => s.subject), [undefined]);
  assert.ok(slots.some((s) => s.subject === 'Weekly sync'), 'the public occurrences keep their subject');
  assert.ok(!JSON.stringify(fb.json).includes('Salary talk'));
});

test('9.4 review: rooms are checked against the moved series, a moved occurrence and a deleted occurrence', async () => {
  roomBookings.length = 0;
  roomBookings.push({ calendarId: 'rc1', uid: 'blocker', status: 'ACCEPTED', dtStart: new Date('2026-12-14T11:00:00Z'), dtEnd: new Date('2026-12-14T12:00:00Z'), icalData: '' });
  const created = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Jour fixe', dtStart: '2026-12-07T09:00:00.000Z', dtEnd: '2026-12-07T10:00:00.000Z',
    rrule: 'FREQ=WEEKLY;COUNT=2', rooms: ['raum@example.com'], reminderMinutes: null,
  });
  assert.equal(created.status, 201);
  const room = () => (events.find((e) => e['id'] === created.json.id)!['attendees'] as Row[]).find((a) => a['email'] === 'raum@example.com')!;
  assert.equal(room()['partstat'], 'ACCEPTED');

  // the series moves to 11:00 — its second week now hits the blocker
  const moved = await call('PUT', `/events/${created.json.id}`, { dtStart: '2026-12-07T11:00:00.000Z', dtEnd: '2026-12-07T12:00:00.000Z' });
  assert.equal(moved.status, 200);
  assert.equal(room()['partstat'], 'DECLINED', 'checked against the new times, not the stored calendar data');

  // back to 09:00 (free), then only the second occurrence moves into the blocker
  await call('PUT', `/events/${created.json.id}`, { dtStart: '2026-12-07T09:00:00.000Z', dtEnd: '2026-12-07T10:00:00.000Z' });
  assert.equal(room()['partstat'], 'ACCEPTED');
  const occ = await call('PUT', `/events/${created.json.id}?occurrence=2026-12-14T09:00:00.000Z`, { dtStart: '2026-12-14T11:30:00.000Z', dtEnd: '2026-12-14T12:30:00.000Z' });
  assert.equal(occ.status, 200);
  assert.equal(room()['partstat'], 'DECLINED', 'a moved occurrence re-checks the room');
  assert.match(String(events.find((e) => e['id'] === created.json.id)!['icalData']), /PARTSTAT=DECLINED/);

  // deleting an occurrence gives the room booking the EXDATE (slot free again)
  assert.equal((await call('DELETE', `/events/${created.json.id}?occurrence=2026-12-07T09:00:00.000Z`)).status, 200);
  const booking = roomBookings.find((b) => b['uid'] !== 'blocker')!;
  assert.match(String(booking['icalData']), /EXDATE:20261207T090000Z/);
});
