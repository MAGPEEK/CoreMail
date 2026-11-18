/**
 * Wire format: reader/writer, DIRECT2 decompression (MS-OXCRPC 3.1.4.1.1.2),
 * RPC_HEADER_EXT extended buffers (2.2.2.1) and the MAPI identifiers
 * (MS-OXCDATA 2.2.1 / 2.2.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferReader, WireFormatError } from './reader.js';
import { BufferWriter } from './writer.js';
import { decompressDirect2 } from './lz77.js';
import { readExtendedBuffer, writeExtendedBuffer, xorMagic } from './extended-buffer.js';
import {
  makeId, globcntOf, replidOf, folderEntryId, messageEntryId, parseEntryId, storeGuids, folderCounterForRow,
  addressBookEntryId,
} from '../ids.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('reader/writer round trip of every primitive', () => {
  const buf = new BufferWriter(4).u8(0xab).u16(0x1234).u32(0xdeadbeef).i32(-2).u64(0x0102030405060708n)
    .asciiZ('abc').utf16Z('Grüße').f64(1.5).toBuffer();
  const r = new BufferReader(buf);
  assert.equal(r.u8(), 0xab);
  assert.equal(r.u16(), 0x1234);
  assert.equal(r.u32(), 0xdeadbeef);
  assert.equal(r.i32(), -2);
  assert.equal(r.u64(), 0x0102030405060708n);
  assert.equal(r.asciiZ(), 'abc');
  assert.equal(r.utf16Z(), 'Grüße');
  assert.equal(r.f64(), 1.5);
  assert.equal(r.atEnd, true);
});

test('reader: past-the-end reads and unterminated strings are WireFormatError', () => {
  assert.throws(() => new BufferReader(Buffer.from([1])).u16(), WireFormatError);
  assert.throws(() => new BufferReader(Buffer.from('ab')).asciiZ(), WireFormatError);
  assert.throws(() => new BufferReader(Buffer.from([0x41, 0x00, 0x42])).utf16Z(), WireFormatError);
  assert.throws(() => new BufferReader(Buffer.alloc(2)).bytes(3), WireFormatError);
});

test('writer: patchU16 rewrites a size field', () => {
  const w = new BufferWriter(2).u16(0).u32(7);
  w.patchU16(0, 0xbeef);
  assert.deepEqual(w.toBuffer(), hex('efbe 07000000'));
});

test('DIRECT2: literals + an overlapping match ("abc" then offset 3, length 9)', () => {
  // bitmask 0x18000000: 3 literal bits, a match bit, the end bit
  const input = hex('00000018 616263 1600');
  assert.equal(decompressDirect2(input, 12).toString(), 'abcabcabcabc');
});

test('DIRECT2: length 24 via the shared nibble', () => {
  const input = hex('00000060 61 0700 0e');
  assert.equal(decompressDirect2(input, 25).toString(), 'a'.repeat(25));
});

test('DIRECT2: length 280 via nibble 15, byte 255 and the 16-bit length', () => {
  const input = hex('00000060 61 0700 0f ff 1501');
  assert.equal(decompressDirect2(input, 281).toString(), 'a'.repeat(281));
});

test('DIRECT2: the high nibble of the shared byte serves the next long match', () => {
  // 'a', match(1,10) [low nibble 0], 'b', match(1,11) [high nibble 1]
  const input = hex('00000058 61 0700 10 62 0700');
  assert.equal(decompressDirect2(input, 23).toString(), 'a'.repeat(11) + 'b'.repeat(12));
});

test('DIRECT2: malformed input is rejected', () => {
  assert.throws(() => decompressDirect2(hex('00000018 616263 1600'), 11), WireFormatError, 'longer than announced');
  assert.throws(() => decompressDirect2(hex('00000080 0800'), 3), WireFormatError, 'offset before start');
  assert.throws(() => decompressDirect2(hex('000000'), 1), WireFormatError, 'truncated bitmask');
});

test('extended buffer: plain payload round trip with the Last flag', () => {
  const payload = Buffer.from('rop-payload');
  const ext = writeExtendedBuffer(payload);
  assert.deepEqual(ext.subarray(0, 8), hex('0000 0400 0b00 0b00'));
  assert.deepEqual(readExtendedBuffer(ext), payload);
});

test('extended buffer: XorMagic payloads are reverted', () => {
  const payload = Buffer.from('secret');
  const ext = Buffer.concat([hex('0000 0600 0600 0600'), xorMagic(payload)]);
  assert.deepEqual(readExtendedBuffer(ext), payload);
});

test('extended buffer: compressed (and compressed + obfuscated) payloads are inflated', () => {
  const compressed = hex('00000018 616263 1600');
  const plain = Buffer.concat([hex('0000 0500 0900 0c00'), compressed]);
  assert.equal(readExtendedBuffer(plain).toString(), 'abcabcabcabc');
  const both = Buffer.concat([hex('0000 0700 0900 0c00'), xorMagic(compressed)]);
  assert.equal(readExtendedBuffer(both).toString(), 'abcabcabcabc');
});

test('extended buffer: wrong version, missing Last, size mismatch are rejected', () => {
  assert.throws(() => readExtendedBuffer(hex('0100 0400 0000 0000')), WireFormatError);
  assert.throws(() => readExtendedBuffer(hex('0000 0000 0100 0100 41')), WireFormatError);
  assert.throws(() => readExtendedBuffer(hex('0000 0400 0200 0200 41')), WireFormatError);
  assert.throws(() => readExtendedBuffer(hex('0000 0400 0100 0200 41')), WireFormatError);
  assert.throws(() => writeExtendedBuffer(Buffer.alloc(0x8001)), RangeError);
});

test('ids: replica id first (LE), global counter big-endian (MS-OXCDATA 2.2.1.1)', () => {
  const id = makeId(0x000000000102n);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(id);
  assert.deepEqual(b, hex('0100 000000000102'));
  assert.equal(globcntOf(id), 0x102n);
  assert.equal(replidOf(id), 1);
});

test('ids: database folder counters are stable, high-bit and distinct', () => {
  const a = folderCounterForRow('cfolderA');
  assert.equal(a, folderCounterForRow('cfolderA'));
  assert.notEqual(a, folderCounterForRow('cfolderB'));
  assert.ok(a >= 0x8000_0000_0000n && a <= 0xffff_ffff_ffffn);
});

test('ids: folder and message EntryIDs round trip and are bound to their store', () => {
  const g = storeGuids('mailbox-1');
  const fe = folderEntryId(g, 0x1234n);
  assert.equal(fe.length, 46);
  assert.equal(fe.readUInt16LE(20), 0x0001);
  assert.deepEqual(parseEntryId(g, fe), { kind: 'folder', folder: 0x1234n });
  const me = messageEntryId(g, 0x1234n, 77n);
  assert.equal(me.length, 70);
  assert.deepEqual(parseEntryId(g, me), { kind: 'message', folder: 0x1234n, message: 77n });
  assert.equal(parseEntryId(storeGuids('mailbox-2'), fe), null);
  assert.equal(parseEntryId(g, Buffer.alloc(10)), null);
});

test('ids: address book EntryID carries the provider UID and the X500 DN', () => {
  const e = addressBookEntryId('/o=X/cn=y');
  assert.deepEqual(e.subarray(4, 20), hex('dca740c8c042101ab4b908002b2fe182'));
  assert.equal(e.readUInt32LE(20), 1);
  assert.equal(e.subarray(28).toString('ascii'), '/o=X/cn=y\u0000');
});
