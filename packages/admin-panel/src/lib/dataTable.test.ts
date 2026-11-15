import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRows, sortRows, nextSort, ariaSort, compareValues, paginate, pageCount, clampPage, pageRange,
  toggleSelected, toggleAllVisible, selectionState, pruneSelection, nextRowIndex, searchTerms,
} from './dataTable.ts';

interface Row { id: string; name: string; email: string; size: number | null; created?: Date }
const rows: Row[] = [
  { id: 'a', name: 'Bob',   email: 'bob@ex.com',   size: 10,   created: new Date('2026-01-02') },
  { id: 'b', name: 'alice', email: 'alice@ex.com', size: 2,    created: new Date('2026-01-01') },
  { id: 'c', name: 'Carol', email: 'carol@other.org', size: null },
  { id: 'd', name: 'item 10', email: 'x@ex.com', size: 100 },
  { id: 'e', name: 'item 9',  email: 'y@ex.com', size: 2 },
];
const text = (r: Row) => [r.name, r.email];
const ids = (rs: Row[]) => rs.map((r) => r.id).join('');

test('search: case-insensitive, every term must match, blank query keeps all', () => {
  assert.equal(ids(filterRows(rows, '', text)), 'abcde');
  assert.equal(ids(filterRows(rows, '   ', text)), 'abcde');
  assert.equal(ids(filterRows(rows, 'ALICE', text)), 'b');
  assert.equal(ids(filterRows(rows, 'ex.com', text)), 'abde');
  assert.equal(ids(filterRows(rows, 'item ex.com', text)), 'de');
  assert.equal(ids(filterRows(rows, 'nomatch', text)), '');
  assert.deepEqual(searchTerms('  a  B '), ['a', 'b']);
  // terms must not match across field boundaries
  assert.equal(ids(filterRows([{ id: 'z', name: 'ab', email: 'cd', size: 0 }], 'bc', text)), '');
});

test('sort: strings (natural, case-insensitive), numbers, dates; asc/desc; stable', () => {
  assert.equal(ids(sortRows(rows, { key: 'name', dir: 'asc' }, (r) => r.name)), 'baced');
  assert.equal(ids(sortRows(rows, { key: 'name', dir: 'desc' }, (r) => r.name)), 'decab');
  assert.equal(ids(sortRows(rows, { key: 'size', dir: 'asc' }, (r) => r.size)), 'beadc', 'equal sizes keep input order; null last');
  assert.equal(ids(sortRows(rows, { key: 'size', dir: 'desc' }, (r) => r.size)), 'dabec', 'null stays last when descending');
  assert.equal(ids(sortRows(rows, { key: 'c', dir: 'asc' }, (r) => r.created)), 'bacde');
  assert.equal(ids(sortRows(rows, null, (r) => r.name)), 'abcde');
  assert.equal(compareValues(true, false), -1);
  assert.equal(compareValues(null, 'x'), 1);
});

test('nextSort cycles asc → desc → asc and resets on another column; ariaSort', () => {
  let s = nextSort(null, 'name');
  assert.deepEqual(s, { key: 'name', dir: 'asc' });
  s = nextSort(s, 'name');
  assert.deepEqual(s, { key: 'name', dir: 'desc' });
  assert.deepEqual(nextSort(s, 'name'), { key: 'name', dir: 'asc' });
  assert.deepEqual(nextSort(s, 'size'), { key: 'size', dir: 'asc' });
  assert.equal(ariaSort(s, 'name'), 'descending');
  assert.equal(ariaSort({ key: 'name', dir: 'asc' }, 'name'), 'ascending');
  assert.equal(ariaSort(s, 'size'), 'none');
  assert.equal(ariaSort(null, 'size'), 'none');
});

test('paging: page count, clamping, slices and range labels', () => {
  const many = Array.from({ length: 53 }, (_, i) => i);
  assert.equal(pageCount(53, 25), 3);
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(50, 25), 2);
  assert.deepEqual(paginate(many, 1, 25).slice(0, 2), [0, 1]);
  assert.deepEqual(paginate(many, 3, 25), [50, 51, 52]);
  assert.deepEqual(paginate(many, 99, 25), [50, 51, 52], 'out-of-range page is clamped');
  assert.deepEqual(paginate(many, 0, 25).length, 25);
  assert.equal(clampPage(Number.NaN, 53, 25), 1);
  assert.deepEqual(pageRange(2, 25, 53), { from: 26, to: 50, total: 53 });
  assert.deepEqual(pageRange(3, 25, 53), { from: 51, to: 53, total: 53 });
  assert.deepEqual(pageRange(1, 25, 0), { from: 0, to: 0, total: 0 });
});

test('search → sort → paginate pipeline', () => {
  const visible = paginate(sortRows(filterRows(rows, 'ex.com', text), { key: 'size', dir: 'desc' }, (r) => r.size), 1, 2);
  assert.equal(ids(visible), 'da');
});

test('selection helpers', () => {
  let sel = toggleSelected(new Set(), 'a');
  assert.deepEqual([...sel], ['a']);
  sel = toggleSelected(sel, 'a');
  assert.equal(sel.size, 0);
  sel = toggleAllVisible(new Set(['x']), ['a', 'b']);
  assert.deepEqual([...sel].sort(), ['a', 'b', 'x']);
  assert.equal(selectionState(sel, ['a', 'b']), 'all');
  sel = toggleAllVisible(sel, ['a', 'b']);
  assert.deepEqual([...sel], ['x'], 'clearing the page keeps selections on other pages');
  assert.equal(selectionState(new Set(['a']), ['a', 'b']), 'some');
  assert.equal(selectionState(new Set(), []), 'none');
  assert.deepEqual([...pruneSelection(new Set(['a', 'gone']), ['a', 'b'])], ['a']);
});

test('keyboard row navigation', () => {
  assert.equal(nextRowIndex(-1, 'ArrowDown', 5), 0);
  assert.equal(nextRowIndex(0, 'ArrowDown', 5), 1);
  assert.equal(nextRowIndex(4, 'ArrowDown', 5), 4);
  assert.equal(nextRowIndex(0, 'ArrowUp', 5), 0);
  assert.equal(nextRowIndex(3, 'Home', 5), 0);
  assert.equal(nextRowIndex(1, 'End', 5), 4);
  assert.equal(nextRowIndex(1, 'PageDown', 30), 11);
  assert.equal(nextRowIndex(2, 'PageUp', 30), 0);
  assert.equal(nextRowIndex(1, 'a', 5), null);
  assert.equal(nextRowIndex(0, 'ArrowDown', 0), null);
});
