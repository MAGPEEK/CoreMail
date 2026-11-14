import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPageOffset, flattenPages, pageQuery, MESSAGE_PAGE_SIZE } from './paging.ts';
import { toLocalInput, isoToLocalInput, localInputToIso } from './datetime.ts';

const page = (ids: string[], total: number) => ({ messages: ids.map((id) => ({ id })), total });

test('nextPageOffset: continues until total is reached', () => {
  const p1 = page(['a', 'b'], 5);
  assert.equal(nextPageOffset(p1, [p1]), 2);
  const p2 = page(['c', 'd'], 5);
  assert.equal(nextPageOffset(p2, [p1, p2]), 4);
  const p3 = page(['e'], 5);
  assert.equal(nextPageOffset(p3, [p1, p2, p3]), undefined);
});

test('nextPageOffset: empty page stops paging even if total is stale', () => {
  const p1 = page(['a'], 10);
  const p2 = page([], 10);
  assert.equal(nextPageOffset(p2, [p1, p2]), undefined);
});

test('flattenPages: keeps order and drops duplicates shifted between pages', () => {
  const out = flattenPages([page(['a', 'b'], 4), page(['b', 'c'], 4)]);
  assert.deepEqual(out.map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(flattenPages(undefined), []);
});

test('pageQuery', () => {
  assert.equal(pageQuery(0), `limit=${MESSAGE_PAGE_SIZE}&offset=0`);
  assert.equal(pageQuery(100, 25), 'limit=25&offset=100');
});

test('datetime-local helpers use local wall time, not UTC', () => {
  const d = new Date(2026, 10, 14, 9, 5); // 14 Nov 2026 09:05 local
  assert.equal(toLocalInput(d), '2026-11-14T09:05');
  assert.equal(localInputToIso('2026-11-14T09:05'), d.toISOString());
  assert.equal(isoToLocalInput(d.toISOString()), '2026-11-14T09:05');
  assert.equal(isoToLocalInput('garbage'), '');
  assert.equal(localInputToIso(''), '');
});
