/**
 * MIME tree parser with byte offsets (RFC 2045/2046, RFC 5322).
 *
 * Parses an RFC 5322 message into a tree of MIME entities without decoding or
 * copying any content: every node records the byte offsets of its header block
 * and its body inside the original buffer. The protocol servers use it to serve
 * byte-exact sections (IMAP BODY[1.2], BODY[1.MIME], BODY[HEADER.FIELDS ...],
 * POP3 TOP) and to render IMAP BODYSTRUCTURE.
 *
 * Pure module: no runtime imports, safe to use from test stubs.
 *
 * The buffer is viewed as a `latin1` string, which maps every byte to exactly
 * one UTF-16 code unit, so string indices are byte offsets.
 */

export interface HeaderField {
  /** Field name as written (case preserved). */
  name: string;
  /** Unfolded value (latin1 view of the raw octets, leading/trailing whitespace trimmed). */
  value: string;
  /** Byte offset of the first octet of the field. */
  start: number;
  /** Byte offset after the line break that ends the field (including continuation lines). */
  end: number;
}

export interface StructuredValue {
  /** Lower-cased main value (e.g. "text/plain", "attachment"). */
  value: string;
  /** Parameters in order of appearance; names lower-cased, values unquoted. */
  params: Array<[string, string]>;
}

export interface MimeNode {
  /** Part number path ([] for the message itself). */
  path: number[];
  /** Offset of the first header octet. */
  start: number;
  /** Offset of the first body octet (after the blank line that ends the header). */
  bodyStart: number;
  /** Offset after the last body octet. */
  end: number;
  headers: HeaderField[];
  /** Lower-cased media type and subtype. */
  type: string;
  subtype: string;
  params: Array<[string, string]>;
  /** Content-Transfer-Encoding (upper-cased, default "7BIT"). */
  encoding: string;
  id: string | null;
  description: string | null;
  md5: string | null;
  disposition: StructuredValue | null;
  language: string | null;
  location: string | null;
  /** Children of a multipart entity. */
  children: MimeNode[];
  /** Encapsulated message of a message/rfc822 (or message/global) entity. */
  message: MimeNode | null;
}

const MAX_DEPTH = 32;
const MAX_NODES = 2000;

/** Offset of the first body octet: after the first empty line, or `end` when there is none. */
export function findBodyStart(s: string, start: number, end: number): number {
  // Header may be empty: the entity starts with the blank line.
  if (s.startsWith('\r\n', start)) return Math.min(start + 2, end);
  if (s[start] === '\n') return Math.min(start + 1, end);
  let i = start;
  while (i < end) {
    const lf = s.indexOf('\n', i);
    if (lf === -1 || lf >= end) return end;
    const next = lf + 1;
    if (s.startsWith('\r\n', next) && next + 2 <= end) return next + 2;
    if (s[next] === '\n' && next + 1 <= end) return next + 1;
    i = next;
  }
  return end;
}

/** Parses the header fields between `start` and `bodyStart` (continuation lines unfolded). */
export function parseHeaderFields(s: string, start: number, bodyStart: number): HeaderField[] {
  const fields: HeaderField[] = [];
  let i = start;
  let current: HeaderField | null = null;
  while (i < bodyStart) {
    let lf = s.indexOf('\n', i);
    if (lf === -1 || lf >= bodyStart) lf = bodyStart - 1;
    const lineEnd = lf + 1;
    let line = s.slice(i, lineEnd).replace(/\r?\n$/, '');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') { i = lineEnd; continue; }
    if ((line[0] === ' ' || line[0] === '\t') && current) {
      current.value += ' ' + line.trim();
      current.end = lineEnd;
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) {
        current = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), start: i, end: lineEnd };
        fields.push(current);
      } else if (current) {
        // Malformed line without a colon: treat as part of the previous field.
        current.end = lineEnd;
      }
    }
    i = lineEnd;
  }
  return fields;
}

/** First header value with this name (case-insensitive), or null. */
export function headerValue(fields: HeaderField[], name: string): string | null {
  const lower = name.toLowerCase();
  const f = fields.find((h) => h.name.toLowerCase() === lower);
  return f ? f.value : null;
}

/** Removes RFC 5322 comments "( … )" outside quoted strings. */
function stripComments(v: string): string {
  let out = '';
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (c === '\\' && (inQuote || depth > 0)) { if (depth === 0) out += c + (v[i + 1] ?? ''); i++; continue; }
    if (inQuote) { out += c; if (c === '"') inQuote = false; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')' && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (c === '"') inQuote = true;
    out += c;
  }
  return out;
}

/** Parses "value; name=value; name=\"quoted\"" (Content-Type, Content-Disposition). */
export function parseStructuredValue(raw: string): StructuredValue {
  const v = stripComments(raw);
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (inQuote) {
      if (c === '\\' && i + 1 < v.length) { cur += c + v[i + 1]; i++; continue; }
      if (c === '"') inQuote = false;
      cur += c;
      continue;
    }
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === ';') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const value = (parts.shift() ?? '').trim().toLowerCase();
  const params: Array<[string, string]> = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"')) {
      val = val.slice(1, val.endsWith('"') && val.length > 1 ? -1 : undefined).replace(/\\(.)/g, '$1');
    }
    if (name) params.push([name, val]);
  }
  return { value, params };
}

export function paramValue(params: Array<[string, string]>, name: string): string | null {
  const found = params.find(([k]) => k === name);
  return found ? found[1] : null;
}

interface Budget { nodes: number }

function parseNode(
  s: string,
  start: number,
  end: number,
  path: number[],
  depth: number,
  budget: Budget,
  defaultType: 'text/plain' | 'message/rfc822',
): MimeNode {
  budget.nodes++;
  const bodyStart = findBodyStart(s, start, end);
  const headers = parseHeaderFields(s, start, bodyStart);
  const ctRaw = headerValue(headers, 'content-type');
  let ct = ctRaw ? parseStructuredValue(ctRaw) : null;
  if (!ct || !/^[^/\s]+\/[^/\s]+$/.test(ct.value)) {
    ct = defaultType === 'text/plain'
      ? { value: 'text/plain', params: ct?.params.length ? ct.params : [['charset', 'us-ascii']] }
      : { value: 'message/rfc822', params: [] };
  }
  const slash = ct.value.indexOf('/');
  const type = ct.value.slice(0, slash);
  const subtype = ct.value.slice(slash + 1);
  const dispRaw = headerValue(headers, 'content-disposition');
  const node: MimeNode = {
    path,
    start,
    bodyStart,
    end,
    headers,
    type,
    subtype,
    params: ct.params,
    encoding: (stripComments(headerValue(headers, 'content-transfer-encoding') ?? '').trim() || '7BIT').toUpperCase(),
    id: headerValue(headers, 'content-id'),
    description: headerValue(headers, 'content-description'),
    md5: headerValue(headers, 'content-md5'),
    disposition: dispRaw ? parseStructuredValue(dispRaw) : null,
    language: headerValue(headers, 'content-language'),
    location: headerValue(headers, 'content-location'),
    children: [],
    message: null,
  };

  if (depth >= MAX_DEPTH || budget.nodes >= MAX_NODES) return node;

  if (type === 'multipart') {
    const boundary = paramValue(node.params, 'boundary');
    if (boundary) {
      const childDefault = subtype === 'digest' ? 'message/rfc822' : 'text/plain';
      const ranges = splitMultipart(s, bodyStart, end, boundary);
      ranges.forEach(([ps, pe], i) => {
        if (budget.nodes >= MAX_NODES) return;
        node.children.push(parseNode(s, ps, pe, [...path, i + 1], depth + 1, budget, childDefault));
      });
    }
  } else if (type === 'message' && (subtype === 'rfc822' || subtype === 'global')
    && !['BASE64', 'QUOTED-PRINTABLE'].includes(node.encoding)) {
    node.message = parseNode(s, bodyStart, end, path, depth + 1, budget, 'text/plain');
  }
  return node;
}

/**
 * Body ranges of the parts of a multipart body. The line break before a delimiter
 * belongs to the delimiter (RFC 2046 §5.1.1), so it is not part of the preceding part.
 */
export function splitMultipart(s: string, bodyStart: number, end: number, boundary: string): Array<[number, number]> {
  const delim = `--${boundary}`;
  const ranges: Array<[number, number]> = [];
  let partStart = -1;
  let i = bodyStart;
  while (i < end) {
    const pos = s.indexOf(delim, i);
    if (pos === -1 || pos + delim.length > end) break;
    const atLineStart = pos === bodyStart || s[pos - 1] === '\n';
    if (!atLineStart) { i = pos + 1; continue; }
    const after = pos + delim.length;
    const isClose = s.startsWith('--', after);
    // The rest of the delimiter line may only contain whitespace (transport padding).
    let lineEnd = s.indexOf('\n', after);
    if (lineEnd === -1 || lineEnd >= end) lineEnd = end; else lineEnd += 1;
    const tail = s.slice(after + (isClose ? 2 : 0), lineEnd).replace(/\r?\n$/, '');
    if (!isClose && /\S/.test(tail)) { i = pos + 1; continue; }
    if (partStart !== -1) {
      let partEnd = pos;
      if (s[partEnd - 1] === '\n') partEnd--;
      if (s[partEnd - 1] === '\r') partEnd--;
      ranges.push([partStart, Math.max(partStart, partEnd)]);
    }
    if (isClose) return ranges;
    partStart = lineEnd;
    i = lineEnd;
  }
  // No close delimiter: the last part runs to the end of the body.
  if (partStart !== -1 && partStart <= end) ranges.push([partStart, end]);
  return ranges;
}

/** Parses a complete RFC 5322 message. */
export function parseMimeTree(raw: Buffer): MimeNode {
  const s = raw.toString('latin1');
  return parseNode(s, 0, s.length, [], 0, { nodes: 0 }, 'text/plain');
}

/**
 * Children addressed by part numbers below `node` (RFC 9051 §6.4.5):
 *  - multipart → its parts;
 *  - a message (the root or an encapsulated message) that is not multipart → [itself]
 *    ("1" is its body);
 *  - message/rfc822 → the children of the encapsulated message.
 */
function partChildren(node: MimeNode, isMessage: boolean): MimeNode[] {
  if (node.type === 'multipart') return node.children;
  if (isMessage) return [node];
  if (node.message) return partChildren(node.message, true);
  return [];
}

/** Resolves a part path ([] = the message itself). Null when the part does not exist. */
export function resolvePart(root: MimeNode, path: number[]): MimeNode | null {
  let node = root;
  let isMessage = true;
  for (const idx of path) {
    const kids = partChildren(node, isMessage);
    const next = kids[idx - 1];
    if (!next) return null;
    // The root of a single-part message addressed as "1" stays the same node;
    // anything below it is a body part, not a message.
    node = next;
    isMessage = false;
  }
  return node;
}

/** Number of text lines in a byte range (RFC 9051 body-fld-lines). */
export function countLines(raw: Buffer, start: number, end: number): number {
  if (end <= start) return 0;
  let n = 0;
  for (let i = start; i < end; i++) if (raw[i] === 0x0a) n++;
  if (raw[end - 1] !== 0x0a) n++;
  return n;
}

/**
 * Header fields of `node` filtered by name, byte-exact, followed by the blank line
 * (RFC 9051 §6.4.5 HEADER.FIELDS / HEADER.FIELDS.NOT).
 */
export function selectHeaderFields(raw: Buffer, node: MimeNode, names: string[], not: boolean): Buffer {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const chunks: Buffer[] = [];
  for (const f of node.headers) {
    const hit = wanted.has(f.name.toLowerCase());
    if (hit !== not) chunks.push(raw.subarray(f.start, f.end));
  }
  // Every field must end with CRLF before the separating blank line.
  const out: Buffer[] = [];
  for (const c of chunks) {
    out.push(c);
    if (c[c.length - 1] !== 0x0a) out.push(Buffer.from('\r\n'));
  }
  out.push(Buffer.from('\r\n'));
  return Buffer.concat(out);
}

/** The header block of `node` including the separating blank line. */
export function headerBytes(raw: Buffer, node: MimeNode): Buffer {
  const h = raw.subarray(node.start, node.bodyStart);
  // A header without a terminating blank line (message ends in the header): add it.
  if (node.bodyStart === node.end && !/\r?\n\r?\n$/.test(h.toString('latin1')) && h.length > 0) {
    return Buffer.concat([h, Buffer.from(h[h.length - 1] === 0x0a ? '\r\n' : '\r\n\r\n')]);
  }
  return h;
}

/** The body of `node`. */
export function bodyBytes(raw: Buffer, node: MimeNode): Buffer {
  return raw.subarray(node.bodyStart, node.end);
}
