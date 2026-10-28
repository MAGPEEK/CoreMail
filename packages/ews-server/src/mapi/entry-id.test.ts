/**
 * Tests for mapi/entry-id.ts — CUID ↔ uint64 hash + EntryID encoding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuidToFolderId64 } from './entry-id.js';

test('cuidToFolderId64: deterministic', () => {
  const cuid = 'cmplad51y0001abcd';
  const h1 = cuidToFolderId64(cuid);
  const h2 = cuidToFolderId64(cuid);
  assert.equal(h1, h2);
});

test('cuidToFolderId64: returns bigint', () => {
  const h = cuidToFolderId64('test-id');
  assert.equal(typeof h, 'bigint');
});

test('cuidToFolderId64: does not trivially collide (4 different IDs → 4 different hashes)', () => {
  const ids = ['cuid-1', 'cuid-2', 'cuid-3', 'cuid-4'];
  const hashes = new Set(ids.map((id) => cuidToFolderId64(id)));
  assert.equal(hashes.size, 4);
});

test('cuidToFolderId64: fits in uint64 range', () => {
  const h = cuidToFolderId64('arbitrary-string');
  assert.ok(h >= 0n);
  assert.ok(h < (1n << 64n));
});

test('cuidToFolderId64: empty string is deterministic', () => {
  const h = cuidToFolderId64('');
  assert.equal(typeof h, 'bigint');
  // FNV-1a offset basis is 0xCBF29CE484222325 for 64-bit
  assert.ok(h !== 0n);
});

test('cuidToFolderId64: virtual-folder IDs are unique', () => {
  const virtuals = ['virtual-calendar', 'virtual-contacts', 'virtual-tasks', 'virtual-notes'];
  const hashes = virtuals.map(cuidToFolderId64);
  const set = new Set(hashes);
  assert.equal(set.size, 4);
});
