/**
 * Minimal vCard (RFC 6350 / RFC 2426) parsing toolkit shared by the CardDAV
 * server and the storage contact mapping.
 *
 * Round-trip safety is the point: a property keeps its unfolded source line
 * (`raw`) and serializeVcard() writes it back unchanged, so a writer that only
 * replaces the properties it changes never strips what a CardDAV client stored
 * (TEL, ADR, PHOTO, X-…, grouped `item1.` properties, parameters).
 * 9.5: the field mapping (names, typed lists, dates, groups) lives in
 * @coremail/storage contacts/ (contact-vcard.ts, contact-group-vcard.ts).
 */
import { foldLine, parseContentLine, unfoldLines } from './ical.js';

export interface VcardProperty {
  /** Unfolded source line; written back unchanged unless the property is modified. */
  raw: string;
  /** Group prefix (`item1` of `item1.EMAIL`), upper-case, or null. */
  group: string | null;
  /** Property name without group, upper-case. */
  name: string;
  params: Record<string, string>;
  /** All TYPE values (`TYPE=work,voice`, repeated TYPE, vCard 2.1 bare types), upper-case. */
  types: string[];
  /** Raw (still escaped) value. */
  value: string;
}

export interface VcardDocument {
  /** Properties between BEGIN:VCARD and END:VCARD (BEGIN/END excluded). */
  properties: VcardProperty[];
}

function typesOf(line: string): string[] {
  // Parameter section = everything before the first unquoted colon
  let inQuotes = false;
  let colon = line.length;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) { colon = i; break; }
  }
  const segments = line.slice(0, colon).split(';').slice(1);
  const out: string[] = [];
  for (const s of segments) {
    const eq = s.indexOf('=');
    if (eq < 0) { if (s.trim()) out.push(s.trim().toUpperCase()); continue; } // vCard 2.1: TEL;CELL:
    if (s.slice(0, eq).trim().toUpperCase() !== 'TYPE') continue;
    for (const t of s.slice(eq + 1).replace(/"/g, '').split(',')) if (t.trim()) out.push(t.trim().toUpperCase());
  }
  return out;
}

/** Parse one unfolded content line into a property (null when it is not one). */
export function vcardProperty(line: string): VcardProperty | null {
  const p = parseContentLine(line);
  if (!p) return null;
  const dot = p.name.indexOf('.');
  return {
    raw: line,
    group: dot >= 0 ? p.name.slice(0, dot) : null,
    name: dot >= 0 ? p.name.slice(dot + 1) : p.name,
    params: p.params,
    types: typesOf(line),
    value: p.value,
  };
}

/** Number of top-level vCard objects in `text`. */
export function countVcards(text: string): number {
  let depth = 0;
  let count = 0;
  for (const line of unfoldLines(text)) {
    const p = parseContentLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VCARD') { if (depth === 0) count++; depth++; }
    else if (p.name === 'END' && p.value.trim().toUpperCase() === 'VCARD') depth = Math.max(0, depth - 1);
  }
  return count;
}

/** Parse the first vCard of `text` (null when there is none). */
export function parseVcard(text: string): VcardDocument | null {
  const properties: VcardProperty[] = [];
  let inside = false;
  for (const line of unfoldLines(text)) {
    const p = parseContentLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VCARD') {
      if (inside) break; // nested/second vCard: ignore
      inside = true;
      continue;
    }
    if (p.name === 'END' && p.value.trim().toUpperCase() === 'VCARD') {
      if (inside) return { properties };
      continue;
    }
    if (!inside) continue;
    const prop = vcardProperty(line);
    if (prop) properties.push(prop);
  }
  return inside ? { properties } : null;
}

export function serializeVcard(doc: VcardDocument): string {
  const lines = ['BEGIN:VCARD', ...doc.properties.map((p) => foldLine(p.raw)), 'END:VCARD'];
  return lines.join('\r\n') + '\r\n';
}

/** Split a structured value (`N`, `ORG`, `ADR`) on unescaped semicolons. */
export function splitStructured(value: string): string[] {
  return value.split(/(?<!\\);/);
}

/** The UID of a vCard (null when absent). */
export function vcardUid(text: string): string | null {
  const doc = parseVcard(text);
  const p = doc?.properties.find((x) => x.name === 'UID');
  return p ? p.value.trim() || null : null;
}
