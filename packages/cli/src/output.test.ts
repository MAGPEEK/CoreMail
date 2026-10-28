import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, parseBytes } from './output.js';

test('parseBytes versteht Einheiten', () => {
  assert.equal(parseBytes('5GB'), 5 * 1024 ** 3);
  assert.equal(parseBytes('500 mb'), 500 * 1024 ** 2);
  assert.equal(parseBytes('1024'), 1024);
  assert.equal(parseBytes('1.5G'), Math.round(1.5 * 1024 ** 3));
  assert.throws(() => parseBytes('abc'));
});

test('formatBytes rundet lesbar', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes('2048'), '2.0 KB');
});
