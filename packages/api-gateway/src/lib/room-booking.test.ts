/**
 * 9.4: room booking from the event form — policy decisions, conflicts with
 * (recurring) bookings, booking rows and attendee answers.
 * Run: node --import tsx --test src/lib/room-booking.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const bookings: Row[] = [];
const ROOM = {
  id: 'r1', email: 'raum-a@example.com', displayName: 'Raum A', resourceType: 'ROOM', capacity: 8, location: 'EG',
  active: true, autoAccept: true, autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: 240,
  bookingWindowDays: 180, requireApproval: false, calendar: { id: 'rc1' },
};
installFakePrisma({
  resourceMailbox: { findMany: async () => [ROOM] },
  resourceBooking: {
    findMany: async () => bookings.map((b) => ({ ...b })),
    upsert: async (a: unknown) => {
      const { where, create, update } = a as { where: { calendarId_uid: { uid: string } }; create: Row; update: Row };
      const existing = bookings.find((b) => b['uid'] === where.calendarId_uid.uid);
      if (existing) Object.assign(existing, update); else bookings.push({ ...create });
      return null;
    },
  },
});

const { buildVCalendar } = await import('@coremail/core/calendar');
const { bookRooms, bookingIntervals, conflictsWith, decideRoomBooking, isRoomAttendee } = await import('./room-booking.js');

const d = (iso: string): Date => new Date(iso);
const now = d('2026-05-01T08:00:00Z');
const policy = { ...ROOM, maxDurationMinutes: 120 as number | null };
const slot = { start: d('2026-05-04T09:00:00Z'), end: d('2026-05-04T10:00:00Z'), recurring: false };

test('decideRoomBooking: policy table', () => {
  const table: Array<[string, Parameters<typeof decideRoomBooking>[0], Parameters<typeof decideRoomBooking>[1], boolean, unknown]> = [
    ['free slot → accepted', policy, slot, false, { status: 'ACCEPTED' }],
    ['conflict → declined', policy, slot, true, { status: 'DECLINED', reason: 'conflict' }],
    ['conflict without auto-decline → accepted', { ...policy, autoDeclineConflict: false }, slot, true, { status: 'ACCEPTED' }],
    ['inactive', { ...policy, active: false }, slot, false, { status: 'DECLINED', reason: 'inactive' }],
    ['recurring not allowed', { ...policy, allowRecurring: false }, { ...slot, recurring: true }, false, { status: 'DECLINED', reason: 'recurring' }],
    ['too long', policy, { ...slot, end: d('2026-05-04T12:00:00Z') }, false, { status: 'DECLINED', reason: 'duration' }],
    ['beyond the booking window', { ...policy, bookingWindowDays: 1 }, slot, false, { status: 'DECLINED', reason: 'window' }],
    ['approval required → pending', { ...policy, requireApproval: true }, slot, false, { status: 'PENDING' }],
    ['no auto-accept → pending', { ...policy, autoAccept: false }, slot, false, { status: 'PENDING' }],
  ];
  for (const [name, room, s, conflict, expected] of table) assert.deepEqual(decideRoomBooking(room, s, conflict, now), expected, name);
});

test('bookingIntervals: recurring bookings expanded, declined/pending and the own UID ignored', () => {
  const weekly = buildVCalendar({ uid: 'w', summary: 'Weekly', start: d('2026-05-04T09:00:00Z'), end: d('2026-05-04T10:00:00Z'), rrule: 'FREQ=WEEKLY;COUNT=3' });
  const rows = [
    { uid: 'w', status: 'ACCEPTED', dtStart: d('2026-05-04T09:00:00Z'), dtEnd: d('2026-05-04T10:00:00Z'), icalData: weekly },
    { uid: 'x', status: 'DECLINED', dtStart: d('2026-05-05T09:00:00Z'), dtEnd: d('2026-05-05T10:00:00Z'), icalData: '' },
    { uid: 'p', status: 'PENDING', dtStart: d('2026-05-06T09:00:00Z'), dtEnd: d('2026-05-06T10:00:00Z'), icalData: '' },
  ];
  const busy = bookingIntervals(rows, d('2026-05-01T00:00:00Z'), d('2026-06-01T00:00:00Z'));
  assert.deepEqual(busy.map((b) => b.start.toISOString()), ['2026-05-04T09:00:00.000Z', '2026-05-11T09:00:00.000Z', '2026-05-18T09:00:00.000Z']);
  assert.equal(bookingIntervals(rows, d('2026-05-01T00:00:00Z'), d('2026-06-01T00:00:00Z'), 'w').length, 0);
  assert.equal(conflictsWith([{ dtStart: d('2026-05-11T09:30:00Z'), dtEnd: d('2026-05-11T10:30:00Z') }], busy), true);
  assert.equal(conflictsWith([{ dtStart: d('2026-05-11T10:00:00Z'), dtEnd: d('2026-05-11T11:00:00Z') }], busy), false, 'touching is no conflict');
});

test('bookRooms: books a free room (ROOM attendee, accepted), declines a weekly meeting hitting an existing booking', async () => {
  const first = buildVCalendar({ uid: 'm1', summary: 'Planung', start: d('2026-05-04T09:00:00Z'), end: d('2026-05-04T10:00:00Z') });
  const accepted = await bookRooms({ uid: 'm1', summary: 'Planung', organizer: 'alice@example.com', dtStart: d('2026-05-04T09:00:00Z'), dtEnd: d('2026-05-04T10:00:00Z'), allDay: false, rrule: null, icalData: first }, ['RAUM-A@example.com'], 'd1', now);
  assert.deepEqual(accepted, [{ email: 'raum-a@example.com', cn: 'Raum A', cutype: 'ROOM', partstat: 'ACCEPTED', role: 'NON-PARTICIPANT', rsvp: false }]);
  assert.equal(bookings.length, 1);
  assert.equal(isRoomAttendee(accepted[0]), true);
  assert.equal(isRoomAttendee({ email: 'bob@example.com' }), false);

  // a weekly series starting a week earlier hits the booking in its second week
  const series = buildVCalendar({ uid: 'm2', summary: 'Jour fixe', start: d('2026-04-27T09:30:00Z'), end: d('2026-04-27T10:30:00Z'), rrule: 'FREQ=WEEKLY;COUNT=4' });
  const declined = await bookRooms({ uid: 'm2', summary: 'Jour fixe', organizer: 'alice@example.com', dtStart: d('2026-04-27T09:30:00Z'), dtEnd: d('2026-04-27T10:30:00Z'), allDay: false, rrule: 'FREQ=WEEKLY;COUNT=4', icalData: series }, ['raum-a@example.com'], 'd1', now);
  assert.equal(declined[0]!.partstat, 'DECLINED');
  assert.equal(declined[0]!.reason, 'conflict');
  assert.equal(bookings.find((b) => b['uid'] === 'm2')!['status'], 'DECLINED');

  // saving the first meeting again re-checks without counting its own booking
  const again = await bookRooms({ uid: 'm1', summary: 'Planung', organizer: 'alice@example.com', dtStart: d('2026-05-04T09:00:00Z'), dtEnd: d('2026-05-04T10:00:00Z'), allDay: false, rrule: null, icalData: first }, ['raum-a@example.com'], 'd1', now);
  assert.equal(again[0]!.partstat, 'ACCEPTED');
  assert.equal(bookings.filter((b) => b['uid'] === 'm1').length, 1);
});
