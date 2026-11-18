/**
 * 9.5: recurring meeting requests to resource mailboxes (mail path) — every
 * occurrence is checked against the resource's bookings (EXDATE / overrides applied,
 * recurring bookings expanded, bounded horizon), the resource policy applies like in
 * the event form, conflicting dates are stored, occurrence-only REQUEST / CANCEL
 * change the stored series, and concurrent requests for one slot get the room once.
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/handlers/resource-booking-recurring.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

interface Booking {
  id: string; calendarId: string; uid: string; organizer: string; status: string;
  summary: string; dtStart: Date; dtEnd: Date; icalData: string; conflicts: Array<{ start: string; end: string }>;
}
const bookings: Booking[] = [];
const POLICY = {
  id: 'r1', email: 'room@corp.test', active: true, autoAccept: true, requireApproval: false, autoDeclineConflict: true,
  allowRecurring: true, maxDurationMinutes: null as number | null, bookingWindowDays: 180, calendar: { id: 'cal1' },
};
let room = { ...POLICY };
let chain: Promise<unknown> = Promise.resolve();
const db = {
  $on: () => undefined,
  // serialised like the row lock of lockResourceCalendar
  $transaction: (fn: (tx: unknown) => unknown) => {
    const run = chain.then(() => fn(db));
    chain = run.catch(() => undefined);
    return run;
  },
  resourceCalendar: { update: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
  resourceMailbox: { findFirst: async ({ where }: { where: { email: string } }) => (where.email === room.email ? room : null) },
  resourceBooking: {
    findUnique: async ({ where }: { where: { calendarId_uid: { calendarId: string; uid: string } } }) =>
      bookings.find((b) => b.calendarId === where.calendarId_uid.calendarId && b.uid === where.calendarId_uid.uid) ?? null,
    findMany: async ({ where }: { where: { calendarId: string; dtStart: { lt: Date } } }) =>
      bookings.filter((b) => b.calendarId === where.calendarId && b.dtStart < where.dtStart.lt).map((b) => ({ ...b })),
    create: async ({ data }: { data: Omit<Booking, 'id'> }) => {
      await Promise.resolve(); // a real write yields — lets a racing request interleave
      const b = { id: `b${bookings.length + 1}`, ...data };
      bookings.push(b);
      return b;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Booking> }) => {
      const b = bookings.find((x) => x.id === where.id)!;
      Object.assign(b, data);
      return b;
    },
    delete: async ({ where }: { where: { id: string } }) => bookings.splice(bookings.findIndex((x) => x.id === where.id), 1)[0],
  },
};
(globalThis as unknown as { __prisma: unknown }).__prisma = db;

const {
  processResourceMailboxes, parseInvitation, applyOccurrenceUpdates, cancelOccurrences, meetingFromCalendar,
} = await import('./resource-booking.js');

const NOW = new Date('2026-11-18T08:00:00Z');
const AUTH = { verifiedDomains: ['ext.test'] };
const ORG = 'org@ext.test';

function vcal(method: string, events: string[][], extra: string[] = []): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${method}`, ...extra,
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
}
const event = (uid: string, start: string, end: string, more: string[] = []): string[] =>
  [`UID:${uid}`, `ORGANIZER:mailto:${ORG}`, `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Jour fixe', ...more];
const mail = (ical: string): Buffer => Buffer.from([`From: Org <${ORG}>`, 'Subject: Invitation', '', ical].join('\r\n'));
const send = (ical: string) => processResourceMailboxes(mail(ical), ['room@corp.test'], ORG, AUTH, NOW);
const booking = (uid: string): Booking => bookings.find((b) => b.uid === uid)!;

beforeEach(() => { bookings.length = 0; room = { ...POLICY }; });

/** An accepted single booking on Tue 2026-12-15 09:00–10:00Z (week three of the weekly series below). */
async function blockWeekThree(): Promise<void> {
  await send(vcal('REQUEST', [event('blocker', '20261215T090000Z', '20261215T100000Z')]));
  assert.equal(booking('blocker').status, 'ACCEPTED');
}
const WEEKLY = event('series', '20261201T093000Z', '20261201T103000Z', ['RRULE:FREQ=WEEKLY;COUNT=6']);

test('a weekly series whose third occurrence hits a booking is declined, the conflicting date stored', async () => {
  await blockWeekThree();
  await send(vcal('REQUEST', [WEEKLY]));
  assert.equal(booking('series').status, 'DECLINED');
  assert.deepEqual(booking('series').conflicts, [{ start: '2026-12-15T09:30:00.000Z', end: '2026-12-15T10:30:00.000Z' }]);
});

test('without "decline conflicts" the series is accepted with the conflicting dates listed', async () => {
  room = { ...POLICY, autoDeclineConflict: false };
  await blockWeekThree();
  await send(vcal('REQUEST', [WEEKLY]));
  assert.equal(booking('series').status, 'ACCEPTED');
  assert.deepEqual(booking('series').conflicts.map((c) => c.start), ['2026-12-15T09:30:00.000Z']);
});

test('EXDATE on the conflicting date or an override moving it away → accepted without conflicts', async () => {
  await blockWeekThree();
  await send(vcal('REQUEST', [[...WEEKLY, 'EXDATE:20261215T093000Z']]));
  assert.equal(booking('series').status, 'ACCEPTED');
  assert.deepEqual(booking('series').conflicts, []);

  bookings.length = 0;
  await blockWeekThree();
  await send(vcal('REQUEST', [
    event('moved', '20261201T093000Z', '20261201T103000Z', ['RRULE:FREQ=WEEKLY;COUNT=6']),
    event('moved', '20261215T140000Z', '20261215T150000Z', ['RECURRENCE-ID:20261215T093000Z']),
  ]));
  assert.equal(booking('moved').status, 'ACCEPTED');
  assert.deepEqual(booking('moved').conflicts, []);
});

test('an accepted recurring booking blocks a single meeting on a later occurrence (bookings expanded)', async () => {
  await send(vcal('REQUEST', [WEEKLY]));
  assert.equal(booking('series').status, 'ACCEPTED');
  await send(vcal('REQUEST', [event('single', '20261222T100000Z', '20261222T110000Z')]));
  assert.equal(booking('single').status, 'DECLINED');
  await send(vcal('REQUEST', [event('free', '20261222T110000Z', '20261222T120000Z')]));
  assert.equal(booking('free').status, 'ACCEPTED', 'touching the occurrence is no conflict');
});

test('resource policy applies to mailed requests: no series, max. duration, booking window', async () => {
  room = { ...POLICY, allowRecurring: false };
  await send(vcal('REQUEST', [WEEKLY]));
  assert.equal(booking('series').status, 'DECLINED');

  room = { ...POLICY, maxDurationMinutes: 30 };
  await send(vcal('REQUEST', [event('long', '20261203T090000Z', '20261203T100000Z')]));
  assert.equal(booking('long').status, 'DECLINED');

  room = { ...POLICY, bookingWindowDays: 7 };
  await send(vcal('REQUEST', [event('late', '20261203T090000Z', '20261203T100000Z')]));
  assert.equal(booking('late').status, 'DECLINED');

  room = { ...POLICY, requireApproval: true };
  await send(vcal('REQUEST', [event('approve', '20261204T090000Z', '20261204T100000Z')]));
  assert.equal(booking('approve').status, 'PENDING');
});

test('TZID start times are converted (not read as UTC)', async () => {
  const tz = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'];
  await send(vcal('REQUEST', [[`UID:tz`, `ORGANIZER:mailto:${ORG}`, 'DTSTART;TZID=Europe/Berlin:20261210T100000', 'DTEND;TZID=Europe/Berlin:20261210T110000', 'SUMMARY:TZ']], tz));
  assert.equal(booking('tz').dtStart.toISOString(), '2026-12-10T09:00:00.000Z');
});

test('the horizon is bounded: a booking beyond the window (max. a year) never declines an endless series', async () => {
  room = { ...POLICY, bookingWindowDays: 3650 };
  await send(vcal('REQUEST', [event('far', '20281206T093000Z', '20281206T103000Z')]));
  assert.equal(booking('far').status, 'ACCEPTED');
  await send(vcal('REQUEST', [event('daily', '20261201T093000Z', '20261201T103000Z', ['RRULE:FREQ=DAILY'])]));
  assert.equal(booking('daily').status, 'ACCEPTED');
  assert.deepEqual(booking('daily').conflicts, []);
});

test('occurrence-only REQUEST / CANCEL change the stored series', async () => {
  await send(vcal('REQUEST', [WEEKLY]));
  // one occurrence moved by the organizer — re-checked, still free
  await send(vcal('REQUEST', [event('series', '20261208T130000Z', '20261208T140000Z', ['RECURRENCE-ID:20261208T093000Z'])]));
  assert.equal(booking('series').status, 'ACCEPTED');
  assert.match(booking('series').icalData, /RECURRENCE-ID:20261208T093000Z/);
  assert.match(booking('series').icalData, /RRULE:FREQ=WEEKLY;COUNT=6/, 'the series master stays');

  // the moved slot is busy, the original one is free
  await send(vcal('REQUEST', [event('at-moved', '20261208T130000Z', '20261208T133000Z')]));
  assert.equal(booking('at-moved').status, 'DECLINED');
  await send(vcal('REQUEST', [event('at-original', '20261208T093000Z', '20261208T100000Z')]));
  assert.equal(booking('at-original').status, 'ACCEPTED');

  // cancelling one occurrence frees its slot, the booking stays
  await send(vcal('CANCEL', [[`UID:series`, `ORGANIZER:mailto:${ORG}`, 'RECURRENCE-ID:20261222T093000Z', 'DTSTART:20261222T093000Z']]));
  assert.equal(booking('series').status, 'ACCEPTED');
  assert.match(booking('series').icalData, /EXDATE:20261222T093000Z/);
  await send(vcal('REQUEST', [event('after-cancel', '20261222T093000Z', '20261222T100000Z')]));
  assert.equal(booking('after-cancel').status, 'ACCEPTED');

  // cancelling the series removes the booking
  await send(vcal('CANCEL', [[`UID:series`, `ORGANIZER:mailto:${ORG}`, 'DTSTART:20261201T093000Z']]));
  assert.equal(bookings.some((b) => b.uid === 'series'), false);
});

test('two concurrent requests for the same slot: exactly one gets the room', async () => {
  await Promise.all([
    send(vcal('REQUEST', [event('race-a', '20261209T090000Z', '20261209T100000Z')])),
    send(vcal('REQUEST', [event('race-b', '20261209T093000Z', '20261209T103000Z')])),
  ]);
  assert.deepEqual([booking('race-a').status, booking('race-b').status].sort(), ['ACCEPTED', 'DECLINED']);
});

test('review: two concurrent occurrence updates of one series are both kept (merged under the lock)', async () => {
  await send(vcal('REQUEST', [WEEKLY]));
  await Promise.all([
    send(vcal('REQUEST', [event('series', '20261208T130000Z', '20261208T140000Z', ['RECURRENCE-ID:20261208T093000Z'])])),
    send(vcal('REQUEST', [event('series', '20261215T130000Z', '20261215T140000Z', ['RECURRENCE-ID:20261215T093000Z'])])),
  ]);
  assert.match(booking('series').icalData, /RECURRENCE-ID:20261208T093000Z/);
  assert.match(booking('series').icalData, /RECURRENCE-ID:20261215T093000Z/);
});

test('review: an unauthenticated request racing the organizer never takes over the booking', async () => {
  await Promise.all([
    send(vcal('REQUEST', [event('owned', '20261209T090000Z', '20261209T100000Z')])),
    processResourceMailboxes(
      mail(vcal('REQUEST', [[...event('owned', '20261209T150000Z', '20261209T160000Z'), 'SUMMARY:Spoofed']])),
      ['room@corp.test'], ORG, null, NOW,
    ),
  ]);
  assert.equal(bookings.filter((b) => b.uid === 'owned').length, 1);
  assert.equal(booking('owned').status, 'ACCEPTED');
  assert.equal(booking('owned').dtStart.toISOString(), '2026-12-09T09:00:00.000Z');
});

test('review: a series repeating more than daily is declined (no expansion from its start)', async () => {
  await send(vcal('REQUEST', [event('dense', '20261201T090000Z', '20261201T093000Z', ['RRULE:FREQ=MINUTELY;INTERVAL=1'])]));
  assert.equal(booking('dense').status, 'DECLINED');
  await send(vcal('REQUEST', [event('hourly', '20261201T090000Z', '20261201T093000Z', ['RRULE:FREQ=DAILY;BYHOUR=9,10,11'])]));
  assert.equal(booking('hourly').status, 'DECLINED');
});

test('review: CANCEL of single occurrences of a TZID series and of an all-day series frees those slots', async () => {
  const tz = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'];
  const tzSeries = [`UID:tzs`, `ORGANIZER:mailto:${ORG}`, 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'DTEND;TZID=Europe/Berlin:20261201T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:TZ'];
  await send(vcal('REQUEST', [tzSeries], tz));
  await send(vcal('CANCEL', [[`UID:tzs`, `ORGANIZER:mailto:${ORG}`, 'RECURRENCE-ID;TZID=Europe/Berlin:20261208T100000']], tz));
  assert.equal(booking('tzs').status, 'ACCEPTED');
  await send(vcal('REQUEST', [event('tz-free', '20261208T090000Z', '20261208T100000Z')]));
  assert.equal(booking('tz-free').status, 'ACCEPTED', 'the cancelled 10:00 Berlin (09:00Z) slot is free');
  await send(vcal('REQUEST', [event('tz-busy', '20261215T090000Z', '20261215T100000Z')]));
  assert.equal(booking('tz-busy').status, 'DECLINED', 'the other occurrences stay booked');

  await send(vcal('REQUEST', [[`UID:days`, `ORGANIZER:mailto:${ORG}`, 'DTSTART;VALUE=DATE:20261202', 'DTEND;VALUE=DATE:20261203', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Day']]));
  assert.equal(booking('days').status, 'ACCEPTED');
  await send(vcal('CANCEL', [[`UID:days`, `ORGANIZER:mailto:${ORG}`, 'RECURRENCE-ID;VALUE=DATE:20261209']]));
  await send(vcal('REQUEST', [event('day-free', '20261209T120000Z', '20261209T130000Z')]));
  assert.equal(booking('day-free').status, 'ACCEPTED');
  await send(vcal('REQUEST', [event('day-busy', '20261216T120000Z', '20261216T130000Z')]));
  assert.equal(booking('day-busy').status, 'DECLINED');
});

test('pure helpers: invitation parsing, occurrence merge and cancel', () => {
  const inv = parseInvitation(vcal('REQUEST', [WEEKLY]))!;
  assert.equal(inv.method, 'REQUEST');
  assert.equal(inv.uid, 'series');
  assert.equal(inv.master?.rrule, 'FREQ=WEEKLY;COUNT=6');
  assert.equal(parseInvitation(vcal('REQUEST', [event('a', '20261201T090000Z', '20261201T100000Z'), event('b', '20261201T090000Z', '20261201T100000Z')])), null, 'two UIDs');
  const occ = parseInvitation(vcal('CANCEL', [[`UID:series`, 'RECURRENCE-ID:20261208T093000Z']]))!;
  assert.equal(occ.master, null);
  assert.deepEqual(occ.recurrenceIds.map((d) => d.toISOString()), ['2026-12-08T09:30:00.000Z']);

  const stored = vcal('REQUEST', [WEEKLY]);
  const update = vcal('REQUEST', [event('series', '20261208T130000Z', '20261208T140000Z', ['RECURRENCE-ID:20261208T093000Z'])]);
  const merged = applyOccurrenceUpdates(stored, update)!;
  assert.equal((merged.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.equal((applyOccurrenceUpdates(merged, update)!.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'the same occurrence is replaced, not added');
  assert.equal(applyOccurrenceUpdates(update, update), null, 'no series master stored');

  assert.match(cancelOccurrences(stored, [new Date('2026-12-15T09:30:00Z')])!, /EXDATE:20261215T093000Z/);
  assert.equal(cancelOccurrences(vcal('REQUEST', [event('x', '20261201T090000Z', '20261201T100000Z')]), [new Date('2026-12-01T09:00:00Z')]), null);
  assert.equal(meetingFromCalendar('series', merged)?.rrule, 'FREQ=WEEKLY;COUNT=6');
});
