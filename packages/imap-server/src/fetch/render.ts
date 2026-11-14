/**
 * FETCH rendering from the raw message: sections, BODYSTRUCTURE/BODY and ENVELOPE
 * (RFC 9051 §7.5.2). All values pass through imap-string.ts (quoted or literal).
 */
import {
  type MimeNode, type HeaderField, resolvePart, bodyBytes, headerBytes, selectHeaderFields, countLines,
  headerValue, parseAddressList, encodeUnstructured, formatMailbox, formatRfc5322Date, sanitizeHeaderValue,
} from '@coremail/storage';
import { type Chunk, imapString, nstring, joinChunks } from './imap-string.js';
import type { SectionSpec } from './fetch-items.js';

// ── Sections ─────────────────────────────────────────────────────────────────

/** Octets of a section, or null when the part does not exist / the section does not apply. */
export function extractSection(raw: Buffer, root: MimeNode, spec: SectionSpec): Buffer | null {
  let node: MimeNode | null = root;
  if (spec.path.length > 0) node = resolvePart(root, spec.path);
  if (!node) return null;
  switch (spec.kind) {
    case 'FULL': return raw;
    case 'PART': return bodyBytes(raw, node);
    case 'MIME': return headerBytes(raw, node);
    default: break;
  }
  // HEADER / TEXT / HEADER.FIELDS[.NOT]: the message itself, or an encapsulated message/rfc822.
  const msg: MimeNode | null = spec.path.length === 0 ? root : node.message;
  if (!msg) return null;
  switch (spec.kind) {
    case 'HEADER': return headerBytes(raw, msg);
    case 'TEXT': return bodyBytes(raw, msg);
    case 'HEADER.FIELDS': return selectHeaderFields(raw, msg, spec.fields, false);
    case 'HEADER.FIELDS.NOT': return selectHeaderFields(raw, msg, spec.fields, true);
    default: return null;
  }
}

/** Partial fetch "<origin.length>" (RFC 9051 §6.4.5). */
export function applyPartial(data: Buffer, partial: { origin: number; length: number } | null): Buffer {
  if (!partial) return data;
  if (partial.origin >= data.length) return Buffer.alloc(0);
  return data.subarray(partial.origin, partial.origin + partial.length);
}

// ── ENVELOPE ─────────────────────────────────────────────────────────────────

/** Header-like values an envelope is rendered from. */
export interface EnvelopeSource {
  date: string | null;
  subject: string | null;
  from: string | null;
  sender: string | null;
  replyTo: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  inReplyTo: string | null;
  messageId: string | null;
}

/** Header value as octets (headers are viewed as latin1, so this restores the bytes). */
const octets = (v: string): Buffer => Buffer.from(v, 'latin1');

function addressStruct(name: string, address: string): Chunk[] {
  const at = address.lastIndexOf('@');
  const local = at === -1 ? address : address.slice(0, at);
  const host = at === -1 ? '' : address.slice(at + 1);
  return [
    '(',
    ...(name ? imapString(octets(name)) : ['NIL']),
    ' NIL ',
    ...(local ? imapString(octets(local)) : ['NIL']),
    ' ',
    ...(host ? imapString(octets(host)) : ['NIL']),
    ')',
  ];
}

/** Address list: NIL when empty, otherwise "(addr addr …)" incl. RFC 9051 group syntax. */
export function addressList(value: string | null): Chunk[] {
  if (!value) return ['NIL'];
  const out: Chunk[] = [];
  for (const a of parseAddressList(value)) {
    if (a.kind === 'mailbox') {
      if (a.address) out.push(...addressStruct(a.name, a.address));
    } else {
      out.push('(NIL NIL ', ...imapString(octets(a.name || 'group')), ' NIL)');
      for (const m of a.members) if (m.address) out.push(...addressStruct(m.name, m.address));
      out.push('(NIL NIL NIL NIL)');
    }
  }
  return out.length ? ['(', ...out, ')'] : ['NIL'];
}

export function renderEnvelope(e: EnvelopeSource): Chunk[] {
  const from = addressList(e.from);
  const sender = e.sender ? addressList(e.sender) : from;
  const replyTo = e.replyTo ? addressList(e.replyTo) : from;
  return [
    '(',
    ...joinChunks([
      nstring(e.date === null ? null : octets(e.date)),
      nstring(e.subject === null ? null : octets(e.subject)),
      from, sender, replyTo,
      addressList(e.to), addressList(e.cc), addressList(e.bcc),
      nstring(e.inReplyTo === null ? null : octets(e.inReplyTo)),
      nstring(e.messageId === null ? null : octets(e.messageId)),
    ]),
    ')',
  ];
}

/** Envelope source from raw header fields (values as written, encoded words kept). */
export function envelopeFromHeaders(headers: HeaderField[]): EnvelopeSource {
  const h = (n: string): string | null => headerValue(headers, n);
  return {
    date: h('date'), subject: h('subject'), from: h('from'), sender: h('sender'), replyTo: h('reply-to'),
    to: h('to'), cc: h('cc'), bcc: h('bcc'), inReplyTo: h('in-reply-to'), messageId: h('message-id'),
  };
}

export interface DbEnvelopeMessage {
  date: Date;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
}

/**
 * Envelope source from database columns. Values are sanitized and non-ASCII text
 * is RFC 2047-encoded (as it was on the wire), so the result is plain 7-bit.
 * The returned values are UTF-8 safe ASCII; they are converted like header octets.
 */
export function envelopeFromDb(m: DbEnvelopeMessage): EnvelopeSource {
  const list = (addrs: string[]): string | null => {
    const parts = addrs.map((a) => {
      const mm = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(a);
      return mm ? formatMailbox(mm[1] ?? '', mm[2] ?? '') : formatMailbox('', a);
    }).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  };
  const id = (v: string | null): string | null => {
    const clean = v ? sanitizeHeaderValue(v) : '';
    return clean || null;
  };
  return {
    date: formatRfc5322Date(m.date instanceof Date ? m.date : new Date(m.date)),
    subject: encodeUnstructured(m.subject ?? '').replace(/\r\n /g, ' '),
    from: m.fromAddr ? formatMailbox(m.fromName ?? '', m.fromAddr).replace(/\r\n /g, ' ') : null,
    sender: null,
    replyTo: m.replyTo ? list([m.replyTo]) : null,
    to: list(m.toAddrs ?? []),
    cc: list(m.ccAddrs ?? []),
    bcc: list(m.bccAddrs ?? []),
    inReplyTo: id(m.inReplyTo),
    messageId: id(m.messageId),
  };
}

// ── BODYSTRUCTURE ────────────────────────────────────────────────────────────

function paramList(params: Array<[string, string]>): Chunk[] {
  if (params.length === 0) return ['NIL'];
  return ['(', ...joinChunks(params.flatMap(([k, v]) => [imapString(octets(k)), imapString(octets(v))])), ')'];
}

function extensionTail(node: MimeNode): Chunk[] {
  const disposition: Chunk[] = node.disposition
    ? ['(', ...imapString(octets(node.disposition.value)), ' ', ...paramList(node.disposition.params), ')']
    : ['NIL'];
  return [
    ' ', ...disposition,
    ' ', ...nstring(node.language === null ? null : octets(node.language)),
    ' ', ...nstring(node.location === null ? null : octets(node.location)),
  ];
}

/** BODYSTRUCTURE (extensible = true) or BODY (extensible = false) of a node. */
export function renderBodyStructure(raw: Buffer, node: MimeNode, extensible: boolean): Chunk[] {
  if (node.type === 'multipart' && node.children.length > 0) {
    const out: Chunk[] = ['('];
    for (const child of node.children) out.push(...renderBodyStructure(raw, child, extensible));
    out.push(' ', ...imapString(node.subtype));
    if (extensible) out.push(' ', ...paramList(node.params), ...extensionTail(node));
    out.push(')');
    return out;
  }
  const size = Math.max(0, node.end - node.bodyStart);
  // RFC 2045 §5.2: text without a charset parameter is us-ascii.
  const params = node.type === 'text' && !node.params.some(([k]) => k === 'charset')
    ? [['charset', 'us-ascii'] as [string, string], ...node.params]
    : node.params;
  const out: Chunk[] = [
    '(',
    ...imapString(node.type === 'multipart' ? 'text' : node.type), ' ',
    ...imapString(node.type === 'multipart' ? 'plain' : node.subtype), ' ',
    ...paramList(node.type === 'multipart' ? [] : params), ' ',
    ...nstring(node.id === null ? null : octets(node.id)), ' ',
    ...nstring(node.description === null ? null : octets(node.description)), ' ',
    ...imapString(octets(node.encoding)), ' ',
    String(size),
  ];
  if (node.type === 'text' || node.type === 'multipart') {
    out.push(' ', String(countLines(raw, node.bodyStart, node.end)));
  } else if (node.message) {
    out.push(' ', ...renderEnvelope(envelopeFromHeaders(node.message.headers)));
    out.push(' ', ...renderBodyStructure(raw, node.message, extensible));
    out.push(' ', String(countLines(raw, node.bodyStart, node.end)));
  }
  if (extensible) {
    out.push(' ', ...nstring(node.md5 === null ? null : octets(node.md5)), ...extensionTail(node));
  }
  out.push(')');
  return out;
}
