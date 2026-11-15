/**
 * Trace information (RFC 5321 §4.4): `Received:` on every hop, `Return-Path:`
 * on final delivery, hop counting against mail loops (§6.3).
 */
import { isValidDomain, oneLine } from '../core/envelope.js';
import type { MessageMeta } from '../core/types.js';

/** §6.3: a message with more Received: headers than this is treated as looping. */
export const MAX_RECEIVED_HOPS = 100;

/** RFC 5322 §3.3 date-time with a numeric zone (never the obsolete "GMT"). */
export function formatRfc5322Date(date = new Date()): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/** Address literal for the TCP-info clause: [192.0.2.1] / [IPv6:2001:db8::1]. */
export function ipLiteral(ip: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) return `[${v4mapped[1]}]`;
  return ip.includes(':') ? `[IPv6:${ip}]` : `[${ip}]`;
}

/**
 * End of the header block: `end` is the offset of the line break that ends the
 * last header field (the empty line follows it), `lineBreak` its length.
 * CRLF and bare-LF messages (ActiveSync/JMAP raw uploads) are both handled;
 * without an empty line the whole message is header (RFC 5322 §2.1).
 */
export function headerBounds(raw: Buffer): { end: number; lineBreak: number } {
  if (raw[0] === 0x0a) return { end: 0, lineBreak: 0 };
  if (raw[0] === 0x0d && raw[1] === 0x0a) return { end: 0, lineBreak: 0 };
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  const lfEnd = lf < 0 ? -1 : raw[lf - 1] === 0x0d ? lf - 1 : lf;  // "…\r\n\n"
  if (lfEnd >= 0 && (crlf < 0 || lfEnd < crlf)) return { end: lfEnd, lineBreak: raw[lfEnd] === 0x0d ? 2 : 1 };
  if (crlf >= 0) return { end: crlf, lineBreak: 2 };
  return { end: raw.length, lineBreak: 0 };
}

function headerEnd(raw: Buffer): number {
  return headerBounds(raw).end;
}

/** Number of Received: header fields in the header block. */
export function countReceived(raw: Buffer): number {
  const head = raw.subarray(0, headerEnd(raw)).toString('latin1');
  return (head.match(/^Received:/gim) ?? []).length;
}

export interface ReceivedOptions {
  ip: string;
  meta: MessageMeta;
  /** Added only for exactly one recipient — never leaks Bcc recipients (§7.2). */
  recipients: string[];
  /** Comment for authenticated submissions. */
  authenticatedUser?: string;
  date?: Date;
}

/** Builds a folded `Received:` field (with trailing CRLF). */
export function buildReceivedHeader(o: ReceivedOptions): string {
  const helo = oneLine(o.meta.helo).replace(/[()\\]/g, '');
  const from = isValidDomain(helo)
    ? `from ${helo} (${ipLiteral(o.ip)})`
    : `from ${ipLiteral(o.ip)}${helo ? ` (helo=${helo.slice(0, 255)})` : ''}`;
  const auth = o.authenticatedUser ? ` (authenticated user ${oneLine(o.authenticatedUser).replace(/[()\\]/g, '')})` : '';
  const single = o.recipients.length === 1 ? o.recipients[0] : undefined;
  const forClause = single ? `\r\n\tfor <${oneLine(single)}>` : '';
  return `Received: ${from}${auth}\r\n\tby ${o.meta.hostname} (CoreMail) with ${o.meta.protocol} id ${o.meta.sessionId}`
    + `${forClause}; ${formatRfc5322Date(o.date)}\r\n`;
}

/**
 * RFC 8601 §5: removes every `Authentication-Results:` field whose authserv-id
 * is our own host name — a sender (or an earlier hop) must not be able to
 * pre-forge "our" verdict. Fields of other authserv-ids stay untouched.
 */
export function stripOwnAuthResults(raw: Buffer, authservId: string): Buffer {
  const id = authservId.trim().toLowerCase();
  if (!id) return raw;
  const { end, lineBreak } = headerBounds(raw);
  const head = raw.subarray(0, end).toString('latin1');
  if (!/^Authentication-Results:/im.test(head)) return raw;
  const fieldRe = /^Authentication-Results:([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)(\r?\n|$)/gim;
  const cleaned = head.replace(fieldRe, (all, value: string) => {
    // authserv-id = first token, CFWS (comments) allowed before it
    const v = value.replace(/\r?\n[ \t]+/g, ' ').replace(/\([^()]*\)/g, ' ').trim();
    const token = (/^([^\s;]+)/.exec(v)?.[1] ?? '').toLowerCase();
    return token === id ? '' : all;
  });
  if (cleaned.length === head.length) return raw;
  const fixedHead = cleaned.replace(/\r?\n$/, '');
  if (fixedHead === '') return raw.subarray(Math.min(end + lineBreak, raw.length)); // only the empty line + body remain
  return Buffer.concat([Buffer.from(fixedHead, 'latin1'), raw.subarray(end)]);
}

/**
 * Pure: keeps only well-formed `Received-SPF:` / `Authentication-Results:`
 * fields (with folded continuation lines) of a security-filter answer —
 * nothing else may be injected into the stored message. '' when none.
 */
export function sanitizeAuthHeaders(headers: string): string {
  const lines = headers.replace(/\r?\n/g, '\r\n').split('\r\n');
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (line === '') { keep = false; continue; }
    if (/^[ \t]/.test(line)) {
      if (keep) out.push(line);
      continue;
    }
    keep = /^(Authentication-Results|Received-SPF):/i.test(line);
    if (keep) out.push(line);
  }
  if (out.length === 0 || /[\0]/.test(out.join(''))) return '';
  return `${out.join('\r\n')}\r\n`;
}

export function prependHeader(raw: Buffer, header: string): Buffer {
  return Buffer.concat([Buffer.from(header, 'utf8'), raw]);
}

/**
 * Final delivery (§4.4): removes Return-Path: fields added by earlier hops and
 * puts `Return-Path: <reverse-path>` at the beginning of the message.
 */
export function withReturnPath(raw: Buffer, reversePath: string): Buffer {
  const { end, lineBreak } = headerBounds(raw);
  const head = raw.subarray(0, end).toString('latin1');
  // Remove existing Return-Path fields (incl. folded continuation lines) — only
  // inside the header block; CRLF or bare-LF line endings.
  const cleaned = head
    .replace(/^Return-Path:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, '')
    .replace(/\r?\n$/, ''); // the removed field was the last one
  // Without remaining fields the prefix's own CRLF ends the (new) header line.
  const body = cleaned === '' ? raw.subarray(Math.min(end + lineBreak, raw.length)) : raw.subarray(end);
  const prefix = `Return-Path: <${oneLine(reversePath)}>\r\n`;
  if (cleaned.length === head.length) return Buffer.concat([Buffer.from(prefix, 'utf8'), raw]);
  return Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(cleaned, 'latin1'), body]);
}
