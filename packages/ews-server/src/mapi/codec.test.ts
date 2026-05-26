/**
 * Tests für mapi/codec.ts — Round-Trip-Validation für alle Read/Write-Pairs.
 *
 * Ausführung: pnpm --filter @coremail/ews-server exec node --test src/mapi/codec.test.ts
 * (TypeScript wird durch tsx oder ähnlich vorab kompiliert).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapiReader, MapiWriter, MapiStatusCode } from './codec.js';

test('MapiWriter.toBuffer() returns concatenated chunks', () => {
  const w = new MapiWriter();
  w.writeUint8(0x42);
  w.writeUint32(0xDEADBEEF);
  const buf = w.toBuffer();
  assert.equal(buf.length, 5);
  assert.equal(buf[0], 0x42);
  // Little-Endian: 0xDEADBEEF → EF BE AD DE
  assert.equal(buf[1], 0xEF);
  assert.equal(buf[2], 0xBE);
  assert.equal(buf[3], 0xAD);
  assert.equal(buf[4], 0xDE);
});

test('Uint8 round-trip', () => {
  const values = [0, 1, 127, 128, 200, 255];
  for (const v of values) {
    const w = new MapiWriter();
    w.writeUint8(v);
    const r = new MapiReader(w.toBuffer());
    assert.equal(r.readUint8(), v);
    assert.equal(r.remaining, 0);
  }
});

test('Uint16 round-trip (Little-Endian)', () => {
  const values = [0, 1, 256, 0x1234, 0xABCD, 0xFFFF];
  for (const v of values) {
    const w = new MapiWriter();
    w.writeUint16(v);
    const r = new MapiReader(w.toBuffer());
    assert.equal(r.readUint16(), v);
  }
});

test('Uint32 round-trip', () => {
  const values = [0, 1, 0x10000, 0xDEADBEEF, 0xFFFFFFFF];
  for (const v of values) {
    const w = new MapiWriter();
    w.writeUint32(v);
    const r = new MapiReader(w.toBuffer());
    assert.equal(r.readUint32(), v);
  }
});

test('Uint64 round-trip (BigInt)', () => {
  const values = [
    0n,
    1n,
    0xFFFFFFFFn,
    0x100000000n,
    0xFEDCBA9876543210n,
    0xFFFFFFFFFFFFFFFFn,
  ];
  for (const v of values) {
    const w = new MapiWriter();
    w.writeUint64(v);
    const r = new MapiReader(w.toBuffer());
    assert.equal(r.readUint64(), v);
  }
});

test('ASCII string round-trip with null-terminator', () => {
  const cases = ['', 'Hello', 'admin@stefanwuestner.de', '/o=CoreMail/cn=Recipients/cn=admin'];
  for (const s of cases) {
    const w = new MapiWriter();
    w.writeAsciiString(s);
    const buf = w.toBuffer();
    // Erwartete Länge: s.length + 1 (null-Byte)
    assert.equal(buf.length, s.length + 1);
    assert.equal(buf[buf.length - 1], 0, 'last byte must be null terminator');
    const r = new MapiReader(buf);
    assert.equal(r.readAsciiString(), s);
    assert.equal(r.remaining, 0);
  }
});

test('UTF-16-LE string round-trip with null-terminator', () => {
  const cases = ['', 'Hallo', 'Müller', 'Ευρώπη', '日本語', 'admin@stefanwüstner.de'];
  for (const s of cases) {
    const w = new MapiWriter();
    w.writeUtf16String(s);
    const buf = w.toBuffer();
    // Erwartete Länge: s.length * 2 + 2 (UTF-16 + 2-Byte-Null)
    assert.equal(buf.length, s.length * 2 + 2);
    const r = new MapiReader(buf);
    assert.equal(r.readUtf16String(), s);
  }
});

test('GUID round-trip via Buffer', () => {
  const guid = Buffer.from('aabbccddeeff00112233445566778899', 'hex');
  const w = new MapiWriter();
  w.writeGuid(guid);
  const buf = w.toBuffer();
  assert.equal(buf.length, 16);
  const r = new MapiReader(buf);
  const read = r.readGuid();
  assert.deepEqual(read, guid);
});

test('GUID round-trip via String', () => {
  const guidStr = 'a3b4c5d6-1122-3344-5566-77889900aabb';
  const w = new MapiWriter();
  w.writeGuidString(guidStr);
  const r = new MapiReader(w.toBuffer());
  assert.equal(r.readGuidString(), guidStr);
});

test('GUID writeGuidString rejects malformed input', () => {
  const w = new MapiWriter();
  assert.throws(() => w.writeGuidString('not-a-guid'), TypeError);
  assert.throws(() => w.writeGuidString(''), TypeError);
});

test('MapiReader throws RangeError on over-read', () => {
  const r = new MapiReader(Buffer.from([0x01, 0x02]));
  r.readUint8();
  r.readUint8();
  assert.throws(() => r.readUint8(), RangeError);
});

test('MapiReader.seek() to position', () => {
  const r = new MapiReader(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  r.readUint32();
  assert.equal(r.remaining, 0);
  r.seek(0);
  assert.equal(r.readUint32(), 0x04030201); // LE
});

test('MapiReader.seek() throws on out-of-range', () => {
  const r = new MapiReader(Buffer.from([0x01]));
  assert.throws(() => r.seek(-1), RangeError);
  assert.throws(() => r.seek(2), RangeError);
});

test('readBuffer / writeBuffer round-trip', () => {
  const inner = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
  const w = new MapiWriter();
  w.writeUint16(inner.length);
  w.writeBuffer(inner);
  const r = new MapiReader(w.toBuffer());
  const sz = r.readUint16();
  assert.equal(sz, 4);
  assert.deepEqual(r.readBuffer(sz), inner);
});

test('Complex Connect-Request-like sequence', () => {
  // Simulates: UserDn + Flags + DefaultCodePage + LcidString + LcidSort
  const w = new MapiWriter();
  w.writeAsciiString('/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=admin');
  w.writeUint32(0);            // Flags
  w.writeUint32(1252);         // DefaultCodePage
  w.writeUint32(0x0409);       // LcidString = en-US
  w.writeUint32(0x0409);       // LcidSort
  const r = new MapiReader(w.toBuffer());
  assert.equal(r.readAsciiString(),
    '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=admin');
  assert.equal(r.readUint32(), 0);
  assert.equal(r.readUint32(), 1252);
  assert.equal(r.readUint32(), 0x0409);
  assert.equal(r.readUint32(), 0x0409);
  assert.equal(r.remaining, 0);
});

test('MapiStatusCode constants are exported correctly', () => {
  assert.equal(MapiStatusCode.SUCCESS, 0);
  assert.equal(MapiStatusCode.EC_NOT_SUPPORTED, 0x80040102);
});
