/**
 * GLOBSET (MS-OXCFXICS 2.2.2.6): a set of 48-bit GLOBCNT values as ranges,
 * serialized as commands on a common byte stack —
 *   Push 0x01–0x06 (high-order bytes; a sixth byte makes a singleton and is
 *   popped automatically), Pop 0x50, Bitmask 0x42 (five bytes on the stack),
 *   Range 0x52 (low and high value of the remaining bytes), End 0x00.
 * GLOBCNT bytes are big-endian (byte 0 is the high-order byte).
 *
 * Ranges are kept sorted and merged; set operations work on those arrays.
 * The encoder uses Push / Range / Pop only (every decoder understands them);
 * the decoder accepts every command. Pure module.
 */
import { WireFormatError, type BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';

/** An inclusive GLOBCNT range. */
export interface Range { low: bigint; high: bigint }

export const GLOBCNT_MAX = 0xffff_ffff_ffffn;
const GLOBCNT_BYTES = 6;

const CMD_POP = 0x50;
const CMD_BITMASK = 0x42;
const CMD_RANGE = 0x52;
const CMD_END = 0x00;

/** Upper bound for decoded ranges (a hostile state cannot allocate without limit). */
export const MAX_RANGES = 1_000_000;

function globcntBytes(v: bigint): Buffer {
  const b = Buffer.alloc(GLOBCNT_BYTES);
  b.writeUIntBE(Number(v), 0, GLOBCNT_BYTES);
  return b;
}

function globcntOfBytes(b: Buffer): bigint {
  return BigInt(b.readUIntBE(0, GLOBCNT_BYTES));
}

/** Sorted, merged (adjacent ranges joined) copy of `ranges`. */
export function normalize(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter((r) => r.low <= r.high).map((r) => ({ ...r })).sort((a, b) => (a.low < b.low ? -1 : a.low > b.low ? 1 : 0));
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.low <= last.high + 1n) {
      if (r.high > last.high) last.high = r.high;
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Ranges of a list of single values. */
export function rangesOf(values: Iterable<bigint>): Range[] {
  return normalize([...values].map((v) => ({ low: v, high: v })));
}

export function contains(ranges: readonly Range[], v: bigint): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (v < r.low) hi = mid - 1;
    else if (v > r.high) lo = mid + 1;
    else return true;
  }
  return false;
}

export function union(a: readonly Range[], b: readonly Range[]): Range[] {
  return normalize([...a, ...b]);
}

/** `a` without the values of `b`. */
export function subtract(a: readonly Range[], b: readonly Range[]): Range[] {
  const cut = normalize(b);
  const out: Range[] = [];
  for (const r of normalize(a)) {
    let low = r.low;
    for (const c of cut) {
      if (c.high < low || c.low > r.high) continue;
      if (c.low > low) out.push({ low, high: c.low - 1n });
      low = c.high + 1n;
      if (low > r.high) break;
    }
    if (low <= r.high) out.push({ low, high: r.high });
  }
  return out;
}

/** Values in both `a` and `b`. */
export function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  return subtract(a, subtract(a, b));
}

/** Every single value of the ranges (callers bound the size). */
export function* valuesOf(ranges: readonly Range[]): Generator<bigint> {
  for (const r of ranges) for (let v = r.low; v <= r.high; v++) yield v;
}

export function count(ranges: readonly Range[]): bigint {
  return ranges.reduce((n, r) => n + (r.high - r.low + 1n), 0n);
}

function commonPrefix(a: Buffer, b: Buffer, from: number, max: number): number {
  let n = 0;
  while (n < max && a[from + n] === b[from + n]) n++;
  return n;
}

// ── Encoding ─────────────────────────────────────────────────────────────────

/** Serialized GLOBSET of `ranges` (normalized first). */
export function encodeGlobset(ranges: readonly Range[]): Buffer {
  const list = normalize(ranges);
  const w = new BufferWriter(16 + list.length * 8);
  if (list.length > 0) {
    const first = globcntBytes(list[0]!.low);
    // Bytes every value shares (at most 5: a sixth would end the push as a singleton).
    let shared = 5;
    for (const r of list) {
      shared = Math.min(shared, commonPrefix(first, globcntBytes(r.low), 0, shared), commonPrefix(first, globcntBytes(r.high), 0, shared));
    }
    if (shared > 0) w.u8(shared).bytes(first.subarray(0, shared));
    for (const r of list) writeRange(w, r, shared);
    if (shared > 0) w.u8(CMD_POP);
  }
  w.u8(CMD_END);
  return w.toBuffer();
}

function writeRange(w: BufferWriter, r: Range, depth: number): void {
  const low = globcntBytes(r.low);
  const high = globcntBytes(r.high);
  const left = GLOBCNT_BYTES - depth;
  if (r.low === r.high) {
    w.u8(left).bytes(low.subarray(depth)); // a full stack: singleton, popped automatically
    return;
  }
  const extra = commonPrefix(low, high, depth, left - 1);
  if (extra > 0) w.u8(extra).bytes(low.subarray(depth, depth + extra));
  w.u8(CMD_RANGE).bytes(low.subarray(depth + extra)).bytes(high.subarray(depth + extra));
  if (extra > 0) w.u8(CMD_POP);
}

// ── Decoding ─────────────────────────────────────────────────────────────────

/** Reads one GLOBSET (up to and including its End command). */
export function decodeGlobset(r: BufferReader): Range[] {
  const pushes: number[] = []; // byte count of each push on the stack
  const stack: number[] = [];
  const out: Range[] = [];
  const value = (low: number[]): bigint => globcntOfBytes(Buffer.from([...stack, ...low]));
  const add = (low: bigint, high: bigint): void => {
    if (low > high) throw new WireFormatError('GLOBSET range with low > high');
    if (out.length >= MAX_RANGES) throw new WireFormatError('GLOBSET has too many ranges');
    out.push({ low, high });
  };
  for (;;) {
    const cmd = r.u8();
    if (cmd === CMD_END) break;
    if (cmd >= 0x01 && cmd <= 0x06) {
      if (stack.length + cmd > GLOBCNT_BYTES) throw new WireFormatError('GLOBSET push past six bytes');
      stack.push(...r.bytes(cmd));
      if (stack.length === GLOBCNT_BYTES) {
        const v = value([]);
        add(v, v);
        stack.length -= cmd; // the last push is removed automatically
      } else {
        pushes.push(cmd);
      }
    } else if (cmd === CMD_POP) {
      const n = pushes.pop();
      if (n === undefined) throw new WireFormatError('GLOBSET pop on an empty stack');
      stack.length -= n;
    } else if (cmd === CMD_BITMASK) {
      if (stack.length !== GLOBCNT_BYTES - 1) throw new WireFormatError('GLOBSET bitmask needs five stacked bytes');
      const start = r.u8();
      const mask = r.u8();
      const base = value([0]);
      add(base + BigInt(start), base + BigInt(start));
      for (let bit = 0; bit < 8; bit++) {
        if (mask & (1 << bit)) {
          const low = start + 1 + bit;
          if (low > 0xff) throw new WireFormatError('GLOBSET bitmask past the low byte');
          add(base + BigInt(low), base + BigInt(low));
        }
      }
    } else if (cmd === CMD_RANGE) {
      const n = GLOBCNT_BYTES - stack.length;
      if (n <= 0) throw new WireFormatError('GLOBSET range on a full stack');
      const low = value([...r.bytes(n)]);
      const high = value([...r.bytes(n)]);
      add(low, high);
    } else {
      throw new WireFormatError(`unknown GLOBSET command 0x${cmd.toString(16)}`);
    }
  }
  return normalize(out);
}
