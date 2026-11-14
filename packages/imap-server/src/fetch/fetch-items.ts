/**
 * FETCH data item parser (RFC 9051 §6.4.5).
 *
 * Input is the rendered argument after the sequence set, e.g.
 *   "(UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)]<0.512>)"  or  "ALL".
 */

export type SectionKind = 'FULL' | 'PART' | 'HEADER' | 'HEADER.FIELDS' | 'HEADER.FIELDS.NOT' | 'TEXT' | 'MIME';

export interface SectionSpec {
  /** Part path ([] = the message itself). */
  path: number[];
  kind: SectionKind;
  /** Upper-cased field names for HEADER.FIELDS[.NOT]. */
  fields: string[];
}

export type SimpleItem = 'UID' | 'FLAGS' | 'INTERNALDATE' | 'RFC822.SIZE' | 'ENVELOPE' | 'BODYSTRUCTURE' | 'BODY' | 'MODSEQ'
  | 'RFC822' | 'RFC822.HEADER' | 'RFC822.TEXT';

export type FetchItem =
  | { kind: SimpleItem }
  | { kind: 'SECTION'; peek: boolean; section: SectionSpec; partial: { origin: number; length: number } | null };

export class FetchParseError extends Error {}

const SIMPLE = new Set<string>([
  'UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODYSTRUCTURE', 'BODY', 'MODSEQ',
  'RFC822', 'RFC822.HEADER', 'RFC822.TEXT',
]);

const MACROS: Record<string, SimpleItem[]> = {
  ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
  FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
  FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'],
};

/** Parses the text inside "[...]" of BODY[...]. */
export function parseSection(text: string): SectionSpec {
  const s = text.trim();
  let path: number[] = [];
  let rest = s;
  const m = /^(\d+(?:\.\d+)*)(?:\.(.+))?$/s.exec(s);
  if (m) {
    path = (m[1] ?? '').split('.').map((n) => Number(n));
    if (path.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new FetchParseError('Invalid part number');
    rest = m[2] ?? '';
  }
  const upper = rest.toUpperCase();
  if (upper === '') return { path, kind: path.length ? 'PART' : 'FULL', fields: [] };
  if (upper === 'MIME') {
    if (!path.length) throw new FetchParseError('MIME requires a part number');
    return { path, kind: 'MIME', fields: [] };
  }
  if (upper === 'HEADER' || upper === 'TEXT') return { path, kind: upper, fields: [] };
  const f = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/s.exec(upper);
  if (f) {
    const fields = (f[2] ?? '').trim().split(/\s+/).filter(Boolean).map((n) => n.replace(/^"|"$/g, ''));
    if (fields.length === 0 || fields.some((n) => !/^[\x21-\x39\x3b-\x7e]+$/.test(n))) {
      throw new FetchParseError('Invalid header field list');
    }
    return { path, kind: f[1] ? 'HEADER.FIELDS.NOT' : 'HEADER.FIELDS', fields };
  }
  throw new FetchParseError(`Invalid section "${text}"`);
}

/** Response label of a section, e.g. "1.HEADER.FIELDS (SUBJECT)". */
export function sectionLabel(spec: SectionSpec): string {
  const prefix = spec.path.join('.');
  const suffix = spec.kind === 'FULL' || spec.kind === 'PART'
    ? ''
    : spec.kind.startsWith('HEADER.FIELDS')
      ? `${spec.kind} (${spec.fields.join(' ')})`
      : spec.kind;
  if (prefix && suffix) return `${prefix}.${suffix}`;
  return prefix || suffix;
}

/** Parses the FETCH item list. Throws FetchParseError on anything unknown. */
export function parseFetchItems(input: string): FetchItem[] {
  let s = input.trim();
  if (!s) throw new FetchParseError('Missing FETCH data items');
  const parenthesized = s.startsWith('(');
  if (parenthesized) {
    if (!s.endsWith(')')) throw new FetchParseError('Unbalanced parentheses');
    s = s.slice(1, -1).trim();
  }
  const upperAll = s.toUpperCase();
  if (!parenthesized && MACROS[upperAll]) return MACROS[upperAll]!.map((kind) => ({ kind }));

  const items: FetchItem[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    let name = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '[') name += s[i++];
    const upper = name.toUpperCase();
    if (s[i] === '[') {
      if (upper !== 'BODY' && upper !== 'BODY.PEEK') throw new FetchParseError(`Unknown FETCH item ${name}`);
      const close = s.indexOf(']', i);
      if (close === -1) throw new FetchParseError('Missing "]"');
      const section = parseSection(s.slice(i + 1, close));
      i = close + 1;
      let partial: { origin: number; length: number } | null = null;
      if (s[i] === '<') {
        const gt = s.indexOf('>', i);
        const p = gt === -1 ? null : /^<(\d+)\.(\d+)>$/.exec(s.slice(i, gt + 1));
        if (!p) throw new FetchParseError('Invalid partial specifier');
        const origin = Number(p[1]);
        const length = Number(p[2]);
        if (!Number.isSafeInteger(origin) || !Number.isSafeInteger(length) || length < 1) {
          throw new FetchParseError('Invalid partial specifier');
        }
        partial = { origin, length };
        i = gt + 1;
      }
      if (i < s.length && s[i] !== ' ') throw new FetchParseError('Garbage after section');
      items.push({ kind: 'SECTION', peek: upper === 'BODY.PEEK', section, partial });
      continue;
    }
    if (MACROS[upper]) throw new FetchParseError(`${upper} cannot be combined with other items`);
    if (!SIMPLE.has(upper)) throw new FetchParseError(`Unknown FETCH item ${name}`);
    items.push({ kind: upper as SimpleItem });
  }
  if (items.length === 0) throw new FetchParseError('Missing FETCH data items');
  return items;
}
