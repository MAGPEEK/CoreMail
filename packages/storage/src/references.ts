/**
 * References header (RFC 5322 §3.6.4) — parsing, normalization and the
 * `Message.references` column format (v9.1).
 *
 * Column format: the msg-ids in header order, each with angle brackets, joined by
 * one space ("<a@x> <b@y>"); '' = the message has no References; null = not
 * indexed yet (rows written before 9.1, see references-backfill.ts).
 *
 * Parsing is tolerant (real-world headers are often malformed): comments are
 * removed, every "<…>" token is taken, tokens with whitespace (also folded
 * ones), control characters, nested angle
 * brackets or more than {@link MAX_REFERENCE_ID_LENGTH} characters are skipped,
 * duplicates are removed (first occurrence wins, order kept). A header with no
 * "<…>" token yields nothing. At most {@link MAX_REFERENCES} ids are kept: the
 * first one (thread root) and the last 99 (the nearest ancestors), as RFC 5322
 * §3.6.4 / RFC 5537 §3.4.4 suggest for trimming.
 *
 * Also holds a small, process-local cache storagePath → references. The raw
 * store fills it when it stores octets (raw-message.ts) and the message store
 * reads it when a writer creates a row with that storagePath but without
 * `references` (message-store.ts). Raw objects are content-addressed, so a key
 * always maps to the same octets — a cached value can never be stale.
 *
 * Pure module: no runtime imports.
 */

/** Max ids kept per message. */
export const MAX_REFERENCES = 100;
/** Max length of one msg-id including the angle brackets (RFC 5322 line limit). */
export const MAX_REFERENCE_ID_LENGTH = 998;
/** Max header section scanned for the References field. */
export const MAX_REFERENCES_HEADER_SCAN = 256 * 1024;

/**
 * Removes RFC 5322 comments ("(…)", nested, with quoted-pairs) and quoted strings
 * (obs-phrase words in obs-references) outside msg-ids; neither holds msg-ids.
 */
function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (depth > 0) {
      if (ch === '\\') { i++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    else if (ch === '"' && !inAngle) { inQuote = true; out += ' '; continue; }
    else if (ch === '(' && !inAngle) { depth = 1; out += ' '; continue; }
    out += ch;
  }
  return out;
}

/** Normalized msg-id ("<…>") or null when the token is unusable. */
export function normalizeMsgId(token: string | null | undefined): string | null {
  if (!token) return null;
  let inner = token.trim();
  if (inner.startsWith('<')) inner = inner.slice(1);
  if (inner.endsWith('>')) inner = inner.slice(0, -1);
  if (!inner || /[\s<>\x00-\x1f\x7f]/.test(inner)) return null;
  const id = `<${inner}>`;
  return id.length <= MAX_REFERENCE_ID_LENGTH ? id : null;
}

/** Applies dedupe (first occurrence wins) and the {@link MAX_REFERENCES} cap (first + last 99). */
export function capReferences(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of ids) {
    const id = normalizeMsgId(raw);
    if (id && !seen.has(id)) { seen.add(id); unique.push(id); }
  }
  if (unique.length <= MAX_REFERENCES) return unique;
  return [unique[0]!, ...unique.slice(unique.length - (MAX_REFERENCES - 1))];
}

/** Parses a References (or In-Reply-To) header value into normalized msg-ids, header order. */
export function parseReferences(value: string | readonly string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : value.join(' ');
  if (!text) return [];
  // Bound the work on hostile input: the header section is already capped, this
  // also bounds direct callers.
  const bounded = text.length > MAX_REFERENCES_HEADER_SCAN ? text.slice(0, MAX_REFERENCES_HEADER_SCAN) : text;
  const unfolded = stripComments(bounded.replace(/\r?\n(?=[ \t])/g, ''));
  const tokens = unfolded.match(/<[^<>]*>/g) ?? [];
  return capReferences(tokens);
}

/** Column value for a reference list ('' when empty). */
export function formatReferencesColumn(ids: readonly string[]): string {
  return capReferences(ids).join(' ');
}

/** Reference list of a column value (null/'' → []). */
export function splitReferences(column: string | null | undefined): string[] {
  if (!column) return [];
  return column.split(' ').filter(Boolean);
}

/** End of the header section: offset of the blank line, or -1. */
function headerEnd(raw: Buffer, limit: number): number {
  const scan = raw.length > limit ? raw.subarray(0, limit) : raw;
  const crlf = scan.indexOf('\r\n\r\n');
  const lf = scan.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return crlf;
  return lf;
}

/**
 * Extracts and parses the References header field of raw RFC 5322 octets (top
 * level header section only; the body is never looked at). With several
 * References fields (invalid per RFC 5322 §3.6) the first one is used.
 */
export function extractReferences(raw: Buffer, limit = MAX_REFERENCES_HEADER_SCAN): string[] {
  const end = headerEnd(raw, limit);
  const head = raw.subarray(0, end >= 0 ? end : Math.min(raw.length, limit)).toString('latin1');
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^references[ \t]*:(.*)$/i.exec(lines[i]!);
    if (!m) continue;
    let value = m[1] ?? '';
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) value += ` ${lines[++i]!}`;
    return parseReferences(value);
  }
  return [];
}

/**
 * Reference list for a message as RFC 5256 §2.2 (1A) defines it: the References
 * ids, or — when there are none — the first valid msg-id of In-Reply-To.
 */
export function threadReferencesOf(references: readonly string[], inReplyTo: string | null | undefined): string[] {
  if (references.length > 0) return [...references];
  const first = parseReferences(inReplyTo ?? '')[0];
  return first ? [first] : [];
}

// ─── storagePath → references cache ─────────────────────────────────────────

const CACHE_MAX = 4096;
const cache = new Map<string, string>();

/** Remembers the references of the raw object stored under `storagePath`. */
export function rememberReferences(storagePath: string, ids: readonly string[]): void {
  if (!storagePath) return;
  cache.delete(storagePath);
  cache.set(storagePath, formatReferencesColumn(ids));
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Column value for the raw object `storagePath`, or undefined when not known in this process. */
export function cachedReferencesColumn(storagePath: string | null | undefined): string | undefined {
  if (!storagePath) return undefined;
  return cache.get(storagePath);
}

/** Test helper. */
export function resetReferencesCache(): void {
  cache.clear();
}
