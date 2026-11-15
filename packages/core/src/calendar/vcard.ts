/**
 * Minimal vCard (RFC 6350 / RFC 2426) toolkit shared by the CardDAV server and the
 * REST contacts API.
 *
 * The important property is round-trip safety: `patchVcard()` rewrites only the
 * properties it is asked to change and copies every other line (TEL, ADR, PHOTO,
 * X-…, grouped `item1.` properties, parameters) verbatim, so a webmail edit never
 * strips what a CardDAV client stored (RFC 6352 §6.3.2).
 */
import { randomUUID } from 'node:crypto';
import { escapeText, foldLine, parseContentLine, unescapeText, unfoldLines } from './ical.js';

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

/** Fields CoreMail indexes in the `contacts` table. */
export interface VcardFields {
  displayName: string;
  email: string;
  email2: string;
  phone: string;
  mobile: string;
  company: string;
  department: string;
  jobTitle: string;
  notes: string;
}

export type VcardPatch = Partial<VcardFields>;

export const VCARD_FIELD_NAMES: ReadonlyArray<keyof VcardFields> = [
  'displayName', 'email', 'email2', 'phone', 'mobile', 'company', 'department', 'jobTitle', 'notes',
];

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

function toProperty(line: string): VcardProperty | null {
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
    const prop = toProperty(line);
    if (prop) properties.push(prop);
  }
  return inside ? { properties } : null;
}

export function serializeVcard(doc: VcardDocument): string {
  const lines = ['BEGIN:VCARD', ...doc.properties.map((p) => foldLine(p.raw)), 'END:VCARD'];
  return lines.join('\r\n') + '\r\n';
}

/** Split a structured value (`N`, `ORG`, `ADR`) on unescaped semicolons. */
function splitStructured(value: string): string[] {
  return value.split(/(?<!\\);/);
}

const isCell = (p: VcardProperty): boolean => p.types.includes('CELL');
const firstText = (doc: VcardDocument, name: string): string => {
  const p = doc.properties.find((x) => x.name === name);
  return p ? unescapeText(p.value).trim() : '';
};

/** The UID of a vCard (null when absent). */
export function vcardUid(text: string): string | null {
  const doc = parseVcard(text);
  const p = doc?.properties.find((x) => x.name === 'UID');
  return p ? p.value.trim() || null : null;
}

/** Extract the indexed fields (folded lines, groups, parameters and escaping handled). */
export function vcardFields(text: string): VcardFields {
  const doc = parseVcard(text) ?? { properties: [] };
  const emails = doc.properties.filter((p) => p.name === 'EMAIL').map((p) => unescapeText(p.value).trim());
  const tels = doc.properties.filter((p) => p.name === 'TEL');
  const org = doc.properties.find((p) => p.name === 'ORG');
  const orgParts = org ? splitStructured(org.value).map((s) => unescapeText(s).trim()) : [];
  let displayName = firstText(doc, 'FN');
  if (!displayName) {
    const n = doc.properties.find((p) => p.name === 'N');
    if (n) {
      const [family = '', given = ''] = splitStructured(n.value).map((s) => unescapeText(s).trim());
      displayName = [given, family].filter(Boolean).join(' ');
    }
  }
  const telValue = (p: VcardProperty | undefined): string => (p ? unescapeText(p.value).replace(/^tel:/i, '').trim() : '');
  return {
    displayName,
    email: emails[0] ?? '',
    email2: emails[1] ?? '',
    phone: telValue(tels.find((p) => !isCell(p))),
    mobile: telValue(tels.find(isCell)),
    company: orgParts[0] ?? '',
    department: orgParts[1] ?? '',
    jobTitle: firstText(doc, 'TITLE'),
    notes: firstText(doc, 'NOTE'),
  };
}

// ─── Patching ────────────────────────────────────────────────────────────────

function render(group: string | null, name: string, paramText: string, value: string): string {
  return `${group ? `${group}.` : ''}${name}${paramText}:${value.replace(/\r\n|\r|\n/g, '\\n')}`;
}

/** Keep the original name/parameter section of `p`, replace only its value. */
function withValue(p: VcardProperty, value: string): VcardProperty {
  let inQuotes = false;
  let colon = p.raw.length;
  for (let i = 0; i < p.raw.length; i++) {
    if (p.raw[i] === '"') inQuotes = !inQuotes;
    else if (p.raw[i] === ':' && !inQuotes) { colon = i; break; }
  }
  const raw = `${p.raw.slice(0, colon)}:${value.replace(/\r\n|\r|\n/g, '\\n')}`;
  return { ...p, raw, value };
}

function fresh(name: string, paramText: string, value: string): VcardProperty {
  const raw = render(null, name, paramText, value);
  return toProperty(raw) ?? { raw, group: null, name, params: {}, types: [], value };
}

/** `N` from a display name: last word = family name, the rest = given name(s). */
export function structuredName(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const family = words.length > 1 ? words[words.length - 1]! : (words[0] ?? '');
  const given = words.length > 1 ? words.slice(0, -1).join(' ') : '';
  return `${escapeText(family)};${escapeText(given)};;;`;
}

/**
 * Apply `patch` to a stored vCard. Only fields present in `patch` are touched
 * (an empty string removes the property); every other line is preserved verbatim.
 * A missing UID is added. A document without a vCard is rebuilt from the patch.
 */
export function patchVcard(text: string, patch: VcardPatch): string {
  const doc = parseVcard(text) ?? { properties: [{ raw: 'VERSION:3.0', group: null, name: 'VERSION', params: {}, types: [], value: '3.0' }] };
  const v4 = (doc.properties.find((p) => p.name === 'VERSION')?.value.trim() ?? '3.0').startsWith('4');
  let props = [...doc.properties];
  const removed = new Set<VcardProperty>();

  const replace = (old: VcardProperty, next: VcardProperty): void => {
    props = props.map((p) => (p === old ? next : p));
  };
  const setOrAdd = (current: VcardProperty | undefined, value: string, make: () => VcardProperty): void => {
    if (current && value) replace(current, withValue(current, value));
    else if (current && !value) removed.add(current);
    else if (!current && value) props.push(make());
  };

  if (patch.displayName !== undefined) {
    const fn = props.find((p) => p.name === 'FN');
    const name = patch.displayName.trim();
    if (fn) replace(fn, withValue(fn, escapeText(name)));
    else props.push(fresh('FN', '', escapeText(name)));
    const n = props.find((p) => p.name === 'N');
    if (n) replace(n, withValue(n, structuredName(name)));
    else props.push(fresh('N', '', structuredName(name)));
  }

  if (patch.email !== undefined || patch.email2 !== undefined) {
    const emails = props.filter((p) => p.name === 'EMAIL');
    const make = (v: string) => () => fresh('EMAIL', v4 ? '' : ';TYPE=INTERNET', escapeText(v));
    if (patch.email !== undefined) setOrAdd(emails[0], patch.email.trim() && escapeText(patch.email.trim()), make(patch.email.trim()));
    if (patch.email2 !== undefined) setOrAdd(emails[1], patch.email2.trim() && escapeText(patch.email2.trim()), make(patch.email2.trim()));
  }

  if (patch.phone !== undefined) {
    const v = patch.phone.trim();
    setOrAdd(props.find((p) => p.name === 'TEL' && !isCell(p)), v && escapeText(v), () => fresh('TEL', v4 ? ';TYPE=voice' : ';TYPE=VOICE', escapeText(v)));
  }
  if (patch.mobile !== undefined) {
    const v = patch.mobile.trim();
    setOrAdd(props.find((p) => p.name === 'TEL' && isCell(p)), v && escapeText(v), () => fresh('TEL', v4 ? ';TYPE=cell' : ';TYPE=CELL', escapeText(v)));
  }

  if (patch.company !== undefined || patch.department !== undefined) {
    const org = props.find((p) => p.name === 'ORG');
    const parts = org ? splitStructured(org.value) : [];
    if (patch.company !== undefined) parts[0] = escapeText(patch.company.trim());
    if (patch.department !== undefined) parts[1] = escapeText(patch.department.trim());
    for (let i = 0; i < parts.length; i++) parts[i] ??= '';
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    const value = parts.join(';');
    setOrAdd(org, value, () => fresh('ORG', '', value));
  }

  if (patch.jobTitle !== undefined) {
    const v = patch.jobTitle.trim();
    setOrAdd(props.find((p) => p.name === 'TITLE'), v && escapeText(v), () => fresh('TITLE', '', escapeText(v)));
  }
  if (patch.notes !== undefined) {
    const v = patch.notes.trim();
    setOrAdd(props.find((p) => p.name === 'NOTE'), v && escapeText(v), () => fresh('NOTE', '', escapeText(v)));
  }

  props = props.filter((p) => !removed.has(p));
  if (!props.some((p) => p.name === 'VERSION')) props.unshift(fresh('VERSION', '', '3.0'));
  if (!props.some((p) => p.name === 'FN')) props.push(fresh('FN', '', ''));
  if (!props.some((p) => p.name === 'UID')) props.push(fresh('UID', '', `urn:uuid:${randomUUID()}`));
  return serializeVcard({ properties: props });
}

/** A fresh vCard 3.0 (FN, N, UID + the given fields), text escaped, lines folded. */
export function buildVcard(fields: VcardPatch & { displayName: string }): string {
  return patchVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n', fields);
}
