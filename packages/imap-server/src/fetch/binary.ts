/**
 * BINARY (RFC 3516, part of IMAP4rev2 — RFC 9051 §6.4.5): content of a body
 * part with its Content-Transfer-Encoding removed.
 */
import { resolvePart, bodyBytes, type MimeNode } from '@coremail/storage';
import type { Chunk } from './imap-string.js';

export class UnknownCteError extends Error {}

function decodeQuotedPrintable(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] as number;
    if (byte !== 0x3d) { out[n++] = byte; continue; } // not "="
    // Soft line break "=\r\n" / "=\n" (trailing whitespace before it is allowed).
    let j = i + 1;
    while (j < data.length && (data[j] === 0x20 || data[j] === 0x09)) j++;
    if (data[j] === 0x0d && data[j + 1] === 0x0a) { i = j + 1; continue; }
    if (data[j] === 0x0a) { i = j; continue; }
    const hex = data.subarray(i + 1, i + 3).toString('latin1');
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[n++] = parseInt(hex, 16); i += 2; continue; }
    out[n++] = byte; // malformed "=" is kept literally (RFC 2045 §6.7 note 1)
  }
  return out.subarray(0, n);
}

/** Removes a Content-Transfer-Encoding; throws UnknownCteError for an unknown one. */
export function decodeTransferEncoding(data: Buffer, encoding: string): Buffer {
  switch (encoding.toUpperCase()) {
    case '7BIT':
    case '8BIT':
    case 'BINARY':
      return data;
    case 'BASE64':
      return Buffer.from(data.toString('latin1').replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
    case 'QUOTED-PRINTABLE':
      return decodeQuotedPrintable(data);
    default:
      throw new UnknownCteError(encoding);
  }
}

/**
 * Decoded octets of the part at `path` ([] = the whole message, sent as is),
 * or null when the part does not exist. Multipart and message parts carry no
 * transfer encoding of their own and are returned unchanged.
 */
export function binarySection(raw: Buffer, root: MimeNode, path: number[]): Buffer | null {
  if (path.length === 0) return raw;
  const node = resolvePart(root, path);
  if (!node) return null;
  const body = bodyBytes(raw, node);
  if (node.type === 'multipart' || node.type === 'message') return body;
  return decodeTransferEncoding(body, node.encoding);
}

/** literal8 ("~{n}") when the data contains NUL, otherwise a normal literal (RFC 3516 §4.2). */
export function binaryLiteral(data: Buffer): Chunk[] {
  return [`${data.includes(0) ? '~' : ''}{${data.length}}\r\n`, data];
}
