/**
 * IMAP command tokenizer (RFC 9051 §4, §9).
 *
 * Input is a complete command as delivered by the CommandReader: text lines
 * (without CRLF) interleaved with literal octets. Every text segment that is
 * followed by a literal ends with its literal marker "{n}" or "{n+}".
 *
 *   ["A1 LOGIN {16+}", <16 octets>, " {6+}", <6 octets>, ""]
 *
 * Output is a token tree: atoms, quoted strings (escapes resolved), literals
 * (raw octets) and parenthesised lists. Atoms keep bracketed sections intact,
 * so "BODY.PEEK[HEADER.FIELDS (SUBJECT)]" is a single atom.
 */

export type Token =
  | { type: 'atom'; value: string }
  | { type: 'quoted'; value: string }
  | { type: 'literal'; value: Buffer }
  | { type: 'list'; items: Token[] };

export type CommandSegment = string | Buffer;

export class ImapParseError extends Error {}

const LITERAL_MARKER = /\{(\d+)(\+?)\}$/;

/** Returns the literal size announced at the end of a text line, or null. */
export function literalMarker(line: string): { size: number; sync: boolean } | null {
  const m = LITERAL_MARKER.exec(line);
  if (!m) return null;
  return { size: Number(m[1]), sync: m[2] !== '+' };
}

/**
 * Tokenizes a full command. Throws ImapParseError on malformed input
 * (unterminated quoted string, unbalanced parentheses, bad escapes).
 */
export function tokenize(segments: readonly CommandSegment[]): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  const top = (): Token[] => stack[stack.length - 1] as Token[];

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (typeof seg !== 'string') {
      // A literal segment is consumed together with the preceding marker.
      throw new ImapParseError('Unexpected literal data');
    }
    const next = segments[s + 1];
    let text = seg;
    let literal: Buffer | null = null;
    if (next !== undefined && typeof next !== 'string') {
      const m = LITERAL_MARKER.exec(text);
      if (!m) throw new ImapParseError('Literal without marker');
      text = text.slice(0, m.index);
      literal = next;
      s++; // skip the literal segment
    }

    let i = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === ' ') { i++; continue; }
      if (ch === '(') { const list: Token = { type: 'list', items: [] }; top().push(list); stack.push(list.items); i++; continue; }
      if (ch === ')') {
        if (stack.length === 1) throw new ImapParseError('Unbalanced ")"');
        stack.pop(); i++; continue;
      }
      if (ch === '"') {
        let value = '';
        i++;
        let closed = false;
        while (i < text.length) {
          const c = text[i] as string;
          if (c === '\\') {
            const esc = text[i + 1];
            if (esc !== '"' && esc !== '\\') throw new ImapParseError('Invalid escape in quoted string');
            value += esc;
            i += 2;
            continue;
          }
          if (c === '"') { closed = true; i++; break; }
          value += c;
          i++;
        }
        if (!closed) throw new ImapParseError('Unterminated quoted string');
        top().push({ type: 'quoted', value });
        continue;
      }
      // Atom (may contain a bracketed section with spaces/parentheses)
      let value = '';
      let depth = 0;
      while (i < text.length) {
        const c = text[i] as string;
        if (depth === 0 && (c === ' ' || c === '(' || c === ')')) break;
        if (c === '[') depth++;
        else if (c === ']' && depth > 0) depth--;
        value += c;
        i++;
      }
      top().push({ type: 'atom', value });
    }

    if (literal) top().push({ type: 'literal', value: literal });
  }

  if (stack.length !== 1) throw new ImapParseError('Unbalanced "("');
  return root;
}

/** Tokenizes a partial command whose last text segment ends with a literal marker. */
export function tokenizePrefix(segments: readonly CommandSegment[]): Token[] {
  const copy = [...segments];
  const last = copy[copy.length - 1];
  if (typeof last === 'string') copy[copy.length - 1] = last.replace(LITERAL_MARKER, '');
  try {
    return tokenize(copy);
  } catch {
    return [];
  }
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** Renders a token back to IMAP syntax (literals are rendered as quoted strings). */
export function renderToken(token: Token): string {
  switch (token.type) {
    case 'atom': return token.value;
    case 'quoted': return quote(token.value);
    case 'literal': return quote(token.value.toString('utf8'));
    case 'list': return `(${token.items.map(renderToken).join(' ')})`;
  }
}

/**
 * Converts a token to the flat string argument the command handlers expect:
 * strings and literals become their (unquoted) value, lists their IMAP rendering.
 */
export function tokenToArg(token: Token): string {
  switch (token.type) {
    case 'atom':
    case 'quoted': return token.value;
    case 'literal': return token.value.toString('utf8');
    case 'list': return renderToken(token);
  }
}

/** String value of an astring / nstring token, or null for lists. */
export function tokenString(token: Token | undefined): string | null {
  if (!token) return null;
  if (token.type === 'list') return null;
  return token.type === 'literal' ? token.value.toString('utf8') : token.value;
}
