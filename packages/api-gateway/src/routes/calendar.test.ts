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
let seq = 0;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  calendar: {
    findUnique: async (a: { where: Row }) => (a.where['id'] === 'cal1' ? { id: 'cal1', userId: 'alice' }
      : a.where['id'] === 'calBob' ? { id: 'calBob', userId: 'bob' } : null),
    findMany: async (a: { where: Row }) => (a.where['userId'] === 'alice'
      ? [{ id: 'cal1', name: 'Work', color: '#000', icon: null, sortOrder: 0, isDefault: true, userId: 'alice' }]
      : []),
  },
  // alice holds a WRITE share on bob's calendar "calBob"
  calendarShare: {
    findUnique: async (a: { where: { calendarId_granteeId?: { calendarId: string; granteeId: string } } }) =>
      (a.where.calendarId_granteeId?.calendarId === 'calBob' && a.where.calendarId_granteeId.granteeId === 'alice' ? { permission: 'WRITE' } : null),
    findMany: async () => [],
  },
  user: { findUnique: async () => ({ email: 'alice@example.com', displayName: 'Alice' }) },
  serverSettings: { findUnique: async () => ({ publicHostname: 'mail.example.com' }) },
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