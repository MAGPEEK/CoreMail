/**
 * Property values in ROP buffers (MS-OXCDATA 2.11): PropertyValue,
 * TaggedPropertyValue and TypedPropertyValue. In ROP buffers PtypBinary byte
 * counts are 16 bits and PtypMultiple value counts 32 bits (2.11.1.1).
 * PtypString8 is written in Latin-1 (the Western code page desktop clients send in
 * Connect); characters outside it become '?'.
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import type { BufferWriter } from '../wire/writer.js';
import { PropType, propTypeOf } from './tags.js';

export type PropValue =
  | number | bigint | boolean | string | Buffer | Date | null
  | readonly number[] | readonly bigint[] | readonly string[] | readonly Buffer[] | readonly Date[];

/** A property that exists but cannot be returned (MS-OXCDATA 2.4.2 property error). */
export interface PropError { readonly error: number }

export interface TaggedValue { tag: number; value: PropValue }

export function propError(code: number): PropError {
  return { error: code };
}

export function isPropError(v: unknown): v is PropError {
  return typeof v === 'object' && v !== null && !Buffer.isBuffer(v) && !Array.isArray(v) && !(v instanceof Date) && 'error' in v;
}

// ── FILETIME (100 ns since 1601-01-01 UTC) ───────────────────────────────────

const EPOCH_DIFF_MS = 11_644_473_600_000n;

export function toFileTime(d: Date): bigint {
  return (BigInt(d.getTime()) + EPOCH_DIFF_MS) * 10_000n;
}

export function fromFileTime(ft: bigint): Date {
  return new Date(Number(ft / 10_000n - EPOCH_DIFF_MS));
}

// ── Strings ──────────────────────────────────────────────────────────────────

/** Latin-1 projection of a string ('?' for characters outside it). */
export function toLatin1(s: string): string {
  return s.replace(/[^\u0000-ÿ]/g, '?');
}

// ── Writing ──────────────────────────────────────────────────────────────────

function writeSingle(w: BufferWriter, type: number, v: unknown): void {
  switch (type) {
    case PropType.Integer16: w.u16(Number(v)); return;
    case PropType.Integer32: case PropType.ErrorCode: w.u32(Number(v)); return;
    case PropType.Floating32: w.f32(Number(v)); return;
    case PropType.Floating64: case PropType.FloatingTime: w.f64(Number(v)); return;
    case PropType.Currency: case PropType.Integer64: w.i64(BigInt(v as bigint)); return;
    case PropType.Boolean: w.u8(v ? 1 : 0); return;
    case PropType.String: w.utf16Z(String(v)); return;
    case PropType.String8: w.asciiZ(toLatin1(String(v))); return;
    case PropType.Time: w.u64(toFileTime(v as Date)); return;
    case PropType.Guid: {
      const g = v as Buffer;
      if (g.length !== 16) throw new RangeError('PtypGuid needs 16 bytes');
      w.bytes(g);
      return;
    }
    case PropType.Binary: case PropType.ServerId: {
      const b = v as Buffer;
      if (b.length > 0xffff) throw new RangeError('PtypBinary value larger than 64 KB in a ROP buffer');
      w.u16(b.length).bytes(b);
      return;
    }
    case PropType.Null: return;
    default: throw new RangeError(`property type 0x${type.toString(16)} cannot be serialized`);
  }
}

export function writePropValue(w: BufferWriter, type: number, value: PropValue): void {
  if (type & 0x1000) {
    const list = value as readonly unknown[];
    w.u32(list.length);
    for (const item of list) writeSingle(w, type & ~0x1000, item);
    return;
  }
  writeSingle(w, type, value);
}

export function writeTaggedValue(w: BufferWriter, tv: TaggedValue): void {
  w.u32(tv.tag);
  writePropValue(w, propTypeOf(tv.tag), tv.value);
}

// ── Reading ──────────────────────────────────────────────────────────────────

function readSingle(r: BufferReader, type: number, wide: boolean): PropValue {
  switch (type) {
    case PropType.Integer16: return r.u16();
    case PropType.Integer32: case PropType.ErrorCode: return r.u32();
    case PropType.Floating32: return r.f32();
    case PropType.Floating64: case PropType.FloatingTime: return r.f64();
    case PropType.Currency: case PropType.Integer64: return r.i64();
    case PropType.Boolean: return r.u8() !== 0;
    case PropType.String: return r.utf16Z();
    case PropType.String8: return r.asciiZ();
    case PropType.Time: return fromFileTime(r.u64());
    case PropType.Guid: return r.bytes(16);
    case PropType.Binary: return r.bytes(wide ? r.u32() : r.u16());
    case PropType.ServerId: return r.bytes(r.u16());
    case PropType.Null: return null;
    default: throw new WireFormatError(`unsupported property type 0x${type.toString(16)}`);
  }
}

/** Upper bound for multi-value counts (each value needs at least one byte). */
function checkedCount(r: BufferReader): number {
  const n = r.u32();
  if (n > r.remaining) throw new WireFormatError(`multi-value count ${n} exceeds the buffer`);
  return n;
}

/**
 * A PropertyValue. `wide`: PtypBinary counts are 32 bits (the address book
 * context of MAPI over HTTP, MS-OXCDATA 2.11.1); ROP buffers use 16 bits.
 */
export function readPropValue(r: BufferReader, type: number, wide = false): PropValue {
  if (type & 0x1000) {
    const single = type & ~0x1000;
    const n = checkedCount(r);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(readSingle(r, single, wide));
    return out as PropValue;
  }
  return readSingle(r, type, wide);
}

export function readTaggedValue(r: BufferReader, wide = false): TaggedValue {
  const t = r.u32();
  return { tag: t, value: readPropValue(r, propTypeOf(t), wide) };
}

/** Bytes a value occupies on the wire (used for size limits). */
export function encodedSize(type: number, value: PropValue): number {
  switch (type) {
    case PropType.String: return (String(value).length + 1) * 2;
    case PropType.String8: return String(value).length + 1;
    case PropType.Binary: case PropType.ServerId: return 2 + (value as Buffer).length;
    default: return 8;
  }
}
