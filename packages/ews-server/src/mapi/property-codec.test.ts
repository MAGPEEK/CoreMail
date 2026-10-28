/**
 * Tests für mapi/property-codec.ts — Round-Trip-Validation für die
 * Property-Value-Encoder/Decoder die in allen ROP-Handlern verwendet werden.
 *
 * Ausführung: pnpm --filter @coremail/ews-server exec tsx --test src/mapi/property-codec.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapiReader, MapiWriter } from './codec.js';
import {
  writePropertyValue, readPropertyValue,
  writeTaggedProperty, writePropertyRow,
  dateToFiletime, filetimeToDate,
} from './property-codec.js';
import { PropType, makePropTag, PR } from './rop-types.js';

test('FILETIME ↔ Date round-trip', () => {
  const d = new Date('2026-05-27T12:34:56.000Z');
  const ft = dateToFiletime(d);
  const back = filetimeToDate(ft);
  assert.equal(back.getTime(), d.getTime());
});

test('FILETIME: 1601-01-01 → 0n', () => {
  const epoch = new Date(Date.UTC(1601, 0, 1));
  assert.equal(dateToFiletime(epoch), 0n);
});

test('PT_LONG round-trip', () => {
  const w = new MapiWriter();
  writePropertyValue(w, PropType.Int32, 42);
  const r = new MapiReader(w.toBuffer());
  assert.equal(readPropertyValue(r, PropType.Int32), 42);
});

test('PT_INT64 round-trip', () => {
  const w = new MapiWriter();
  writePropertyValue(w, PropType.Int64, 9007199254740993n);
  const r = new MapiReader(w.toBuffer());
  assert.equal(readPropertyValue(r, PropType.Int64), 9007199254740993n);
});

test('PT_BOOLEAN round-trip', () => {
  for (const v of [true, false]) {
    const w = new MapiWriter();
    writePropertyValue(w, PropType.Boolean, v);
    const r = new MapiReader(w.toBuffer());
    assert.equal(readPropertyValue(r, PropType.Boolean), v);
  }
});

test('PT_UNICODE round-trip (mit Umlauten und Emojis)', () => {
  const tests = ['', 'hello', 'Grüße aus München', '日本語テスト', '😀 Emoji'];
  for (const s of tests) {
    const w = new MapiWriter();
    writePropertyValue(w, PropType.Unicode, s);
    const r = new MapiReader(w.toBuffer());
    assert.equal(readPropertyValue(r, PropType.Unicode), s);
  }
});

test('PT_BINARY round-trip', () => {
  const data = Buffer.from([0x00, 0x01, 0xFF, 0x42, 0xAB]);
  const w = new MapiWriter();
  writePropertyValue(w, PropType.Binary, data);
  const r = new MapiReader(w.toBuffer());
  const back = readPropertyValue(r, PropType.Binary) as Buffer;
  assert.deepEqual([...back], [...data]);
});

test('PT_SYSTIME via Date', () => {
  const d = new Date('2026-05-27T08:15:00.000Z');
  const w = new MapiWriter();
  writePropertyValue(w, PropType.SysTime, d);
  const r = new MapiReader(w.toBuffer());
  const back = readPropertyValue(r, PropType.SysTime) as Date;
  assert.equal(back.getTime(), d.getTime());
});

test('writeTaggedProperty: Tag + Value', () => {
  const w = new MapiWriter();
  writeTaggedProperty(w, PR.PR_SUBJECT_W, 'Test Subject');
  const buf = w.toBuffer();
  // Tag = uint32 little-endian, value = UTF-16LE + null-term
  const r = new MapiReader(buf);
  const tag = r.readUint32();
  assert.equal(tag, PR.PR_SUBJECT_W);
  assert.equal(readPropertyValue(r, PropType.Unicode), 'Test Subject');
});

test('writePropertyRow: Multi-Column-Mapping', () => {
  const cols = [PR.PR_SUBJECT_W, PR.PR_MESSAGE_FLAGS, PR.PR_MESSAGE_SIZE];
  const values = new Map<number, unknown>([
    [PR.PR_SUBJECT_W, 'Hallo'],
    [PR.PR_MESSAGE_FLAGS, 0x01],
    [PR.PR_MESSAGE_SIZE, 1024],
  ]);
  const w = new MapiWriter();
  writePropertyRow(w, cols, values);
  const buf = w.toBuffer();
  const r = new MapiReader(buf);
  // Erst Flag-Byte (0 = no errors)
  assert.equal(r.readUint8(), 0);
  assert.equal(readPropertyValue(r, PropType.Unicode), 'Hallo');
  assert.equal(readPropertyValue(r, PropType.Int32), 0x01);
  assert.equal(readPropertyValue(r, PropType.Int32), 1024);
});

test('writePropertyRow: missing value → Default-für-Type', () => {
  const cols = [PR.PR_SUBJECT_W, PR.PR_MESSAGE_FLAGS];
  const values = new Map<number, unknown>([
    [PR.PR_SUBJECT_W, 'OnlyOne'],
    // PR_MESSAGE_FLAGS fehlt — sollte als 0 geschrieben werden
  ]);
  const w = new MapiWriter();
  writePropertyRow(w, cols, values);
  const r = new MapiReader(w.toBuffer());
  r.readUint8(); // flag-byte
  assert.equal(readPropertyValue(r, PropType.Unicode), 'OnlyOne');
  assert.equal(readPropertyValue(r, PropType.Int32), 0);
});

test('makePropTag: PR_DISPLAY_NAME_W = 0x3001001F', () => {
  assert.equal(makePropTag(0x3001, PropType.Unicode), 0x3001001F);
});

test('makePropTag: PR_FOLDER_ID = 0x67480014', () => {
  assert.equal(makePropTag(0x6748, PropType.Int64), 0x67480014);
});
