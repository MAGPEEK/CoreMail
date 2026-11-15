import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gbInputToBytes, bytesToGbInput } from './quotaInput.ts';

test('GB input → bytes: empty = server default (null), comma decimals, invalid = null', () => {
  assert.equal(gbInputToBytes(''), null);
  assert.equal(gbInputToBytes('  '), null);
  assert.equal(gbInputToBytes('1.9'), Math.round(1.9 * 1024 ** 3));
  assert.equal(gbInputToBytes('2,3'), Math.round(2.3 * 1024 ** 3));
  assert.equal(gbInputToBytes('abc'), null);
  assert.equal(gbInputToBytes('-1'), null);
});

test('bytes → GB input round-trips to two decimals', () => {
  assert.equal(bytesToGbInput(null), '');
  assert.equal(bytesToGbInput(undefined), '');
  assert.equal(bytesToGbInput(2 * 1024 ** 3), '2');
  assert.equal(bytesToGbInput(gbInputToBytes('1.9')), '1.9');
});
