/**
 * Deterministic RFC 5322 reconstruction from database columns.
 *
 * Only used for legacy messages that were stored before raw-always storage
 * (no `storagePath`). The output is a function of its input alone — the MIME
 * boundaries and a missing Message-ID are derived from a content hash — so
 * repeated FETCH/RETR calls return identical octets and copies of a message
 * map to the same content-addressed object.
 *
 * Header values coming from the database are attacker-controlled (they were
 * parsed from received mail). CR, LF and other control characters are removed
 * so a value can never terminate its header line and inject further headers or
 * a body. Non-ASCII text is emitted as RFC 2047 encoded words.
 *
 * Pure module: only `node:crypto`.
 */
import { createHash } from 'node:crypto';

export interface FallbackFields {
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string;
}

export interface FallbackAttachment {
  filename: string;
  mimeType: string;
  contentId: string | null;
  inline: boolean;
  content: Buffer;
}

/** Removes CR, LF, NUL and other C0/C1 controls (except TAB → space) from a header value. */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// eslint-disable-next-line no-control-regex
const isAscii = (s: string): boolean => /^[ -~]*$/.test(s);

/** RFC 2047 B-encoding in UTF-8, split so that no encoded word exceeds 75 characters. */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Unstructured header text (Subject): sanitized; encoded words when not plain ASCII. */
export function encodeUnstructured(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (isAscii(clean) && !/=\?/.test(clean)) return clean;
  return encodeWords(clean);
}

/** A bare addr-spec cleaned of anything that could break the header syntax. */
export function sanitizeAddrSpec(addr: string): string {
  return sanitizeHeaderValue(addr).replace(/[<>,;:"()\\\s[\]]/g, '');
}

/** "Display Name" <addr> (display name quoted or encoded), or the bare address. */
export function formatMailbox(name: string, addr: string): string {
  const spec = sanitizeAddrSpec(addr);
  const display = sanitizeHeaderValue(name);
  if (!display) return spec;
  const phrase = isAscii(display)
    ? `"${display.replace(/[\\"]/g, '\\$&')}"`
    : encodeWords(display);
  return `${phrase} <${spec}>`;
}

/** A stored address entry: either "addr" or "Name <addr>". */
function formatStoredAddress(entry: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
  if (m) return formatMailbox(m[1] ?? '', m[2] ?? '');
  return sanitizeAddrSpec(entry);
}

function formatMsgId(id: string): string {
  const clean = sanitizeHeaderValue(id).replace(/[<>\s]/g, '');
  return clean ? `<${clean}>` : '';
}

/** RFC 5322 date-time in UTC: "Tue, 03 Feb 2026 10:20:30 +0000". */
export function formatRfc5322Date(d: Date): string {
  const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
  return t.toUTCString().replace(/GMT$/, '+0000');
}

/** Normalize line endings to CRLF. */
function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/** Body part encoding: 8bit/7bit text when lines fit RFC 5322 limits, base64 otherwise. */
function encodeTextBody(text: string): { cte: string; body: Buffer } {
  const normalized = crlf(text);
  const buf = Buffer.from(normalized, 'utf8');
  const longLine = normalized.split('\r\n').some((l) => Buffer.byteLength(l, 'utf8') > 998);
  if (longLine || normalized.includes('\u0000')) return { cte: 'base64', body: base64Lines(buf) };
  return { cte: isAscii(normalized.replace(/\r\n|\t/g, '')) ? '7bit' : '8bit', body: buf };
}

function base64Lines(buf: Buffer): Buffer {
  const b64 = buf.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return Buffer.from(lines.join('\r\n'), 'ascii');
}

/** Content-Type / Content-Disposition parameter: quoted ASCII or RFC 2231 extended value. */
function param(name: string, value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (isAscii(clean)) return `${name}="${clean.replace(/[\\"]/g, '\\$&')}"`;
  const pct = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${name}*=UTF-8''${pct}`;
}

function safeMimeType(t: string): string {
  const clean = sanitizeHeaderValue(t).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean) ? clean : 'application/octet-stream';
}

interface Part { headers: string[]; body: Buffer }

function textPart(kind: 'plain' | 'html', text: string): Part {
  const { cte, body } = encodeTextBody(text);
  return {
    headers: [`Content-Type: text/${kind}; charset=utf-8`, `Content-Transfer-Encoding: ${cte}`],
    body,
  };
}

function multipart(subtype: string, boundary: string, parts: Part[]): Part {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n`, 'utf8'));
    chunks.push(p.body);
    chunks.push(Buffer.from('\r\n', 'ascii'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'));
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body: Buffer.concat(chunks),
  };
}

/** Rebuilds an RFC 5322 message from database columns (legacy rows only). */
export function buildRfc822FromFields(f: FallbackFields, attachments: FallbackAttachment[] = []): Buffer {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([
    f.subject, f.fromAddr, f.fromName, f.toAddrs, f.ccAddrs, f.replyTo, f.messageId, f.inReplyTo,
    f.date instanceof Date ? f.date.toISOString() : String(f.date), f.bodyText, f.bodyHtml,
  ]));
  for (const a of attachments) hash.update(a.filename).update(a.mimeType).update(a.content);
  const digest = hash.digest('hex');
  const boundary = (level: number): string => `=_coremail_${level}_${digest.slice(0, 24)}`;

  const header: string[] = [
    `Date: ${formatRfc5322Date(f.date instanceof Date ? f.date : new Date(f.date))}`,
    `From: ${formatMailbox(f.fromName, f.fromAddr)}`,
  ];
  const subject = encodeUnstructured(f.subject ?? '');
  header.push(subject ? `Subject: ${subject}` : 'Subject:');
  const to = f.toAddrs.map(formatStoredAddress).filter(Boolean);
  const cc = f.ccAddrs.map(formatStoredAddress).filter(Boolean);
  if (to.length) header.push(`To: ${to.join(',\r\n ')}`);
  if (cc.length) header.push(`Cc: ${cc.join(',\r\n ')}`);
  if (f.replyTo) {
    const rt = formatStoredAddress(f.replyTo);
    if (rt) header.push(`Reply-To: ${rt}`);
  }
  header.push(`Message-ID: ${formatMsgId(f.messageId ?? '') || `<reconstructed.${digest.slice(0, 32)}@coremail.invalid>`}`);
  const irt = f.inReplyTo ? formatMsgId(f.inReplyTo) : '';
  if (irt) header.push(`In-Reply-To: ${irt}`);
  header.push('MIME-Version: 1.0');

  const hasText = !!f.bodyText;
  const hasHtml = !!f.bodyHtml;
  let body: Part;
  if (hasText && hasHtml) body = multipart('alternative', boundary(2), [textPart('plain', f.bodyText), textPart('html', f.bodyHtml)]);
  else if (hasHtml) body = textPart('html', f.bodyHtml);
  else body = textPart('plain', f.bodyText ?? '');

  if (attachments.length > 0) {
    const attParts: Part[] = attachments.map((a) => {
      const headers = [
        `Content-Type: ${safeMimeType(a.mimeType)}; ${param('name', a.filename || 'attachment')}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; ${param('filename', a.filename || 'attachment')}`,
      ];
      const cid = a.contentId ? formatMsgId(a.contentId) : '';
      if (cid) headers.push(`Content-ID: ${cid}`);
      return { headers, body: base64Lines(a.content) };
    });
    body = multipart('mixed', boundary(1), [body, ...attParts]);
  }

  return Buffer.concat([
    Buffer.from(`${[...header, ...body.headers].join('\r\n')}\r\n\r\n`, 'utf8'),
    body.body,
  ]);
}
