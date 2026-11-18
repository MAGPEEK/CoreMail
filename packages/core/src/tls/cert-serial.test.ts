import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certSerialHexFromBytes, randomCertSerialHex } from './cert-serial.js';

/** Positive and minimal as a DER INTEGER: first byte 0x01..0x7F (no sign byte, no padding). */
function assertPositiveMinimal(hex: string, length: number): void {
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(hex.length, length * 2, hex);
  const first = parseInt(hex.slice(0, 2), 16);
  assert.ok(first >= 0x01 && first <= 0x7f, `first byte 0x${hex.slice(0, 2)} of ${hex}`);
}

test('random serials are 16 bytes, positive and minimally encoded (5000 runs)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const hex = randomCertSerialHex();
    assertPositiveMinimal(hex, 16);
    seen.add(hex);
  }
  assert.equal(seen.size, 5000, 'serials are unique');
});

test('every possible first byte maps into 0x01..0x7F; the rest is kept', () => {
  for (let b = 0; b <= 0xff; b++) {
    for (const second of [0x00, 0x7f, 0x80, 0xff]) {
      const bytes = new Uint8Array(16).fill(0xab);
      bytes[0] = b;
      bytes[1] = second;
      const hex = certSerialHexFromBytes(bytes);
      assertPositiveMinimal(hex, 16);
      assert.equal(hex.slice(2, 4), second.toString(16).padStart(2, '0'));
      assert.equal(hex.slice(4), 'ab'.repeat(14));
    }
  }
});

test('edge-case random sources (all zero, all 0xFF, 0x80 lead) give valid serials of the requested length', () => {
  for (const fill of [0x00, 0x80, 0xff]) {
    for (const len of [16, 20]) {
      assertPositiveMinimal(randomCertSerialHex(len, (n) => new Uint8Array(n).fill(fill)), len);
    }
  }
});

test('the caller cannot ask for a serial shorter than 16 or longer than 20 bytes', () => {
  assert.throws(() => randomCertSerialHex(15), RangeError);
  assert.throws(() => randomCertSerialHex(21), RangeError);
  assert.throws(() => certSerialHexFromBytes(new Uint8Array(8)), RangeError);
});

test('the input buffer is not modified', () => {
  const bytes = new Uint8Array(16).fill(0xff);
  certSerialHexFromBytes(bytes);
  assert.equal(bytes[0], 0xff);
});
