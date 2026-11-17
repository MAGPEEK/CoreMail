import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOverflow, menuKeyIntent, nextRovingIndex } from './toolbarNav.ts';

test('roving focus: arrows wrap, Home/End jump, other keys are ignored', () => {
  assert.equal(nextRovingIndex(0, 'ArrowRight', 4, 'horizontal'), 1);
  assert.equal(nextRovingIndex(3, 'ArrowRight', 4, 'horizontal'), 0, 'wraps to the first');
  assert.equal(nextRovingIndex(0, 'ArrowLeft', 4, 'horizontal'), 3, 'wraps to the last');
  assert.equal(nextRovingIndex(2, 'Home', 4, 'horizontal'), 0);
  assert.equal(nextRovingIndex(1, 'End', 4, 'horizontal'), 3);
  assert.equal(nextRovingIndex(-1, 'ArrowRight', 4, 'horizontal'), 0, 'nothing focused → first');
  assert.equal(nextRovingIndex(1, 'ArrowDown', 4, 'horizontal'), null, 'vertical keys stay with the page');
  assert.equal(nextRovingIndex(1, 'Tab', 4, 'horizontal'), null);
  assert.equal(nextRovingIndex(1, 'ArrowDown', 4, 'vertical'), 2);
  assert.equal(nextRovingIndex(1, 'ArrowRight', 4, 'vertical'), null);
  assert.equal(nextRovingIndex(1, 'ArrowUp', 4, 'both'), 0);
  assert.equal(nextRovingIndex(1, 'ArrowRight', 4, 'both'), 2);
  assert.equal(nextRovingIndex(0, 'ArrowRight', 0, 'both'), null, 'empty toolbar');
});

test('overflow: everything fits → no "…" menu', () => {
  const r = computeOverflow({ widths: [100, 80, 80], placements: ['auto', 'auto', 'auto'], available: 260, overflowButtonWidth: 32 });
  assert.deepEqual(r, [true, true, true]);
});

test('overflow: the tail moves to "…" and the button width is reserved', () => {
  // 290 available − 32 for "…" = 258 → 100 + 80 fit, 80 more does not
  const r = computeOverflow({ widths: [100, 80, 80, 40], placements: ['auto', 'auto', 'auto', 'auto'], available: 290, overflowButtonWidth: 32 });
  assert.deepEqual(r, [true, true, false, false]);
});

test('overflow: order is kept — a small later command does not jump ahead', () => {
  const r = computeOverflow({ widths: [100, 200, 20], placements: ['auto', 'auto', 'auto'], available: 200, overflowButtonWidth: 32 });
  assert.deepEqual(r, [true, false, false]);
});

test('overflow: pinned commands stay visible, forced ones always go to the menu', () => {
  const pinnedTooWide = computeOverflow({ widths: [150, 80], placements: ['pinned', 'auto'], available: 120, overflowButtonWidth: 32 });
  assert.deepEqual(pinnedTooWide, [true, false]);
  const forced = computeOverflow({ widths: [60, 60, 60, 60], placements: ['pinned', 'pinned', 'pinned', 'overflow'], available: 1000, overflowButtonWidth: 32 });
  assert.deepEqual(forced, [true, true, true, false], 'reading-pane "…" menu');
  const mixed = computeOverflow({ widths: [100, 50, 50, 50], placements: ['pinned', 'auto', 'overflow', 'auto'], available: 240, overflowButtonWidth: 32 });
  assert.deepEqual(mixed, [true, true, false, true], '240 − 32 − 100 = 108 → both autos fit, the forced one is not a cut');
  const tight = computeOverflow({ widths: [100, 50, 50, 50], placements: ['pinned', 'auto', 'overflow', 'auto'], available: 200, overflowButtonWidth: 32 });
  assert.deepEqual(tight, [true, true, false, false], '68 left → one auto fits');
});

test('menu keys: arrows move, → opens a submenu, ← / Escape leave it, Escape / Tab close the menu', () => {
  const top = { current: 1, count: 3, canOpen: false, isSubmenu: false };
  const sub = { ...top, isSubmenu: true };
  assert.deepEqual(menuKeyIntent('ArrowDown', top), { kind: 'move', index: 2 });
  assert.deepEqual(menuKeyIntent('ArrowUp', { ...top, current: 0 }), { kind: 'move', index: 2 }, 'wraps');
  assert.deepEqual(menuKeyIntent('End', top), { kind: 'move', index: 2 });
  assert.deepEqual(menuKeyIntent('ArrowRight', { ...top, canOpen: true }), { kind: 'open' });
  assert.equal(menuKeyIntent('ArrowRight', top), null, 'no submenu → nothing');
  assert.equal(menuKeyIntent('ArrowLeft', top), null, 'top level has no parent');
  assert.deepEqual(menuKeyIntent('ArrowLeft', sub), { kind: 'back' });
  assert.deepEqual(menuKeyIntent('Escape', sub), { kind: 'back' }, 'Escape in a submenu closes only the submenu');
  assert.deepEqual(menuKeyIntent('Escape', top), { kind: 'close' });
  assert.deepEqual(menuKeyIntent('Tab', sub), { kind: 'close' }, 'Tab leaves every level');
  assert.equal(menuKeyIntent('e', top), null);
});
