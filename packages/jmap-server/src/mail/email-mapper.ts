/**
 * CoreMail Message → JMAP Email (RFC 8621 §4).
 * bodyStructure wird aus den DB-Feldern synthetisiert:
 *   multipart/mixed[ multipart/alternative[ text/plain, text/html ], Anhänge… ]
 * Header-Properties (`headers`, `header:*`, `references`) werden nur bei Bedarf
 * aus der Rohnachricht gelesen (MinIO + mailparser).
 */
import type { EmailAddress, EmailBodyPart, EmailBodyValue, EmailHeader, JsonObject } from '../types.js';
import { flagsToKeywords } from './keywords.js';
import { loadRawMessage, parseHeaders, parseAddress, splitMessageIds, stripAngle, type DbMessageLike } from './raw.js';

export interface MappableMessage extends DbMessageLike {
  folderId: string;
  flags: string[];
  createdAt: Date;
  rawSize: number;
  threadId: string | null;
}

export const DEFAULT_EMAIL_PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt',
  'messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo',
  'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
];
export const DEFAULT_BODY_PROPERTIES = [
  'partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location',
];

export interface MapOptions {
  properties: string[] | null;
  bodyProperties: string[] | null;
  fetchTextBodyValues: boolean;
  fetchHTMLBodyValues: boolean;
  fetchAllBodyValues: boolean;
  maxBodyValueBytes: number;
}

export function utcDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function previewOf(msg: { bodyText: string; bodyHtml: string }): string {
  const src = msg.bodyText || msg.bodyHtml.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return src.replace(/\s+/g, ' ').trim().slice(0, 256);
}

function part(p: Partial<EmailBodyPart> & { type: string; size: number }): EmailBodyPart {
  return {
    partId: null, blobId: null, headers: [], name: null, charset: null, disposition: null,
    cid: null, language: null, location: null, subParts: null, ...p,
  };
}

export interface Structure {
  root: EmailBodyPart;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
}

export function buildStructure(msg: MappableMessage): Structure {
  const textLen = Buffer.byteLength(msg.bodyText, 'utf8');
  const htmlLen = Buffer.byteLength(msg.bodyHtml, 'utf8');
  const textPart = part({
    partId: '1', blobId: `p-${msg.id}-text`, type: 'text/plain', charset: 'utf-8', size: textLen,
    headers: [{ name: 'Content-Type', value: ' text/plain; charset=utf-8' }],
  });
  const htmlPart = part({
    partId: '2', blobId: `p-${msg.id}-html`, type: 'text/html', charset: 'utf-8', size: htmlLen,
    headers: [{ name: 'Content-Type', value: ' text/html; charset=utf-8' }],
  });
  const bodyParts: EmailBodyPart[] = [];
  if (msg.bodyText || !msg.bodyHtml) bodyParts.push(textPart);
  if (msg.bodyHtml) bodyParts.push(htmlPart);

  const attParts = msg.attachments.map((a, i) => part({
    partId: String(3 + i),
    blobId: `a-${a.id}`,
    type: a.mimeType || 'application/octet-stream',
    size: a.size,
    name: a.filename || null,
    disposition: a.inline ? 'inline' : 'attachment',
    cid: a.contentId ? stripAngle(a.contentId) : null,
    headers: [
      { name: 'Content-Type', value: ` ${a.mimeType || 'application/octet-stream'}` },
      { name: 'Content-Disposition', value: ` ${a.inline ? 'inline' : 'attachment'}; filename="${a.filename}"` },
    ],
  }));

  const bodyRoot: EmailBodyPart = bodyParts.length === 1
    ? bodyParts[0]!
    : part({ type: 'multipart/alternative', size: 0, subParts: bodyParts, headers: [{ name: 'Content-Type', value: ' multipart/alternative' }] });
  const root: EmailBodyPart = attParts.length
    ? part({ type: 'multipart/mixed', size: 0, subParts: [bodyRoot, ...attParts], headers: [{ name: 'Content-Type', value: ' multipart/mixed' }] })
    : bodyRoot;

  return {
    root,
    textBody: [msg.bodyText || !msg.bodyHtml ? textPart : htmlPart],
    htmlBody: [msg.bodyHtml ? htmlPart : textPart],
    attachments: attParts,
    hasAttachment: attParts.some((p) => p.disposition === 'attachment' || !p.cid),
  };
}

function pickBodyProps(p: EmailBodyPart, props: string[]): JsonObject {
  const out: JsonObject = {};
  for (const k of props) {
    if (k.startsWith('header:')) { out[k] = headerProp(p.headers, k); continue; }
    if (k === 'subParts') { out[k] = p.subParts ? p.subParts.map((s) => pickBodyProps(s, props)) : null; continue; }
    if (k in p) out[k] = (p as unknown as JsonObject)[k];
  }
  return out;
}

function needsRaw(props: string[]): boolean {
  return props.some((p) => p === 'headers' || p === 'references' || p.startsWith('header:'));
}

function truncate(value: string, max: number): EmailBodyValue {
  if (max > 0 && Buffer.byteLength(value, 'utf8') > max) {
    let cut = Buffer.from(value, 'utf8').subarray(0, max).toString('utf8');
    cut = cut.replace(/�+$/, '');
    return { value: cut, isEncodingProblem: false, isTruncated: true };
  }
  return { value, isEncodingProblem: false, isTruncated: false };
}

// ── header:<Name>[:as<Form>][:all] (RFC 8621 §4.1.3) ────────────────────────

function headerProp(lines: EmailHeader[], key: string): unknown {
  const m = /^header:([^:]+)(?::as([A-Za-z]+))?(?::all)?$/.exec(key);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const form = m[2] ?? 'Raw';
  const all = key.endsWith(':all');
  const matches = lines.filter((h) => h.name.toLowerCase() === name);
  const conv = (h: EmailHeader): unknown => {
    const unfolded = h.value.replace(/\r\n[ \t]/g, ' ');
    switch (form) {
      case 'Raw': return h.value;
      case 'Text': return decodeWords(unfolded).trim();
      case 'Addresses': return splitAddresses(decodeWords(unfolded));
      case 'GroupedAddresses': return [{ name: null, addresses: splitAddresses(decodeWords(unfolded)) }];
      case 'MessageIds': return splitMessageIds(unfolded);
      case 'Date': { const d = new Date(unfolded.trim()); return isNaN(d.getTime()) ? null : d.toISOString(); }
      case 'URLs': return unfolded.split(',').map((s) => s.trim().replace(/^<|>$/g, '')).filter(Boolean);
      default: return h.value;
    }
  };
  if (all) return matches.map(conv);
  const last = matches[matches.length - 1];
  return last ? conv(last) : null;
}

function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
    try {
      const charset = cs.toLowerCase() === 'utf8' ? 'utf-8' : cs;
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch { return data; }
  });
}

function splitAddresses(s: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  let cur = ''; let depth = 0; let inQuote = false;
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) { if (ch === '<') depth++; if (ch === '>') depth--; }
    if (ch === ',' && !inQuote && depth === 0) { if (cur.trim()) out.push(parseAddress(cur)); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(parseAddress(cur));
  return out;
}

// ── Hauptmapper ──────────────────────────────────────────────────────────────

export async function toJmapEmail(msg: MappableMessage, threadId: string, opts: MapOptions): Promise<JsonObject> {
  const props = opts.properties ?? DEFAULT_EMAIL_PROPERTIES;
  const bodyProps = opts.bodyProperties ?? DEFAULT_BODY_PROPERTIES;
  const structure = buildStructure(msg);
  const out: JsonObject = { id: msg.id };

  let headerLines: EmailHeader[] | null = null;
  let references: string[] = [];
  let sender: EmailAddress[] | null = null;
  if (needsRaw(props)) {
    try {
      const raw = await loadRawMessage(msg);
      const parsed = await parseHeaders(raw);
      headerLines = parsed.lines;
      references = splitMessageIds(parsed.parsed.references ?? null);
      const senderHdr = parsed.lines.find((h) => h.name.toLowerCase() === 'sender');
      if (senderHdr) sender = splitAddresses(decodeWords(senderHdr.value));
    } catch {
      headerLines = [];
    }
  }
  if (!headerLines) {
    headerLines = [
      { name: 'From', value: ` ${msg.fromName ? `"${msg.fromName}" <${msg.fromAddr}>` : msg.fromAddr}` },
      { name: 'To', value: ` ${msg.toAddrs.join(', ')}` },
      ...(msg.ccAddrs.length ? [{ name: 'Cc', value: ` ${msg.ccAddrs.join(', ')}` }] : []),
      { name: 'Subject', value: ` ${msg.subject}` },
      { name: 'Date', value: ` ${msg.date.toUTCString()}` },
      ...(msg.messageId ? [{ name: 'Message-ID', value: ` <${stripAngle(msg.messageId)}>` }] : []),
      ...(msg.inReplyTo ? [{ name: 'In-Reply-To', value: ` <${stripAngle(msg.inReplyTo)}>` }] : []),
    ];
  }

  for (const p of props) {
    switch (p) {
      case 'id': break;
      case 'blobId': out[p] = `m-${msg.id}`; break;
      case 'threadId': out[p] = threadId; break;
      case 'mailboxIds': out[p] = { [msg.folderId]: true }; break;
      case 'keywords': out[p] = flagsToKeywords(msg.flags); break;
      case 'size': out[p] = msg.rawSize || Buffer.byteLength(msg.bodyText) + Buffer.byteLength(msg.bodyHtml); break;
      case 'receivedAt': out[p] = utcDate(msg.createdAt); break;
      case 'messageId': out[p] = msg.messageId ? [stripAngle(msg.messageId)] : null; break;
      case 'inReplyTo': out[p] = msg.inReplyTo ? splitMessageIds(msg.inReplyTo) : null; break;
      case 'references': out[p] = references.length ? references : null; break;
      case 'sender': out[p] = sender; break;
      case 'from': out[p] = msg.fromAddr ? [{ name: msg.fromName || null, email: msg.fromAddr }] : null; break;
      case 'to': out[p] = msg.toAddrs.length ? msg.toAddrs.map(parseAddress) : null; break;
      case 'cc': out[p] = msg.ccAddrs.length ? msg.ccAddrs.map(parseAddress) : null; break;
      case 'bcc': out[p] = msg.bccAddrs.length ? msg.bccAddrs.map(parseAddress) : null; break;
      case 'replyTo': out[p] = msg.replyTo ? [parseAddress(msg.replyTo)] : null; break;
      case 'subject': out[p] = msg.subject; break;
      case 'sentAt': out[p] = msg.date.toISOString(); break;
      case 'hasAttachment': out[p] = structure.hasAttachment; break;
      case 'preview': out[p] = previewOf(msg); break;
      case 'headers': out[p] = headerLines; break;
      case 'bodyStructure': out[p] = pickBodyProps(structure.root, bodyProps); break;
      case 'textBody': out[p] = structure.textBody.map((b) => pickBodyProps(b, bodyProps)); break;
      case 'htmlBody': out[p] = structure.htmlBody.map((b) => pickBodyProps(b, bodyProps)); break;
      case 'attachments': out[p] = structure.attachments.map((b) => pickBodyProps(b, bodyProps)); break;
      case 'bodyValues': {
        const values: Record<string, EmailBodyValue> = {};
        const want = new Set<string>();
        if (opts.fetchAllBodyValues) { want.add('1'); want.add('2'); }
        if (opts.fetchTextBodyValues) for (const b of structure.textBody) if (b.partId) want.add(b.partId);
        if (opts.fetchHTMLBodyValues) for (const b of structure.htmlBody) if (b.partId) want.add(b.partId);
        if (want.has('1') && (msg.bodyText || !msg.bodyHtml)) values['1'] = truncate(msg.bodyText, opts.maxBodyValueBytes);
        if (want.has('2') && msg.bodyHtml) values['2'] = truncate(msg.bodyHtml, opts.maxBodyValueBytes);
        out[p] = values;
        break;
      }
      default:
        if (p.startsWith('header:')) out[p] = headerProp(headerLines, p);
        // unbekannte Properties werden vom Aufrufer vorher als invalidArguments abgewiesen
    }
  }
  return out;
}

export function parseMapOptions(args: JsonObject): MapOptions {
  const props = Array.isArray(args['properties']) ? (args['properties'] as string[]) : null;
  const bodyProps = Array.isArray(args['bodyProperties']) ? (args['bodyProperties'] as string[]) : null;
  const maxBytes = typeof args['maxBodyValueBytes'] === 'number' ? args['maxBodyValueBytes'] : 0;
  return {
    properties: props ? [...new Set(['id', ...props])] : null,
    bodyProperties: bodyProps,
    fetchTextBodyValues: args['fetchTextBodyValues'] === true,
    fetchHTMLBodyValues: args['fetchHTMLBodyValues'] === true,
    fetchAllBodyValues: args['fetchAllBodyValues'] === true,
    maxBodyValueBytes: maxBytes,
  };
}

const KNOWN_EMAIL_PROPS = new Set([...DEFAULT_EMAIL_PROPERTIES, 'headers', 'bodyStructure']);
export function invalidEmailProperties(props: string[] | null): string[] {
  if (!props) return [];
  return props.filter((p) => !KNOWN_EMAIL_PROPS.has(p) && !/^header:[^:]+(:as[A-Za-z]+)?(:all)?$/.test(p));
}
