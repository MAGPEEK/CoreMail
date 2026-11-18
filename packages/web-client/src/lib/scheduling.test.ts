import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barPosition, suggestionNote, timelineHours } from './scheduling.ts';

const vs = new Date('2026-03-11T07:00:00Z');
const ve = new Date('2026-03-11T17:00:00Z');

test('barPosition: inside, clipped at the edges, outside', () => {
  assert.deepEqual(barPosition('2026-03-11T09:00:00Z', '2026-03-11T10:00:00Z', vs, ve), { left: 20, width: 10 });
  assert.deepEqual(barPosition('2026-03-11T05:00:00Z', '2026-03-11T08:00:00Z', vs, ve), { left: 0, width: 10 });
  assert.deepEqual(barPosition('2026-03-11T16:30:00Z', '2026-03-11T20:00:00Z', vs, ve), { left: 95, width: 5 });
  assert.equal(barPosition('2026-03-11T18:00:00Z', '2026-03-11T19:00:00Z', vs, ve), null);
  assert.equal(barPosition('2026-03-11T09:00:00Z', '2026-03-11T09:00:00Z', vs, ve), null);
});

test('timelineHours: work day, widened to the slot, at least 8 hours', () => {
  assert.deepEqual(timelineHours('08:00', '17:00', 10, 11), { from: 8, to: 17 });
  assert.deepEqual(timelineHours('08:00', '17:30', 18, 19.5), { from: 8, to: 20 });
  assert.deepEqual(timelineHours('09:00', '12:00', 9, 10), { from: 9, to: 17 });
  assert.deepEqual(timelineHours('20:00', '23:00', 20, 21), { from: 16, to: 24 });
});

test('suggestionNote', () => {
  assert.equal(suggestionNote(0, 0), 'Alle verfügbar');
  assert.equal(suggestionNote(1, 0), '1 Konflikt');
  assert.equal(suggestionNote(2, 1), '2 Konflikte, 1 mit Vorbehalt');
});
