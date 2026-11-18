/**
 * Restrictions (MS-OXCDATA 2.12): parsing and in-memory evaluation against a
 * row's properties. In ROP buffers (RopRestrict) the count fields are 16 bits;
 * the address book filter of MAPI over HTTP (GetMatches) is read with 32-bit
 * counts and 32-bit binary value counts (WIDE_RESTRICTION).
 * Nesting is capped so a hostile request cannot exhaust the stack.
 * Unsupported tests (regular expressions, distribution-list membership,
 * sub-object restrictions over recipients/attachments) evaluate to false.
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { readTaggedValue, type PropValue, type TaggedValue } from './values.js';
import type { LookupResult } from './bag.js';

export type Restriction =
  | { type: 'and' | 'or'; items: Restriction[] }
  | { type: 'not'; item: Restriction }
  | { type: 'content'; fuzzyLow: number; fuzzyHigh: number; tag: number; value: TaggedValue }
  | { type: 'property'; relop: number; tag: number; value: TaggedValue }
  | { type: 'compare'; relop: number; tag1: number; tag2: number }
  | { type: 'bitmask'; mode: number; tag: number; mask: number }
  | { type: 'size'; relop: number; tag: number; size: number }
  | { type: 'exist'; tag: number }
  | { type: 'sub'; subobject: number; item: Restriction }
  | { type: 'comment'; values: TaggedValue[]; item: Restriction | null }
  | { type: 'count'; count: number; item: Restriction };

export const RelOp = { LT: 0, LE: 1, GT: 2, GE: 3, EQ: 4, NE: 5, RE: 6, MemberOfDL: 0x64 } as const;
const FL_SUBSTRING = 0x0001;
const FL_PREFIX = 0x0002;
const FL_IGNORECASE = 0x0001;
const FL_LOOSE = 0x0004;

const MAX_DEPTH = 32;

/** Serialization variant (MS-OXCDATA 2.12): count width and binary value count width. */
export interface RestrictionFormat { readonly wide: boolean }
export const ROP_RESTRICTION: RestrictionFormat = { wide: false };
export const WIDE_RESTRICTION: RestrictionFormat = { wide: true };

export function parseRestriction(r: BufferReader, format: RestrictionFormat = ROP_RESTRICTION, depth = 0): Restriction {
  if (depth > MAX_DEPTH) throw new WireFormatError('restriction nested too deeply');
  const kind = r.u8();
  const sub = (): Restriction => parseRestriction(r, format, depth + 1);
  switch (kind) {
    case 0x00: case 0x01: {
      const n = format.wide ? r.u32() : r.u16();
      if (n > r.remaining) throw new WireFormatError(`restriction count ${n} exceeds the buffer`);
      const items: Restriction[] = [];
      for (let i = 0; i < n; i++) items.push(sub());
      return { type: kind === 0 ? 'and' : 'or', items };
    }
    case 0x02: return { type: 'not', item: sub() };
    case 0x03: {
      const fuzzyLow = r.u16();
      const fuzzyHigh = r.u16();
      return { type: 'content', fuzzyLow, fuzzyHigh, tag: r.u32(), value: readTaggedValue(r, format.wide) };
    }
    case 0x04: {
      const relop = r.u8();
      return { type: 'property', relop, tag: r.u32(), value: readTaggedValue(r, format.wide) };
    }
    case 0x05: { const relop = r.u8(); const tag1 = r.u32(); return { type: 'compare', relop, tag1, tag2: r.u32() }; }
    case 0x06: { const mode = r.u8(); const tag = r.u32(); return { type: 'bitmask', mode, tag, mask: r.u32() }; }
    case 0x07: { const relop = r.u8(); const tag = r.u32(); return { type: 'size', relop, tag, size: r.u32() }; }
    case 0x08: return { type: 'exist', tag: r.u32() };
    case 0x09: { const subobject = r.u32(); return { type: 'sub', subobject, item: sub() }; }
    case 0x0a: {
      const n = r.u8();
      const values: TaggedValue[] = [];
      for (let i = 0; i < n; i++) values.push(readTaggedValue(r, format.wide));
      const present = r.u8();
      return { type: 'comment', values, item: present ? sub() : null };
    }
    case 0x0b: { const count = r.u32(); return { type: 'count', count, item: sub() }; }
    default: throw new WireFormatError(`unknown restriction type 0x${kind.toString(16)}`);
  }
}

/** Nodes of a restriction tree (evaluation cost per row is linear in it). */
export function restrictionNodeCount(res: Restriction): number {
  switch (res.type) {
    case 'and': case 'or': return 1 + res.items.reduce((n, i) => n + restrictionNodeCount(i), 0);
    case 'not': case 'sub': case 'count': return 1 + restrictionNodeCount(res.item);
    case 'comment': return 1 + (res.item ? restrictionNodeCount(res.item) : 0);
    default: return 1;
  }
}

export type PropertyGetter = (tag: number) => LookupResult;

function valueOf(get: PropertyGetter, tag: number): PropValue | undefined {
  const r = get(tag);
  return r.found && 'value' in r ? r.value : undefined;
}

/** -1/0/1, or null when the values cannot be ordered. */
export function compareValues(a: PropValue, b: PropValue): number | null {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b);
  return null;
}

function relopHolds(relop: number, c: number | null): boolean {
  if (c === null) return false;
  switch (relop) {
    case RelOp.LT: return c < 0;
    case RelOp.LE: return c <= 0;
    case RelOp.GT: return c > 0;
    case RelOp.GE: return c >= 0;
    case RelOp.EQ: return c === 0;
    case RelOp.NE: return c !== 0;
    default: return false;
  }
}

function contentMatches(hay: PropValue, needle: PropValue, fuzzyLow: number, fuzzyHigh: number): boolean {
  if (Array.isArray(hay)) return hay.some((v) => contentMatches(v as PropValue, needle, fuzzyLow, fuzzyHigh));
  if (Buffer.isBuffer(hay) && Buffer.isBuffer(needle)) {
    if (fuzzyLow & FL_SUBSTRING) return hay.includes(needle);
    if (fuzzyLow & FL_PREFIX) return hay.subarray(0, needle.length).equals(needle);
    return hay.equals(needle);
  }
  if (typeof hay !== 'string' || typeof needle !== 'string') return false;
  const fold = (fuzzyHigh & (FL_IGNORECASE | FL_LOOSE)) !== 0;
  const h = fold ? hay.toLowerCase() : hay;
  const n = fold ? needle.toLowerCase() : needle;
  if (fuzzyLow & FL_SUBSTRING) return h.includes(n);
  if (fuzzyLow & FL_PREFIX) return h.startsWith(n);
  return h === n;
}

function sizeOf(v: PropValue): number {
  if (typeof v === 'string') return v.length * 2;
  if (Buffer.isBuffer(v)) return v.length;
  return 8;
}

/**
 * Evaluates a node the caller decides itself (e.g. ambiguous name resolution
 * on PidTagAnr in the address book); undefined = evaluate normally.
 */
export type RestrictionOverride = (node: Restriction) => boolean | undefined;

export function evaluateRestriction(res: Restriction, get: PropertyGetter, override?: RestrictionOverride): boolean {
  const decided = override?.(res);
  if (decided !== undefined) return decided;
  const sub = (item: Restriction): boolean => evaluateRestriction(item, get, override);
  switch (res.type) {
    case 'and': return res.items.every(sub);
    case 'or': return res.items.some(sub);
    case 'not': return !sub(res.item);
    case 'exist': return get(res.tag).found;
    case 'content': {
      const v = valueOf(get, res.tag);
      return v !== undefined && contentMatches(v, res.value.value, res.fuzzyLow, res.fuzzyHigh);
    }
    case 'property': {
      const v = valueOf(get, res.tag);
      if (v === undefined) return false;
      if (Array.isArray(v) && !Array.isArray(res.value.value)) {
        return v.some((x) => relopHolds(res.relop, compareValues(x as PropValue, res.value.value)));
      }
      return relopHolds(res.relop, compareValues(v, res.value.value));
    }
    case 'compare': {
      const a = valueOf(get, res.tag1);
      const b = valueOf(get, res.tag2);
      return a !== undefined && b !== undefined && relopHolds(res.relop, compareValues(a, b));
    }
    case 'bitmask': {
      const v = valueOf(get, res.tag);
      if (typeof v !== 'number') return false;
      const zero = (v & res.mask) === 0;
      return res.mode === 0 ? zero : !zero;
    }
    case 'size': {
      const v = valueOf(get, res.tag);
      return v !== undefined && relopHolds(res.relop, Math.sign(sizeOf(v) - res.size));
    }
    case 'comment': return res.item ? sub(res.item) : true;
    case 'count': return sub(res.item);
    case 'sub': return false;
  }
}
