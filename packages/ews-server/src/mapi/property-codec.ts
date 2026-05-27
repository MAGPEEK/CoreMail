/**
 * MAPI Property-Codec (v4.1.0)
 *
 * Encoded/Decodes MAPI Property-Values nach MS-OXCDATA §2.11. Properties haben
 * TaggedPropertyValue (PropertyTag + Value) oder TypedPropertyValue
 * (PropertyType + Value).
 *
 * Wir unterstützen initial:
 *   - PT_LONG (Int32)
 *   - PT_INT64
 *   - PT_BOOLEAN
 *   - PT_UNICODE
 *   - PT_BINARY
 *   - PT_SYSTIME (FILETIME, 8 Bytes, 100ns ticks seit 1601-01-01 UTC)
 *
 * Weitere Typen kommen mit folgenden Phasen (Multi-Value-Arrays etc.).
 */

import { MapiReader, MapiWriter } from './codec.js';
import { PropType, getPropType } from './rop-types.js';

/**
 * FILETIME-Konvertierung: Unix-ms ↔ MAPI-PT_SYSTIME.
 * FILETIME ist 100ns-Ticks seit 1601-01-01 00:00:00 UTC (BigInt).
 *
 * Differenz Unix-Epoch (1970) ↔ FILETIME-Epoch (1601) = 11644473600 Sekunden.
 */
const FT_EPOCH_DIFF_NS = 11644473600n * 10000000n; // in 100ns-ticks

export function dateToFiletime(d: Date | null | undefined): bigint {
  if (!d) return 0n;
  return BigInt(d.getTime()) * 10000n + FT_EPOCH_DIFF_NS;
}

export function filetimeToDate(ft: bigint): Date {
  return new Date(Number((ft - FT_EPOCH_DIFF_NS) / 10000n));
}

/**
 * Schreibt einen einzelnen Property-Value (ohne Tag, nur Value) basierend
 * auf dem PropertyType.
 */
export function writePropertyValue(
  w: MapiWriter,
  propType: number,
  value: unknown,
): void {
  switch (propType) {
    case PropType.Int16:
      w.writeUint16(Number(value ?? 0) & 0xFFFF);
      return;
    case PropType.Int32:
    case PropType.ErrorCode:
      w.writeUint32(Number(value ?? 0) >>> 0);
      return;
    case PropType.Int64:
      w.writeUint64(typeof value === 'bigint' ? value : BigInt(Number(value ?? 0)));
      return;
    case PropType.Boolean:
      w.writeUint8(value ? 1 : 0);
      return;
    case PropType.Unicode: {
      // PT_UNICODE: null-terminierter UTF-16-LE String. Outlook expects keine
      // länge — der String wird bis zum 00 00 gelesen.
      w.writeUtf16String(String(value ?? ''));
      return;
    }
    case PropType.String8: {
      // ASCII / codepage. Wir senden UTF-8 (Outlook akzeptiert)
      const bytes = Buffer.from(String(value ?? ''), 'utf-8');
      w.writeBuffer(bytes);
      w.writeUint8(0); // null-terminator
      return;
    }
    case PropType.SysTime: {
      // FILETIME = 8 Bytes
      let ft: bigint;
      if (value instanceof Date) ft = dateToFiletime(value);
      else if (typeof value === 'bigint') ft = value;
      else if (typeof value === 'number') ft = dateToFiletime(new Date(value));
      else ft = 0n;
      w.writeUint64(ft);
      return;
    }
    case PropType.Binary: {
      // length-prefixed (uint16) Bytes
      const buf = value instanceof Buffer ? value : Buffer.from(String(value ?? ''), 'utf-8');
      w.writeUint16(buf.length);
      w.writeBuffer(buf);
      return;
    }
    case PropType.ClassId: {
      // 16-Byte GUID
      const guid = value instanceof Buffer && value.length === 16
        ? value
        : Buffer.alloc(16);
      w.writeBuffer(guid);
      return;
    }
    // v5.2.0: Multi-Value Property Types (MS-OXCDATA §2.11.1.6)
    case PropType.MultipleInt16: {
      const arr = Array.isArray(value) ? (value as number[]) : [];
      w.writeUint16(arr.length);
      for (const n of arr) w.writeUint16(n & 0xFFFF);
      return;
    }
    case PropType.MultipleInt32: {
      const arr = Array.isArray(value) ? (value as number[]) : [];
      w.writeUint16(arr.length);
      for (const n of arr) w.writeUint32(n >>> 0);
      return;
    }
    case PropType.MultipleString: {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      w.writeUint16(arr.length);
      for (const s of arr) {
        const bytes = Buffer.from(s, 'utf-8');
        w.writeBuffer(bytes);
        w.writeUint8(0);
      }
      return;
    }
    case PropType.MultipleUnicode: {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      w.writeUint16(arr.length);
      for (const s of arr) w.writeUtf16String(s);
      return;
    }
    case PropType.MultipleSysTime: {
      const arr = Array.isArray(value) ? (value as Array<Date | bigint>) : [];
      w.writeUint16(arr.length);
      for (const v of arr) {
        const ft = v instanceof Date ? dateToFiletime(v) : (typeof v === 'bigint' ? v : 0n);
        w.writeUint64(ft);
      }
      return;
    }
    case PropType.MultipleBinary: {
      const arr = Array.isArray(value) ? (value as Buffer[]) : [];
      w.writeUint16(arr.length);
      for (const b of arr) {
        const buf = Buffer.isBuffer(b) ? b : Buffer.alloc(0);
        w.writeUint16(buf.length);
        w.writeBuffer(buf);
      }
      return;
    }
    default:
      throw new RangeError(`writePropertyValue: PropertyType 0x${propType.toString(16)} not supported`);
  }
}

/**
 * Liest einen Property-Value (ohne Tag) zurück.
 */
export function readPropertyValue(r: MapiReader, propType: number): unknown {
  switch (propType) {
    case PropType.Int16:    return r.readUint16();
    case PropType.Int32:
    case PropType.ErrorCode: return r.readUint32();
    case PropType.Int64:    return r.readUint64();
    case PropType.Boolean:  return r.readUint8() !== 0;
    case PropType.Unicode:  return r.readUtf16String();
    case PropType.String8: {
      // Read ASCII null-terminated
      return r.readAsciiString();
    }
    case PropType.SysTime:  return filetimeToDate(r.readUint64());
    case PropType.Binary: {
      const len = r.readUint16();
      return r.readBuffer(len);
    }
    case PropType.ClassId:  return r.readGuid();
    case PropType.MultipleInt16: {
      const cnt = r.readUint16();
      const out: number[] = [];
      for (let i = 0; i < cnt; i++) out.push(r.readUint16());
      return out;
    }
    case PropType.MultipleInt32: {
      const cnt = r.readUint16();
      const out: number[] = [];
      for (let i = 0; i < cnt; i++) out.push(r.readUint32());
      return out;
    }
    case PropType.MultipleUnicode: {
      const cnt = r.readUint16();
      const out: string[] = [];
      for (let i = 0; i < cnt; i++) out.push(r.readUtf16String());
      return out;
    }
    case PropType.MultipleString: {
      const cnt = r.readUint16();
      const out: string[] = [];
      for (let i = 0; i < cnt; i++) out.push(r.readAsciiString());
      return out;
    }
    case PropType.MultipleSysTime: {
      const cnt = r.readUint16();
      const out: Date[] = [];
      for (let i = 0; i < cnt; i++) out.push(filetimeToDate(r.readUint64()));
      return out;
    }
    case PropType.MultipleBinary: {
      const cnt = r.readUint16();
      const out: Buffer[] = [];
      for (let i = 0; i < cnt; i++) {
        const len = r.readUint16();
        out.push(r.readBuffer(len));
      }
      return out;
    }
    default:
      throw new RangeError(`readPropertyValue: PropertyType 0x${propType.toString(16)} not supported`);
  }
}

/**
 * Schreibt einen TaggedPropertyValue (PropertyTag + Value).
 */
export function writeTaggedProperty(
  w: MapiWriter,
  tag: number,
  value: unknown,
): void {
  w.writeUint32(tag);
  writePropertyValue(w, getPropType(tag), value);
}

/**
 * Property-Row: ein Array von Property-Werten für eine Tabellen-Zeile.
 * Format: HasError flag (1B) + per-Column value [+ ErrorPropertyValue].
 */
export function writePropertyRow(
  w: MapiWriter,
  columnTags: number[],
  values: Map<number, unknown>,
): void {
  // Outlook erwartet pro Row zuerst einen "Flag" (0=no errors, 1=has errors)
  // Wir setzen 0 — Errors haben wir keine.
  w.writeUint8(0);
  for (const tag of columnTags) {
    const value = values.get(tag);
    if (value === undefined) {
      // Default-Wert für den Type
      writePropertyValue(w, getPropType(tag), defaultValueForType(getPropType(tag)));
    } else {
      writePropertyValue(w, getPropType(tag), value);
    }
  }
}

function defaultValueForType(propType: number): unknown {
  switch (propType) {
    case PropType.Int16:
    case PropType.Int32:    return 0;
    case PropType.Int64:    return 0n;
    case PropType.Boolean:  return false;
    case PropType.Unicode:
    case PropType.String8:  return '';
    case PropType.SysTime:  return 0n;
    case PropType.Binary:   return Buffer.alloc(0);
    case PropType.ClassId:  return Buffer.alloc(16);
    default:                return null;
  }
}
