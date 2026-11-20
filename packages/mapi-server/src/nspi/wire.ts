/**
 * Address book wire structures of MAPI over HTTP (MS-OXCMAPIHTTP 2.2.1) and
 * the STAT block (MS-OXNSPI 2.2.8):
 *
 *  - AddressBookPropertyValue: a HasValue byte (TRUE 0xFF / FALSE 0x00) in
 *    front of PtypString, PtypString8, PtypBinary and every PtypMultiple*
 *    value, and in front of each string / binary element of a multi-valued
 *    string or binary; then the MS-OXCDATA PropertyValue.
 *  - In this context PtypBinary byte counts and PtypMultiple value counts are
 *    32 bits wide (MS-OXCDATA 2.11.1, "MAPI extensions for HTTP").
 *  - AddressBookPropertyRow: Flags 0x0 (plain values) or 0x1 (flagged values:
 *    0x0 value, 0x1 no value, 0xA PtypErrorCode value).
 *  - LargePropertyTagArray: 4-byte count (at most 100 000) + 4-byte tags.
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { PropType, propTypeOf, MULTI_VALUE_FLAG } from '../props/tags.js';
import { fromFileTime, toFileTime, toLatin1, type PropValue } from '../props/values.js';

export const AB_TRUE = 0xff;
export const AB_FALSE = 0x00;
export const MAX_TAG_ARRAY = 100_000;
/** Upper bound for name / MID lists in one request (DoS guard; desktop clients send a handful). */
export const MAX_REQUEST_ITEMS = 10_000;

// ── STAT ─────────────────────────────────────────────────────────────────────

export interface Stat {
  sortType: number;
  containerId: number;
  currentRec: number;
  delta: number;
  numPos: number;
  totalRecs: number;
  codePage: number;
  templateLocale: number;
  sortLocale: number;
}

export function readStat(r: BufferReader): Stat {
  return {
    sortType: r.u32(), containerId: r.u32(), currentRec: r.u32(), delta: r.i32(), numPos: r.u32(),
    totalRecs: r.u32(), codePage: r.u32(), templateLocale: r.u32(), sortLocale: r.u32(),
  };
}

export function writeStat(w: BufferWriter, s: Stat): void {
  w.u32(s.sortType).u32(s.containerId).u32(s.currentRec).i32(s.delta).u32(s.numPos)
    .u32(s.totalRecs).u32(s.codePage).u32(s.templateLocale).u32(s.sortLocale);
}

/** HasState + optional STAT. */
export function readOptionalStat(r: BufferReader): Stat | null {
  return r.u8() !== 0 ? readStat(r) : null;
}

// ── Lists ────────────────────────────────────────────────────────────────────

function checkedCount(r: BufferReader, max: number, minBytesEach: number): number {
  const n = r.u32();
  if (n > max || n * minBytesEach > r.remaining) throw new WireFormatError(`count ${n} exceeds the limit or the buffer`);
  return n;
}

export function readTagArray(r: BufferReader): number[] {
  const n = checkedCount(r, MAX_TAG_ARRAY, 4);
  const tags: number[] = [];
  for (let i = 0; i < n; i++) tags.push(r.u32());
  return tags;
}

export function writeTagArray(w: BufferWriter, tags: readonly number[]): void {
  w.u32(tags.length);
  for (const t of tags) w.u32(t);
}

/** HasXxx byte + optional LargePropertyTagArray. */
export function readOptionalTagArray(r: BufferReader): number[] | null {
  return r.u8() !== 0 ? readTagArray(r) : null;
}

export function readMidArray(r: BufferReader): number[] {
  const n = checkedCount(r, MAX_REQUEST_ITEMS, 4);
  const mids: number[] = [];
  for (let i = 0; i < n; i++) mids.push(r.u32());
  return mids;
}

/** HasXxx byte + optional count-prefixed MinimalEntryID array. */
export function readOptionalMidArray(r: BufferReader): number[] | null {
  return r.u8() !== 0 ? readMidArray(r) : null;
}

export function writeOptionalMidArray(w: BufferWriter, mids: readonly number[] | null): void {
  if (!mids) { w.u8(0); return; }
  w.u8(AB_TRUE).u32(mids.length);
  for (const m of mids) w.u32(m);
}

/** HasNames + optional NameCount + null-terminated strings (8-bit or UTF-16). */
export function readOptionalNames(r: BufferReader, unicode: boolean): string[] | null {
  if (r.u8() === 0) return null;
  const n = checkedCount(r, MAX_REQUEST_ITEMS, unicode ? 2 : 1);
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(unicode ? r.utf16Z() : r.asciiZ());
  return names;
}

// ── Values ───────────────────────────────────────────────────────────────────

/** Types whose AddressBookPropertyValue starts with a HasValue byte (besides every PtypMultiple*). */
const STRINGISH = new Set<number>([PropType.String, PropType.String8, PropType.Binary]);

function writeScalar(w: BufferWriter, type: number, v: unknown): void {
  switch (type) {
    case PropType.Integer16: w.u16(Number(v)); return;
    case PropType.Integer32: case PropType.ErrorCode: w.u32(Number(v)); return;
    case PropType.Boolean: w.u8(v ? 1 : 0); return;
    case PropType.Integer64: w.i64(BigInt(v as bigint)); return;
    case PropType.Time: w.u64(toFileTime(v as Date)); return;
    case PropType.Guid: w.bytes(v as Buffer); return;
    case PropType.String: w.utf16Z(String(v)); return;
    // An 8-bit string arrives encoded in the request's code page (address-book.ts cellsOf).
    case PropType.String8:
      if (Buffer.isBuffer(v)) w.bytes(v).u8(0);
      else w.asciiZ(toLatin1(String(v)));
      return;
    case PropType.Binary: { const b = v as Buffer; w.u32(b.length).bytes(b); return; }
    default: throw new RangeError(`address book value of type 0x${type.toString(16)} cannot be serialized`);
  }
}

/** AddressBookPropertyValue (HasValue where the type needs it). */
export function writeAbValue(w: BufferWriter, type: number, value: PropValue): void {
  if (type & MULTI_VALUE_FLAG) {
    const single = type & ~MULTI_VALUE_FLAG;
    const list = value as readonly unknown[];
    w.u8(AB_TRUE).u32(list.length);
    for (const item of list) {
      if (STRINGISH.has(single)) w.u8(AB_TRUE);
      writeScalar(w, single, item);
    }
    return;
  }
  if (STRINGISH.has(type)) w.u8(AB_TRUE);
  writeScalar(w, type, value);
}

function readScalar(r: BufferReader, type: number): PropValue {
  switch (type) {
    case PropType.Integer16: return r.u16();
    case PropType.Integer32: case PropType.ErrorCode: return r.u32();
    case PropType.Boolean: return r.u8() !== 0;
    case PropType.Integer64: return r.i64();
    case PropType.Time: return fromFileTime(r.u64());
    case PropType.Guid: return r.bytes(16);
    case PropType.String: return r.utf16Z();
    case PropType.String8: return r.asciiZ();
    case PropType.Binary: { const n = r.u32(); return r.bytes(n); }
    default: throw new WireFormatError(`unsupported address book property type 0x${type.toString(16)}`);
  }
}

/** Reads an AddressBookPropertyValue; null when HasValue is FALSE. */
export function readAbValue(r: BufferReader, type: number): PropValue {
  if (type & MULTI_VALUE_FLAG) {
    if (r.u8() === AB_FALSE) return null;
    const single = type & ~MULTI_VALUE_FLAG;
    const n = checkedCount(r, MAX_REQUEST_ITEMS, 1);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      if (STRINGISH.has(single) && r.u8() === AB_FALSE) continue;
      out.push(readScalar(r, single));
    }
    return out as PropValue;
  }
  if (STRINGISH.has(type) && r.u8() === AB_FALSE) return null;
  return readScalar(r, type);
}

/** AddressBookTaggedPropertyValue: PropertyType, PropertyId, value. */
export function readAbTaggedValue(r: BufferReader): { tag: number; value: PropValue } {
  const type = r.u16();
  const id = r.u16();
  return { tag: ((id << 16) | type) >>> 0, value: readAbValue(r, type) };
}

// ── Rows and value lists ─────────────────────────────────────────────────────

/** One column of an address book row: a value, a property error, or nothing. */
export type AbCell =
  | { kind: 'value'; tag: number; value: PropValue }
  | { kind: 'error'; tag: number; error: number }
  | { kind: 'missing'; tag: number };

const FLAG_VALUE = 0x0;
const FLAG_MISSING = 0x1;
const FLAG_ERROR = 0xa;

/**
 * AddressBookPropertyRow for known `columns` (cells in column order, the
 * cell tag carries the actual type for PtypUnspecified columns). Flags 0x0
 * when every cell has a value, else 0x1 (flagged values).
 */
export function writeAbRow(w: BufferWriter, columns: readonly number[], cells: readonly AbCell[]): void {
  const flagged = cells.some((c) => c.kind !== 'value');
  w.u8(flagged ? 0x1 : 0x0);
  cells.forEach((cell, i) => {
    const unspecified = propTypeOf(columns[i]!) === PropType.Unspecified;
    const type = cell.kind === 'error' ? PropType.ErrorCode : propTypeOf(cell.tag);
    if (unspecified) w.u16(type);
    if (flagged) w.u8(cell.kind === 'value' ? FLAG_VALUE : cell.kind === 'missing' ? FLAG_MISSING : FLAG_ERROR);
    if (cell.kind === 'value') writeAbValue(w, type, cell.value);
    else if (cell.kind === 'error') w.u32(cell.error);
  });
}

/**
 * AddressBookPropertyValueList: count + AddressBookTaggedPropertyValue each.
 * Error cells are written as PtypErrorCode values; missing cells are skipped.
 */
export function writeAbValueList(w: BufferWriter, cells: readonly AbCell[]): void {
  const present = cells.filter((c) => c.kind !== 'missing');
  w.u32(present.length);
  for (const c of present) {
    const type = c.kind === 'error' ? PropType.ErrorCode : propTypeOf(c.tag);
    w.u16(type).u16(c.tag >>> 16);
    if (c.kind === 'error') w.u32(c.error);
    else if (c.kind === 'value') writeAbValue(w, type, c.value);
  }
}
