import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gbInputToBytes, bytesToGbInput, gbInputValid, QUOTA_PRESETS, quotaOptions, quotaLabel } from './quotaInput.ts';

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

test('a typo in a quota-level field is invalid (not silently "server default")', () => {
  assert.equal(gbInputValid(''), true);
  assert.equal(gbInputValid('2,5'), true);
  assert.equal(gbInputValid('abc'), false);
  assert.equal(gbInputValid('-1'), false);
});

test('quota options: 0 = unlimited last; a non-preset current value is kept', () => {
  assert.equal(QUOTA_PRESETS.at(-1), 0);
  assert.deepEqual(quotaOptions(5 * 1024 ** 3), [...QUOTA_PRESETS]);
  const three = 3 * 1024 ** 3;
  const opts = quotaOptions(three);
  assert.ok(opts.includes(three));
  assert.equal(opts.at(-1), 0);
  assert.deepEqual(opts.slice(0, -1), [...opts.slice(0, -1)].sort((a, b) => a - b));
  assert.deepEqual(quotaOptions(0), [...QUOTA_PRESETS]);
  assert.deepEqual(quotaOptions(undefined), [...QUOTA_PRESETS]);
});

test('quota labels', () => {
  assert.equal(quotaLabel(0), null);
  assert.equal(quotaLabel(5 * 1024 ** 3), '5 GB');
  assert.equal(quotaLabel(1.5 * 1024 ** 3), '1.5 GB');
});
