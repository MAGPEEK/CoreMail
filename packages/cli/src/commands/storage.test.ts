/**
 * `coremail storage` helpers: driver validation and progress formatting.
 * Run: node --import tsx --test src/commands/storage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgress, validateDrivers } from './storage.js';

test('validateDrivers accepts minio/s3/filesystem pairs and rejects the rest', () => {
  validateDrivers('minio', 'filesystem');
  validateDrivers('filesystem', 's3');
  assert.throws(() => validateDrivers('minio', 'minio'), /must differ/);
  assert.throws(() => validateDrivers('ftp', 'filesystem'), /--from/);
  assert.throws(() => validateDrivers('minio', 'disk'), /--to/);
});

test('formatProgress summarises counts and bytes', () => {
  const line = formatProgress({
    phase: 'copying', dryRun: false, scanned: 10, copied: 7, skipped: 2, verified: 9, failed: 1,
    bytesScanned: 2048, bytesCopied: 1024, errors: [], startedAt: new Date().toISOString(),
  });
  assert.equal(line, '[copying] scanned 10 (2.0 KB), copied 7 (1.0 KB), already present 2, verified 9, failed 1');
  assert.match(formatProgress({ phase: 'done', dryRun: true, scanned: 1, copied: 1, skipped: 0, verified: 0, failed: 0, bytesScanned: 5, bytesCopied: 5, errors: [], startedAt: '' }), /to copy 1/);
});
