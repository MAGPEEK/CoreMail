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
// 9.5 review: iMIP sends (organizer lookup of notifyAttendees) are recorded
const notified: Row[] = [];
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
  // alice holds a WRITE share on bob's calendar "calBob"
  calendarShare: {
    findUnique: async (a: { where: { calendarId_granteeId?: { calendarId: string; granteeId: string } } }) =>
      (a.where.calendarId_granteeId?.calendarId === 'calBob' && a.where.calendarId_granteeId.granteeId === 'alice' ? { permission: 'WRITE' } : null),
    findMany: async () => [],
  },
  user: {
    findUnique: async (a: { where: Row }) => (a.where['id'] === 'bob' ? { email: 'bob@example.com', displayName: 'Bob' } : { email: 'alice@example.com', displayName: 'Alice' }),
    findFirst: async (a: { where: Row }) => { notified.push(a.where); return null; },
  },
  emailAlias: { findFirst: async () => null },
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
    delete: async (a: { where: Row }) => events.splice(events.findIndex((e) => matches(e, a.where)), 1)[0],
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

/** A stored meeting of someone else (as an invitation leaves it in the attendee's calendar). */
function storedMeeting(id: string, calendarId: string, organizer: string, people: string[], start: string) {
  const s = new Date(start);
  const e = new Date(s.getTime() + 3_600_000);
  const attendees = people.map((email) => ({ email, cn: email, partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true }));
  const row = {
    id, calendarId, uid: `${id}@ext.test`, summary: id, description: '', location: '', dtStart: s, dtEnd: e, allDay: false,
    recurring: false, rrule: null, classification: 'PUBLIC', showAs: 'BUSY', status: 'CONFIRMED', sequence: 0, organizer, attendees,
    icalData: buildVCalendar({ uid: `${id}@ext.test`, summary: id, start: s, end: e, organizer: { email: organizer }, attendees }),
    createdAt: new Date(), updatedAt: new Date(),
  };
  events.push(row);
  return row;
}

test('9.5 review: an attendee\'s copy changes only itself — no iMIP in the organizer\'s name', async () => {
  notified.length = 0;
  // olga's meeting, as alice's calendar holds it after the invitation
  const copy = storedMeeting('copy-1', 'cal1', 'olga@ext.test', ['alice@example.com', 'carl@ext.test'], '2026-12-21T09:00:00Z');
  const moved = await call('PUT', `/events/${copy.id}`, { dtStart: '2026-12-21T13:00:00.000Z', dtEnd: '2026-12-21T14:00:00.000Z' });
  assert.equal(moved.status, 200);
  assert.equal((copy.dtStart as Date).toISOString(), '2026-12-21T13:00:00.000Z', 'the copy itself moved');
  const deleted = await call('DELETE', `/events/${copy.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(events.some((e) => e['id'] === copy.id), false, 'the copy is gone');
  await new Promise((r) => setTimeout(r, 20)); // notifyAttendees runs fire-and-forget
  assert.deepEqual(notified, [], 'no REQUEST / CANCEL sent from the attendee\'s copy');
});

/** notifyAttendees runs fire-and-forget: wait until no new organizer lookup arrives for 30 ms. */
async function notifiedSettled(): Promise<void> {
  let seen = -1;
  for (let i = 0; i < 50 && seen !== notified.length; i++) {
    seen = notified.length;
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('9.5 review (10.0 kept): a delegate with WRITE on the organizer\'s calendar still sends the update and the cancellation', async () => {
  notified.length = 0;
  // bob's own meeting in bob's calendar, shared WRITE with alice
  const own = storedMeeting('bob-1', 'calBob', 'bob@example.com', ['carl@ext.test'], '2026-12-22T09:00:00Z');
  const moved = await call('PUT', `/events/${own.id}`, { dtStart: '2026-12-22T13:00:00.000Z', dtEnd: '2026-12-22T14:00:00.000Z' });
  assert.equal(moved.status, 200);
  await notifiedSettled();
  const afterUpdate = notified.length;
  assert.ok(afterUpdate > 0, 'REQUEST update sent');
  assert.ok(notified.every((w) => w['email'] === 'bob@example.com'), 'in bob\'s name');
  assert.equal((await call('DELETE', `/events/${own.id}`)).status, 200);
  await notifiedSettled();
  assert.ok(notified.length > afterUpdate, 'CANCEL sent');
  assert.ok(notified.every((w) => w['email'] === 'bob@example.com'), 'in bob\'s name');
});

test('10.0: a CUTYPE=ROOM attendee of another client is an ordinary attendee — kept, invited, no crash', async () => {
  notified.length = 0;
  const s = new Date('2026-12-23T09:00:00Z');
  const attendees = [
    { email: 'carl@ext.test', cn: 'Carl', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true },
    { email: 'room-7@ext.test', cn: 'Room 7', partstat: 'ACCEPTED', role: 'NON-PARTICIPANT', rsvp: false, cutype: 'ROOM' },
  ];
  const row = {
    id: 'own-room', calendarId: 'cal1', uid: 'own-room@example.com', summary: 'Review', description: '', location: '',
    dtStart: s, dtEnd: new Date(s.getTime() + 3_600_000), allDay: false, recurring: false, rrule: null, classification: 'PUBLIC',
    showAs: 'BUSY', status: 'CONFIRMED', sequence: 0, organizer: 'alice@example.com', attendees,
    icalData: buildVCalendar({ uid: 'own-room@example.com', summary: 'Review', start: s, end: new Date(s.getTime() + 3_600_000),
      organizer: { email: 'alice@example.com' }, attendees }),
    createdAt: new Date(), updatedAt: new Date(),
  };
  events.push(row);
  const moved = await call('PUT', `/events/${row.id}`, { dtStart: '2026-12-23T13:00:00.000Z', dtEnd: '2026-12-23T14:00:00.000Z' });
  assert.equal(moved.status, 200);
  assert.equal(row.sequence, 1);
  assert.deepEqual((row.attendees as Array<{ email: string }>).map((a) => a.email), ['carl@ext.test', 'room-7@ext.test'], 'attendee list unchanged');
  const main = parseCalendarObject(String(row.icalData))!.main;
  assert.deepEqual(main.attendees.map((a) => [a.email, a.cutype]), [['carl@ext.test', 'INDIVIDUAL'], ['room-7@ext.test', 'ROOM']]);
  await notifiedSettled();
  assert.ok(notified.length > 0 && notified.every((w) => w['email'] === 'alice@example.com'), 'the update goes out (room attendee included)');
  // the webmail form sends the attendee list without CUTYPE — the calendar object keeps it
  const edited = await call('PUT', `/events/${row.id}`, {
    attendees: [{ email: 'carl@ext.test', cn: 'Carl' }, { email: 'room-7@ext.test', cn: 'Room 7', partstat: 'ACCEPTED' }],
  });
  assert.equal(edited.status, 200);
  const kept = parseCalendarObject(String(row.icalData))!.main.attendees.find((a) => a.email === 'room-7@ext.test');
  assert.equal(kept?.cutype, 'ROOM');
});

test('10.0: rooms are gone — a `rooms` field is ignored and the room routes answer 404', async () => {
  const created = await call('POST', '/events', {
    calendarId: 'cal1', summary: 'Jour fixe', dtStart: '2026-12-07T09:00:00.000Z', dtEnd: '2026-12-07T10:00:00.000Z',
    rooms: ['raum@example.com'], reminderMinutes: null,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.attendees, [], 'no room attendee is added');
  assert.doesNotMatch(String(created.json.icalData), /raum@example\.com|CUTYPE=ROOM/);
  const rooms = await fetch(`${base}/rooms?start=2026-12-07T00:00:00.000Z&end=2026-12-08T00:00:00.000Z`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(rooms.status, 404);
});
