/**
 * Safe rendering of IMAP strings (RFC 9051 §4.3).
 *
 * Every value that originates from a message, the database or a client (subject,
 * names, addresses, mailbox names, header parameters) goes through these helpers.
 * A quoted string may not contain CR, LF, NUL or 8-bit octets, so such values are
 * sent as literals — a CR/LF in a Subject can therefore never end the response
 * line and inject an untagged response such as "* OK [ALERT]".
 */

/** A response fragment: text (ASCII) or raw octets (literal data). */
export type Chunk = string | Buffer;

const MAX_QUOTED = 1000;

function needsLiteral(b: Buffer): boolean {
  if (b.length > MAX_QUOTED) return true;
  for (const byte of b) {
    if (byte < 0x20 || byte >= 0x7f) return true;
  }
  return false;
}

/** IMAP string: quoted when safe, otherwise a literal "{n}\r\n<octets>". */
export function imapString(value: string | Buffer): Chunk[] {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  if (needsLiteral(b)) return [`{${b.length}}\r\n`, b];
  return [`"${b.toString('latin1').replace(/[\\"]/g, '\\$&')}"`];
}

/** nstring: NIL for null/undefined. */
export function nstring(value: string | Buffer | null | undefined): Chunk[] {
  if (value === null || value === undefined) return ['NIL'];
  return imapString(value);
}

/** Literal of raw octets (message content). */
export function literal(data: Buffer): Chunk[] {
  return [`{${data.length}}\r\n`, data];
}

// atom-char minus "\" (system flags start with one backslash) — RFC 9051 §9:
// no CTL, SP, ( ) { % * " \ ], no 8-bit.
const FLAG_RE = /^\\?[\x21\x23\x24\x26\x27\x2b-\x5b\x5e-\x7a\x7c-\x7e]+$/;

/** True when `flag` can be written as a flag atom. */
export function isValidFlag(flag: string): boolean {
  return FLAG_RE.test(flag);
}

/** Flag list "(\Seen $Label)" without values that would break the syntax. */
export function flagList(flags: string[]): string {
  return `(${flags.filter(isValidFlag).join(' ')})`;
}

/** Concatenates chunks into one buffer (text as UTF-8; it is ASCII in practice). */
export function toBuffer(chunks: Chunk[]): Buffer {
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))));
}

/** Joins chunk groups with a separator. */
export function joinChunks(groups: Chunk[][], sep = ' '): Chunk[] {
  const out: Chunk[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push(sep);
    out.push(...g);
  });
  return out;
}

/** Renders a mailbox name for LIST/LSUB/STATUS responses. */
export function mailboxName(name: string): string {
  const chunks = imapString(name);
  return chunks.length === 1 ? (chunks[0] as string) : toBuffer(chunks).toString('utf8');
}
