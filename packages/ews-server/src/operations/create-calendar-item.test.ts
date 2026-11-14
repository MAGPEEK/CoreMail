import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

/** EWS CreateItem(CalendarItem) must persist allDay and write a valid, escaped iCal object. */
const created: Array<Record<string, unknown>> = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  calendar: { findFirst: async () => ({ id: 'cal1' }) },
  calendarEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      created.push(args.data);
      return { id: `ev${created.length}`, ...args.data };
    },
  },
};

const { createItem, resolveEwsCalendarRange } = await import('./create-item.js');
const { parseCalendarObject } = await import('@coremail/core/calendar');

test('resolveEwsCalendarRange: timed vs all-day (exclusive end), invalid input', () => {
  const timed = resolveEwsCalendarRange({ Subject: 'a', Start: '2026-01-01T10:00:00Z', End: '2026-01-01T11:00:00Z' });
  assert.equal(timed?.allDay, false);
  assert.equal(timed?.start.toISOString(), '2026-01-01T10:00:00.000Z');

  const day = resolveEwsCalendarRange({ Subject: 'a', IsAllDayEvent: 'true', Start: '2026-01-05T00:00:00Z', End: '2026-01-05T00:00:00Z' });
  assert.equal(day?.allDay, true);
  assert.equal(day?.end.toISOString(), '2026-01-06T00:00:00.000Z');

  assert.equal(resolveEwsCalendarRange({ Start: 'nope', End: 'nope' }), null);
  assert.equal(resolveEwsCalendarRange({ Start: '2026-01-02T00:00:00Z', End: '2026-01-01T00:00:00Z' }), null);
});

test('CreateItem stores allDay + a parseable iCal without line injection', async () => {
  const xml = await createItem({
    Items: {
      CalendarItem: {
        Subject: 'Offsite\r\nATTENDEE:mailto:evil@x.com',
        Location: 'Berlin, HQ',
        IsAllDayEvent: 'true',
        Start: '2026-03-02T00:00:00Z',
        End: '2026-03-04T00:00:00Z',
      },
    },
  }, { userId: 'alice', email: 'alice@example.com' } as Parameters<typeof createItem>[1]);
  assert.match(xml, /NoError/);
  const row = created[0]!;
  assert.equal(row['allDay'], true);
  const parsed = parseCalendarObject(String(row['icalData']))!;
  assert.equal(parsed.main.allDay, true);
  assert.equal(parsed.main.end.toISOString(), '2026-03-04T00:00:00.000Z');
  assert.equal(parsed.main.location, 'Berlin, HQ');
  assert.equal(parsed.main.attendees.length, 0);
  assert.equal(parsed.main.uid, row['uid']);
});
