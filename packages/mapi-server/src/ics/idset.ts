/**
 * IDSET / CNSET (MS-OXCFXICS 2.2.2.4): sets of IDs or change numbers, kept as
 * GLOBCNT ranges per replica. Two serialized forms:
 *  - REPLGUID-based (2.2.2.4.2, the ICS state properties): per replica the
 *    16-byte REPLGUID, then its GLOBSET; replicas in ascending GUID byte order;
 *  - REPLID-based (2.2.2.4.1, the deletion and read-state meta-properties of a
 *    download): per replica the 2-byte REPLID, then its GLOBSET; ascending REPLID.
 * A mailbox has one replica (REPLID 1 ↔ its replica GUID, ids.ts); entries of
 * other replicas are kept as they are so a state survives a round trip.
 * Pure module.
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import {
  contains, decodeGlobsetRaw, encodeGlobset, normalize, rangesOf, subtract, union, MAX_RANGES, type Range,
} from './globset.js';

const GUID_BYTES = 16;

export class IdSet {
  private readonly byGuid = new Map<string, Range[]>();

  /** A set with the given values of one replica. */
  static of(guid: Buffer, values: Iterable<bigint>): IdSet {
    return new IdSet().add(guid, values);
  }

  /**
   * Replica / GLOBSET pairs of a serialized IDSET; the ranges of one replica
   * are collected and merged once (a replica may repeat: linear, not
   * quadratic), at most `maxRanges` ranges in all (IdsetTooLargeError).
   */
  private static decode(buf: Buffer, replicaOf: (r: BufferReader) => Buffer, maxRanges: number): IdSet {
    const budget = { left: maxRanges };
    const raw = new Map<string, Range[]>();
    const r = new BufferReader(buf);
    while (!r.atEnd) {
      const key = replicaOf(r).toString('hex');
      const ranges = decodeGlobsetRaw(r, budget);
      const list = raw.get(key);
      if (list) for (const range of ranges) list.push(range);
      else raw.set(key, ranges);
    }
    const set = new IdSet();
    for (const [key, ranges] of raw) set.byGuid.set(key, normalize(ranges));
    return set;
  }

  /** REPLGUID-based serialization (ICS state properties). */
  static decodeGuidForm(buf: Buffer, maxRanges = MAX_RANGES): IdSet {
    return IdSet.decode(buf, (r) => r.bytes(GUID_BYTES), maxRanges);
  }

  /** REPLID-based serialization; `guidOf` maps a REPLID to its replica GUID (null: unknown → error). */
  static decodeReplidForm(buf: Buffer, guidOf: (replid: number) => Buffer | null, maxRanges = MAX_RANGES): IdSet {
    return IdSet.decode(buf, (r) => {
      const replid = r.u16();
      const guid = guidOf(replid);
      if (!guid) throw new WireFormatError(`IDSET names unknown REPLID ${replid}`);
      return guid;
    }, maxRanges);
  }

  /** An ICS state value: REPLGUID form, or REPLID form when it does not parse as such. */
  static decodeStateValue(buf: Buffer, guidOf: (replid: number) => Buffer | null, maxRanges = MAX_RANGES): IdSet {
    try {
      return IdSet.decodeGuidForm(buf, maxRanges);
    } catch (err) {
      if (!(err instanceof WireFormatError)) throw err;
      return IdSet.decodeReplidForm(buf, guidOf, maxRanges);
    }
  }

  encodeGuidForm(): Buffer {
    const w = new BufferWriter(64);
    for (const key of [...this.byGuid.keys()].sort()) {
      const ranges = this.byGuid.get(key)!;
      if (ranges.length === 0) continue;
      w.bytes(Buffer.from(key, 'hex')).bytes(encodeGlobset(ranges));
    }
    return w.toBuffer();
  }

  /** REPLID form; replicas without a REPLID (`replidOf` → null) are left out. */
  encodeReplidForm(replidOf: (guid: Buffer) => number | null): Buffer {
    const entries: Array<{ replid: number; ranges: Range[] }> = [];
    for (const [key, ranges] of this.byGuid) {
      const replid = replidOf(Buffer.from(key, 'hex'));
      if (replid !== null && ranges.length > 0) entries.push({ replid, ranges });
    }
    const w = new BufferWriter(64);
    for (const e of entries.sort((a, b) => a.replid - b.replid)) w.u16(e.replid).bytes(encodeGlobset(e.ranges));
    return w.toBuffer();
  }

  ranges(guid: Buffer): readonly Range[] {
    return this.byGuid.get(guid.toString('hex')) ?? [];
  }

  has(guid: Buffer, value: bigint): boolean {
    return contains(this.ranges(guid), value);
  }

  /** Ranges held over every replica (session memory accounting). */
  get rangeCount(): number {
    let n = 0;
    for (const r of this.byGuid.values()) n += r.length;
    return n;
  }

  /** Replaces the values of one replica. */
  setRanges(guid: Buffer, ranges: readonly Range[]): this {
    this.byGuid.set(guid.toString('hex'), normalize(ranges));
    return this;
  }

  add(guid: Buffer, values: Iterable<bigint>): this {
    return this.addRanges(guid, rangesOf(values));
  }

  addRanges(guid: Buffer, ranges: readonly Range[]): this {
    const key = guid.toString('hex');
    this.byGuid.set(key, union(this.byGuid.get(key) ?? [], ranges));
    return this;
  }

  remove(guid: Buffer, values: Iterable<bigint>): this {
    return this.removeRanges(guid, rangesOf(values));
  }

  removeRanges(guid: Buffer, ranges: readonly Range[]): this {
    const key = guid.toString('hex');
    const current = this.byGuid.get(key);
    if (current) this.byGuid.set(key, subtract(current, ranges));
    return this;
  }

  clone(): IdSet {
    const copy = new IdSet();
    for (const [key, ranges] of this.byGuid) copy.byGuid.set(key, normalize(ranges));
    return copy;
  }

  /** A new set with the values of both. */
  union(other: IdSet): IdSet {
    const out = this.clone();
    for (const [key, ranges] of other.byGuid) out.addRanges(Buffer.from(key, 'hex'), ranges);
    return out;
  }
}
