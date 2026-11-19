/**
 * FastTransfer stream lexical layer (MS-OXCFXICS 2.2.4.1): markers and
 * propValue elements as a list of atoms. An atom is a marker, a property
 * definition (type + id), a fixed-size value or a length; a variable-size
 * value may be split anywhere, an atom never (2.2.4.1, the split rules of
 * RopFastTransferSourceGetBuffer).
 *
 * Serialization as in MS-OXCDATA except (2.2.4.1.3): PtypBoolean is 2 bytes,
 * strings carry their terminating null (counted in the length), PtypBinary /
 * PtypString lengths and multi-value counts are 32 bits. Named properties
 * (ID ≥ 0x8000) are never written: every property CoreMail produces is tagged.
 * Pure module.
 */
import { BufferWriter } from '../wire/writer.js';
import { PropType, propIdOf, propTypeOf, MULTI_VALUE_FLAG } from '../props/tags.js';
import { isPropError, toFileTime, toLatin1, type PropError, type PropValue } from '../props/values.js';

/** A piece of the stream; `splittable` = the inside of a variable-size value. */
export interface FxPiece { bytes: Buffer; splittable: boolean }

/** Markers (MS-OXCFXICS 2.2.4.1.4). */
export const Marker = {
  StartRecip: 0x40030003,
  EndToRecip: 0x40040003,
  NewAttach: 0x40000003,
  EndAttach: 0x400e0003,
  IncrSyncChg: 0x40120003,
  IncrSyncDel: 0x40130003,
  IncrSyncEnd: 0x40140003,
  IncrSyncMessage: 0x40150003,
  IncrSyncRead: 0x402f0003,
  IncrSyncStateBegin: 0x403a0003,
  IncrSyncStateEnd: 0x403b0003,
} as const;

const FIRST_NAMED_ID = 0x8000;

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function fixedValue(type: number, v: unknown): Buffer | null {
  const w = new BufferWriter(16);
  switch (type) {
    case PropType.Integer16: w.u16(Number(v)); break;
    case PropType.Integer32: case PropType.ErrorCode: w.u32(Number(v)); break;
    case PropType.Floating32: w.f32(Number(v)); break;
    case PropType.Floating64: case PropType.FloatingTime: w.f64(Number(v)); break;
    case PropType.Currency: case PropType.Integer64: w.i64(BigInt(v as bigint)); break;
    case PropType.Boolean: w.u16(v ? 1 : 0); break;
    case PropType.Time: w.u64(toFileTime(v as Date)); break;
    case PropType.Guid: w.bytes(v as Buffer); break;
    default: return null;
  }
  return w.toBuffer();
}

function varValue(type: number, v: unknown): Buffer | null {
  switch (type) {
    case PropType.String: return Buffer.from(`${String(v)}\u0000`, 'utf16le');
    case PropType.String8: return Buffer.from(`${toLatin1(String(v))}\u0000`, 'latin1');
    case PropType.Binary: case PropType.ServerId: return v as Buffer;
    default: return null;
  }
}

export class FxWriter {
  readonly pieces: FxPiece[] = [];

  private atom(bytes: Buffer): void { this.pieces.push({ bytes, splittable: false }); }

  marker(m: number): this {
    this.atom(u32(m));
    return this;
  }

  /**
   * A propValue; values of unsupported types and named properties are
   * skipped, a property error becomes a PtypErrorCode value. Returns whether
   * something was written.
   */
  prop(tag: number, value: PropValue | PropError): boolean {
    if (propIdOf(tag) >= FIRST_NAMED_ID) return false;
    if (isPropError(value)) {
      this.atom(u32(((propIdOf(tag) << 16) | PropType.ErrorCode) >>> 0));
      this.atom(u32(value.error));
      return true;
    }
    const type = propTypeOf(tag);
    if (type & MULTI_VALUE_FLAG) return this.multi(tag, value as readonly unknown[]);
    const fixed = fixedValue(type, value);
    if (fixed) {
      this.atom(u32(tag));
      this.atom(fixed);
      return true;
    }
    const bytes = varValue(type, value);
    if (!bytes) return false;
    this.binaryAs(tag, bytes);
    return true;
  }

  /** propDef + length + bytes for any tag (also MetaTagIdsetGiven, which has an Integer32 tag). */
  binaryAs(tag: number, bytes: Buffer): this {
    this.atom(u32(tag));
    this.atom(u32(bytes.length));
    if (bytes.length > 0) this.pieces.push({ bytes, splittable: true });
    return this;
  }

  private multi(tag: number, list: readonly unknown[]): boolean {
    const single = propTypeOf(tag) & ~MULTI_VALUE_FLAG;
    const encoded = list.map((v) => ({ fixed: fixedValue(single, v), bytes: varValue(single, v) }));
    if (encoded.some((e) => !e.fixed && !e.bytes)) return false;
    this.atom(u32(tag));
    this.atom(u32(list.length));
    for (const e of encoded) {
      if (e.fixed) { this.atom(e.fixed); continue; }
      this.atom(u32(e.bytes!.length));
      if (e.bytes!.length > 0) this.pieces.push({ bytes: e.bytes!, splittable: true });
    }
    return true;
  }

  /** The stream as one buffer (tests). */
  toBuffer(): Buffer {
    return Buffer.concat(this.pieces.map((p) => p.bytes));
  }
}
