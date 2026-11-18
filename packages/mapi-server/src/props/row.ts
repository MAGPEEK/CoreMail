/**
 * PropertyRow (MS-OXCDATA 2.8.1): Flag 0x00 = StandardPropertyRow (plain
 * values in column order); Flag 0x01 = FlaggedPropertyRow when any column is
 * missing/in error or a column was requested as PtypUnspecified. Flagged
 * values carry a flag byte (0x00 value, 0x0A error code); PtypUnspecified
 * columns use FlaggedPropertyValueWithType (type first).
 */
import type { BufferReader } from '../wire/reader.js';
import type { BufferWriter } from '../wire/writer.js';
import { PropType, propTypeOf, tag as makeTag, propIdOf } from './tags.js';
import { readPropValue, writePropValue, type PropError, type PropValue } from './values.js';
import type { LookupResult, PropertyBag } from './bag.js';

export const NOT_FOUND = 0x8004010f;

const FLAG_VALUE = 0x00;
const FLAG_ERROR = 0x0a;

export type ColumnLookup = (column: number) => LookupResult;

function hasValue(r: LookupResult): r is Extract<LookupResult, { value: unknown }> {
  return r.found && 'value' in r;
}

export function writePropertyRow(w: BufferWriter, columns: readonly number[], lookup: ColumnLookup): void {
  const results = columns.map(lookup);
  const flagged = results.some((r) => !hasValue(r)) || columns.some((c) => propTypeOf(c) === PropType.Unspecified);
  w.u8(flagged ? 0x01 : 0x00);
  columns.forEach((column, i) => {
    const r = results[i]!;
    const unspecified = propTypeOf(column) === PropType.Unspecified;
    if (!flagged) {
      writePropValue(w, propTypeOf(column), (r as Extract<LookupResult, { value: unknown }>).value);
      return;
    }
    if (hasValue(r)) {
      const type = propTypeOf(r.tag);
      if (unspecified) w.u16(type);
      w.u8(FLAG_VALUE);
      writePropValue(w, unspecified ? type : propTypeOf(column), r.value);
      return;
    }
    const code = r.found && 'error' in r ? r.error : NOT_FOUND;
    if (unspecified) w.u16(PropType.ErrorCode);
    w.u8(FLAG_ERROR).u32(code);
  });
}

/** Reads a PropertyRow written for `columns` (client-sent rows, e.g. recipient rows). */
export function readPropertyRow(r: BufferReader, columns: readonly number[]): PropertyBag {
  const bag: PropertyBag = new Map<number, PropValue | PropError>();
  const flagged = r.u8() === 0x01;
  for (const column of columns) {
    let type = propTypeOf(column);
    if (type === PropType.Unspecified) type = r.u16();
    if (flagged) {
      const flag = r.u8();
      if (flag === 0x01) continue;
      if (flag === FLAG_ERROR) { bag.set(makeTag(propIdOf(column), PropType.ErrorCode), { error: r.u32() }); continue; }
    }
    bag.set(makeTag(propIdOf(column), type), readPropValue(r, type));
  }
  return bag;
}
