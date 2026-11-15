/**
 * `coremail audit verify` — signature normalisation and the API call.
 * Run: node --import tsx --test src/commands/audit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSignature, verifyExport, VERIFY_EXPORT_PATH } from './audit.js';

const HEX = 'ab'.repeat(32);

test('normalizeSignature accepts header value, bare hex and a pasted header line', () => {
  assert.equal(normalizeSignature(`hmac-sha256=${HEX}`), `hmac-sha256=${HEX}`);
  assert.equal(normalizeSignature(HEX.toUpperCase()), `hmac-sha256=${HEX}`);
  assert.equal(normalizeSignature(`X-CoreMail-Signature: hmac-sha256=${HEX}\n`), `hmac-sha256=${HEX}`);
  assert.throws(() => normalizeSignature('sha256=abc'), /--signature/);
});

test('verifyExport posts the raw bytes with the signature header', async () => {
  const calls: Array<{ path: string; bytes: Uint8Array; headers: Record<string, string> }> = [];
  const fake = {
    postRaw: async <T>(path: string, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<T> => {
      calls.push({ path, bytes, headers });
      return { valid: true, bytes: bytes.length } as T;
    },
  };
  const r = await verifyExport(fake, Buffer.from('﻿a,b\n'), HEX);
  assert.equal(r.valid, true);
  assert.equal(calls[0]!.path, VERIFY_EXPORT_PATH);
  assert.equal(calls[0]!.headers['X-CoreMail-Signature'], `hmac-sha256=${HEX}`);
  assert.deepEqual([...calls[0]!.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'bytes unchanged (BOM kept)');
});
