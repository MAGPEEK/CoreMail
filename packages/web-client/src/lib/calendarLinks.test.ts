import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarOccurrencePath, itemIdFromPath, occurrenceFromSearch } from './mailLinks.ts';

test('9.4: occurrence links of a series round-trip; invalid values are ignored', () => {
  const path = calendarOccurrencePath('ev1', '2026-03-10T09:00:00.000Z');
  assert.equal(path, '/calendar/event/ev1?occurrence=2026-03-10T09%3A00%3A00.000Z');
  const [pathname, search] = path.split('?');
  assert.equal(itemIdFromPath(pathname!, '/calendar/event/'), 'ev1');
  assert.equal(occurrenceFromSearch(`?${search}`), '2026-03-10T09:00:00.000Z');
  assert.equal(occurrenceFromSearch('?occurrence=garbage'), null);
  assert.equal(occurrenceFromSearch(''), null);
});
