import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampNumber } from './numberInput.ts';

test('clampNumber: in range kept, out of range clamped, invalid keeps the previous value', () => {
  assert.equal(clampNumber('15', 5, 25, 20), 15);
  assert.equal(clampNumber('1', 5, 25, 20), 5);
  assert.equal(clampNumber('99', 5, 25, 20), 25);
  assert.equal(clampNumber('', 5, 25, 20), 20);
  assert.equal(clampNumber('abc', 1, 50, 50), 50);
});
