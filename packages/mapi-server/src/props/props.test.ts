/**
 * Property encoding (MS-OXCDATA 2.11), PropertyRow (2.8.1), restrictions
 * (2.12), PropertyName (2.6.1) and the property lookup rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { PropType, Tag, tag } from './tags.js';
import {
  readTaggedValue, writeTaggedValue, writePropValue, readPropValue, toFileTime, fromFileTime, propError,
} from './values.js';
import { lookupProperty, setProperty, stringProp, tagForUnicodePreference, type PropertyBag } from './bag.js';
import { readPropertyRow, writePropertyRow, NOT_FOUND } from './row.js';
import { evaluateRestriction, parseRestriction, RelOp, restrictionNodeCount } from './restriction.js';
import { NamedPropertyMap, NameKind, PS_INTERNET_HEADERS, PS_MAPI, readPropertyName, writePropertyName } from './named.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const bytes = (fn: (w: BufferWriter) => void): Buffer => { const w = new BufferWriter(); fn(w); return w.toBuffer(); };

test('TaggedPropertyValue bytes: PtypString subject, PtypInteger32, PtypBoolean, PtypBinary (16-bit count)', () => {
  assert.deepEqual(bytes((w) => writeTaggedValue(w, { tag: Tag.Subject, value: 'Hi' })), hex('1f003700 4800 6900 0000'));
  assert.deepEqual(bytes((w) => writeTaggedValue(w, { tag: Tag.MessageFlags, value: 9 })), hex('0300070e 09000000'));
  assert.deepEqual(bytes((w) => writeTaggedValue(w, { tag: Tag.HasAttachments, value: true })), hex('0b001b0e 01'));
  assert.deepEqual(bytes((w) => writeTaggedValue(w, { tag: Tag.EntryId, value: hex('aabb') })), hex('0201ff0f 0200 aabb'));
});

test('property values round trip for every supported type (multi-values with 32-bit counts)', () => {
  const cases: Array<[number, unknown]> = [
    [PropType.Integer16, 7], [PropType.Integer32, 0xfffffffe], [PropType.Floating64, 2.25],
    [PropType.Integer64, -5n], [PropType.Boolean, false], [PropType.String, 'Ünïcode'], [PropType.String8, 'latin'],
    [PropType.Time, new Date('2026-03-04T05:06:07.000Z')], [PropType.Guid, Buffer.alloc(16, 7)],
    [PropType.Binary, Buffer.from([1, 2, 3])], [PropType.MultipleString, ['a', 'b']], [PropType.MultipleInteger32, [1, 2]],
    [PropType.MultipleBinary, [Buffer.from([9]), Buffer.alloc(0)]],
  ];
  for (const [type, value] of cases) {
    const buf = bytes((w) => writePropValue(w, type, value as never));
    const back = readPropValue(new BufferReader(buf), type);
    assert.deepEqual(back, value, `type 0x${type.toString(16)}`);
  }
  assert.equal(bytes((w) => writePropValue(w, PropType.MultipleInteger32, [1])).readUInt32LE(0), 1);
});

test('FILETIME conversion (100 ns since 1601)', () => {
  const d = new Date('2001-01-01T00:00:00Z');
  assert.equal(toFileTime(d), 126227808000000000n);
  assert.equal(fromFileTime(126227808000000000n).toISOString(), d.toISOString());
});

test('lookup: by property id, String8/String conversion, Unspecified, type mismatch, errors', () => {
  const bag: PropertyBag = new Map();
  bag.set(Tag.Subject, 'Grüße €');
  bag.set(Tag.MessageSize, 10);
  bag.set(Tag.Body, propError(0x8007000e));
  assert.deepEqual(lookupProperty(bag, tag(0x0037, PropType.String8)), { found: true, tag: tag(0x0037, PropType.String8), value: 'Grüße ?' });
  assert.deepEqual(lookupProperty(bag, tag(0x0037, PropType.Unspecified)), { found: true, tag: Tag.Subject, value: 'Grüße €' });
  assert.deepEqual(lookupProperty(bag, tag(0x0e08, PropType.String)), { found: false });
  assert.deepEqual(lookupProperty(bag, Tag.Body), { found: true, tag: Tag.Body, error: 0x8007000e });
  assert.equal(tagForUnicodePreference(Tag.Subject, false), tag(0x0037, PropType.String8));
  setProperty(bag, tag(0x0037, PropType.String8), 'new');
  assert.equal(stringProp(bag, Tag.Subject), 'new');
  assert.equal([...bag.keys()].filter((t) => t >>> 16 === 0x0037).length, 1);
});

test('PropertyRow: standard row when every column has a value', () => {
  const bag: PropertyBag = new Map([[Tag.MessageFlags, 1], [Tag.Subject, 'S']]);
  const row = bytes((w) => writePropertyRow(w, [Tag.MessageFlags, Tag.Subject], (c) => lookupProperty(bag, c)));
  assert.deepEqual(row, hex('00 01000000 5300 0000'));
});

test('PropertyRow: flagged row with a missing column and an error column', () => {
  const bag: PropertyBag = new Map([[Tag.MessageFlags, 1], [Tag.Body, propError(0x8007000e)]]);
  const row = bytes((w) => writePropertyRow(w, [Tag.MessageFlags, Tag.Subject, Tag.Body], (c) => lookupProperty(bag, c)));
  assert.deepEqual(row, hex('01 00 01000000 0a 0f010480 0a 0e000780'));
  assert.equal(NOT_FOUND, 0x8004010f);
});

test('PropertyRow: PtypUnspecified columns carry the type (FlaggedPropertyValueWithType)', () => {
  const bag: PropertyBag = new Map([[Tag.MessageFlags, 5]]);
  const row = bytes((w) => writePropertyRow(w, [tag(0x0e07, PropType.Unspecified)], (c) => lookupProperty(bag, c)));
  assert.deepEqual(row, hex('01 0300 00 05000000'));
  const back = readPropertyRow(new BufferReader(row), [tag(0x0e07, PropType.Unspecified)]);
  assert.equal(back.get(Tag.MessageFlags), 5);
});

test('readPropertyRow: standard and flagged rows', () => {
  const cols = [Tag.SmtpAddress, Tag.RecipientType];
  const std = readPropertyRow(new BufferReader(hex('00 6100 0000 01000000')), cols);
  assert.equal(std.get(Tag.SmtpAddress), 'a');
  assert.equal(std.get(Tag.RecipientType), 1);
  const flagged = readPropertyRow(new BufferReader(hex('01 01 00 02000000')), cols);
  assert.equal(flagged.has(Tag.SmtpAddress), false);
  assert.equal(flagged.get(Tag.RecipientType), 2);
});

function restriction(fn: (w: BufferWriter) => void): ReturnType<typeof parseRestriction> {
  return parseRestriction(new BufferReader(bytes(fn)));
}

test('restrictions: content (substring, ignore case), property relops, and/or/not, exist, bitmask', () => {
  const bag: PropertyBag = new Map<number, unknown>([[Tag.Subject, 'Quarterly Report'], [Tag.MessageFlags, 0x01], [Tag.MessageSize, 500]]) as PropertyBag;
  const get = (t: number) => lookupProperty(bag, t);
  const content = restriction((w) => { w.u8(0x03).u16(0x0001).u16(0x0001).u32(Tag.Subject); writeTaggedValue(w, { tag: Tag.Subject, value: 'report' }); });
  assert.equal(evaluateRestriction(content, get), true);
  const exact = restriction((w) => { w.u8(0x03).u16(0x0000).u16(0x0000).u32(Tag.Subject); writeTaggedValue(w, { tag: Tag.Subject, value: 'report' }); });
  assert.equal(evaluateRestriction(exact, get), false);
  const gt = restriction((w) => { w.u8(0x04).u8(RelOp.GT).u32(Tag.MessageSize); writeTaggedValue(w, { tag: Tag.MessageSize, value: 100 }); });
  assert.equal(evaluateRestriction(gt, get), true);
  const andNot = restriction((w) => {
    w.u8(0x00).u16(2);
    w.u8(0x08).u32(Tag.Subject);
    w.u8(0x02).u8(0x06).u8(0x01).u32(Tag.MessageFlags).u32(0x01); // NOT (flags & 1 != 0)
  });
  assert.equal(evaluateRestriction(andNot, get), false);
  const or = restriction((w) => { w.u8(0x01).u16(2); w.u8(0x08).u32(Tag.Body); w.u8(0x08).u32(Tag.MessageSize); });
  assert.equal(evaluateRestriction(or, get), true);
  const sub = restriction((w) => { w.u8(0x09).u32(Tag.MessageRecipients); w.u8(0x08).u32(Tag.Subject); });
  assert.equal(evaluateRestriction(sub, get), false);
});

test('restrictions: nesting depth is capped; unknown types are rejected', () => {
  const deep = Buffer.alloc(100, 0x02); // NOT NOT NOT …
  assert.throws(() => parseRestriction(new BufferReader(deep)));
  assert.throws(() => parseRestriction(new BufferReader(hex('0c'))));
});

test('PropertyName codec (LID and string names) and the name ↔ id map', () => {
  const guid = hex('0820060000000000c000000000000046');
  const lid = { kind: NameKind.Lid, guid, lid: 0x8503 };
  const named = { kind: NameKind.Name, guid, name: 'x-custom' };
  const buf = bytes((w) => { writePropertyName(w, lid); writePropertyName(w, named); });
  assert.deepEqual(buf.subarray(0, 21), Buffer.concat([hex('00'), guid, hex('03850000')]));
  assert.equal(buf[21 + 17], 18); // NameSize = UTF-16 bytes incl. terminator
  const r = new BufferReader(buf);
  assert.deepEqual(readPropertyName(r), lid);
  assert.deepEqual(readPropertyName(r), named);
  const map = new NamedPropertyMap();
  assert.equal(map.lookup(lid, false), 'unknown');
  const id = map.lookup(lid, true);
  assert.equal(id, 0x8001, 'registered IDs start above 0x8000');
  assert.equal(map.lookup({ ...lid }, false), id);
  assert.equal(map.lookup({ ...named, name: 'X-CUSTOM' }, true), 0x8002);
  assert.equal(map.lookup({ ...named }, false), 'unknown', 'string names match exactly');
  assert.deepEqual(map.nameOf(0x8001), lid);
  assert.deepEqual(map.registeredIds(), [0x8001, 0x8002]);
});

test('named property map: PS_MAPI LIDs are the property ID, internet header names are case-insensitive, IDs run out', () => {
  const map = new NamedPropertyMap();
  assert.equal(map.lookup({ kind: NameKind.Lid, guid: PS_MAPI, lid: 0x0037 }, true), 0x0037, 'PS_MAPI: the LID is the ID');
  assert.deepEqual(map.registeredIds(), [], 'nothing registered for PS_MAPI');
  assert.deepEqual(map.nameOf(0x0e07), { kind: NameKind.Lid, guid: PS_MAPI, lid: 0x0e07 });
  assert.equal(map.nameOf(0x9000), undefined);
  const header = map.lookup({ kind: NameKind.Name, guid: PS_INTERNET_HEADERS, name: 'X-Mailer' }, true);
  assert.equal(map.lookup({ kind: NameKind.Name, guid: PS_INTERNET_HEADERS, name: 'x-mailer' }, false), header);
  assert.equal(map.lookup({ kind: NameKind.None, guid: PS_MAPI }, true), 'unknown');
  for (let i = 0; i < 0xfffe - 0x8001; i++) assert.equal(typeof map.lookup({ kind: NameKind.Lid, guid: PS_INTERNET_HEADERS, lid: i }, true), 'number');
  assert.equal(map.registeredIds().length, 0xfffe - 0x8000);
  assert.equal(map.lookup({ kind: NameKind.Lid, guid: PS_INTERNET_HEADERS, lid: 0x7fffffff }, true), 'exhausted');
  assert.equal(map.lookup({ kind: NameKind.Name, guid: PS_INTERNET_HEADERS, name: 'X-MAILER' }, false), header, 'known names still resolve');
});

test('restrictionNodeCount counts every node of the tree', () => {
  const exist = Buffer.from([0x08, 0x03, 0x00, 0x37, 0x00]);
  const or = Buffer.concat([Buffer.from([0x01, 0x03, 0x00]), exist, exist, Buffer.concat([Buffer.from([0x02]), exist])]);
  assert.equal(restrictionNodeCount(parseRestriction(new BufferReader(or))), 5);
});
