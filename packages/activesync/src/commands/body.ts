/**
 * EAS 14.1 message representation: AirSyncBase body selection ([MS-ASAIRS]
 * BodyPreference → Body, Attachments, NativeBodyType) and the Email/Email2
 * ApplicationData properties ([MS-ASEMAIL]). Shared by Sync and ItemOperations.
 *
 * MIME (Type 4) is the original RFC 5322 octets from `loadRawMessage()`
 * (byte-exact, written as an inline WBXML string, or OPAQUE if it contains NUL);
 * it is only delivered when MIMESupport allows it ([MS-ASCMD] MIMESupport:
 * 0 = never, 1 = S/MIME messages only, 2 = always).
 *
 * No runtime imports besides the WBXML helpers: callers inject `loadRaw`.
 */
import { createHash } from 'node:crypto';
import { getText, pel, CP, type WbxmlElement } from '../wbxml.js';

export type BodyType = 1 | 2 | 3 | 4; // 1 plain, 2 HTML, 3 RTF, 4 MIME

export interface BodyPreference {
  type: BodyType;
  /** Bytes; undefined = no truncation. */
  truncationSize?: number;
  allOrNone: boolean;
  /** Preview length in characters (1..255); undefined = no preview. */
  preview?: number;
}

export interface BodyOptions {
  prefs: BodyPreference[];
  /** airsync:MIMESupport — 0 never, 1 S/MIME only, 2 always. */
  mimeSupport: 0 | 1 | 2;
  /** airsync:MIMETruncation in bytes (EAS 2.5 compat, used when a Type 4 pref has no TruncationSize). */
  mimeTruncation?: number;
}

export interface EasAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface EasMessage {
  id: string;
  flags: string[];
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  threadId: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string;
  storagePath: string | null;
  smimeMeta: string | null;
  attachments: EasAttachment[];
}

export type LoadRaw = (msg: EasMessage) => Promise<Buffer>;

/** Default body when the client sends no BodyPreference: plain text, 32 KiB. */
export const DEFAULT_BODY_PREFERENCE: BodyPreference = { type: 1, truncationSize: 32 * 1024, allOrNone: false };

// [MS-ASCMD] 2.2.3.108 MIMETruncation 0..8
const MIME_TRUNCATION = [0, 4096, 5120, 7168, 10240, 20480, 51200, 102400];

function intOrUndefined(s: string): number | undefined {
  if (!/^\d{1,10}$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Body options of an airsync/itemoperations `Options` element (null when absent).
 * Several Options (EAS 14.1, one per Class) → the one without Class or Class=Email.
 */
export function parseBodyOptions(parent: WbxmlElement | undefined): BodyOptions | null {
  if (!parent) return null;
  const all = (parent.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string' && c.name === 'Options');
  const options = all.find((o) => { const cls = getText(o, 'Class'); return cls === '' || cls === 'Email'; });
  if (!options) return null;
  const prefs: BodyPreference[] = [];
  for (const c of options.children ?? []) {
    if (typeof c === 'string' || c.name !== 'BodyPreference') continue;
    const type = intOrUndefined(getText(c, 'Type'));
    if (type === undefined || type < 1 || type > 4) continue;
    const pref: BodyPreference = { type: type as BodyType, allOrNone: getText(c, 'AllOrNone') === '1' };
    const trunc = intOrUndefined(getText(c, 'TruncationSize'));
    if (trunc !== undefined) pref.truncationSize = trunc;
    const preview = intOrUndefined(getText(c, 'Preview'));
    if (preview !== undefined && preview > 0) pref.preview = Math.min(preview, 255);
    prefs.push(pref);
  }
  const ms = getText(options, 'MIMESupport');
  const out: BodyOptions = { prefs, mimeSupport: ms === '2' ? 2 : ms === '1' ? 1 : 0 };
  const mt = intOrUndefined(getText(options, 'MIMETruncation'));
  if (mt !== undefined && mt < MIME_TRUNCATION.length) out.mimeTruncation = MIME_TRUNCATION[mt]!;
  return out;
}

export function isSmime(msg: Pick<EasMessage, 'smimeMeta' | 'attachments'>): boolean {
  if (msg.smimeMeta) return true;
  return msg.attachments.some((a) => /^application\/(x-)?pkcs7-(mime|signature)$/i.test(a.mimeType) || /^smime\.p7[ms]$/i.test(a.filename));
}

/** The representation to send: MIME when allowed and asked for, else HTML/plain by availability. */
export function chooseBodyPreference(opts: BodyOptions | null, msg: Pick<EasMessage, 'bodyHtml' | 'smimeMeta' | 'attachments'>): BodyPreference {
  if (!opts) return DEFAULT_BODY_PREFERENCE;
  const mimeAllowed = opts.mimeSupport === 2 || (opts.mimeSupport === 1 && isSmime(msg));
  const byType = (t: BodyType) => opts.prefs.find((p) => p.type === t);
  if (mimeAllowed) {
    const mime = byType(4);
    if (mime) return mime.truncationSize === undefined && opts.mimeTruncation !== undefined ? { ...mime, truncationSize: opts.mimeTruncation } : mime;
    // EAS 2.5 style: MIMESupport without BodyPreference
    if (opts.prefs.length === 0) return { type: 4, allOrNone: false, ...(opts.mimeTruncation !== undefined ? { truncationSize: opts.mimeTruncation } : {}) };
  }
  const html = byType(2);
  const plain = byType(1);
  if (html && msg.bodyHtml) return html;
  if (plain) return plain;
  if (html) return html;
  // Only RTF (3) or MIME without MIMESupport requested: plain text with that preference's limits.
  const first = opts.prefs[0];
  return first ? { ...first, type: 1 } : DEFAULT_BODY_PREFERENCE;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<html><body><div>${esc.replace(/\r?\n/g, '<br>')}</div></body></html>`;
}

/** Cut UTF-8 to at most `max` bytes without splitting a character. */
export function truncateUtf8(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

function previewOf(msg: Pick<EasMessage, 'bodyText' | 'bodyHtml'>, chars: number): string {
  const text = (msg.bodyText || htmlToText(msg.bodyHtml)).replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, chars).join('');
}

export function nativeBodyType(msg: Pick<EasMessage, 'bodyHtml'>): 1 | 2 {
  return msg.bodyHtml ? 2 : 1;
}

/** airsyncbase:Body for `pref` (Type, EstimatedDataSize, Truncated, Data, Preview). */
export async function buildBody(pref: BodyPreference, msg: EasMessage, loadRaw: LoadRaw): Promise<WbxmlElement> {
  let type: BodyType = pref.type === 3 ? 1 : pref.type;
  let full: Buffer;
  if (type === 4) full = await loadRaw(msg);
  else if (type === 2) full = Buffer.from(msg.bodyHtml || textToHtml(msg.bodyText), 'utf8');
  else { type = 1; full = Buffer.from(msg.bodyText || htmlToText(msg.bodyHtml), 'utf8'); }

  let data: Buffer | null = full;
  let truncated = false;
  if (pref.truncationSize !== undefined && full.length > pref.truncationSize) {
    truncated = true;
    // AllOrNone: content larger than TruncationSize is not sent at all ([MS-ASAIRS] 2.2.2.3)
    data = pref.allOrNone ? null : type === 4 ? full.subarray(0, pref.truncationSize) : truncateUtf8(full, pref.truncationSize);
  }
  // MIME stays byte-exact (Buffer); text bodies never contain NUL in practice
  const kids: WbxmlElement[] = [
    pel(CP.AirSyncBase, 'Type', String(type)),
    pel(CP.AirSyncBase, 'EstimatedDataSize', String(full.length)),
    pel(CP.AirSyncBase, 'Truncated', truncated ? '1' : '0'),
  ];
  if (data && data.length > 0) kids.push(pel(CP.AirSyncBase, 'Data', data));
  if (pref.preview) {
    const p = previewOf(msg, pref.preview);
    if (p) kids.push(pel(CP.AirSyncBase, 'Preview', p));
  }
  return pel(CP.AirSyncBase, 'Body', kids);
}

/** airsyncbase:Attachments (null without attachments). FileReference = attachment id. */
export function buildAttachments(atts: EasAttachment[]): WbxmlElement | null {
  if (atts.length === 0) return null;
  return pel(CP.AirSyncBase, 'Attachments', atts.map((a) => pel(CP.AirSyncBase, 'Attachment', [
    pel(CP.AirSyncBase, 'DisplayName', a.filename || 'attachment'),
    pel(CP.AirSyncBase, 'FileReference', a.id),
    pel(CP.AirSyncBase, 'Method', '1'),
    pel(CP.AirSyncBase, 'EstimatedDataSize', String(a.size)),
    ...(a.contentId ? [pel(CP.AirSyncBase, 'ContentId', a.contentId.replace(/^<|>$/g, ''))] : []),
    ...(a.inline ? [pel(CP.AirSyncBase, 'IsInline', '1')] : []),
  ])));
}

function formatAddress(name: string, addr: string): string {
  if (!name || name === addr) return addr;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
}

function threadTopic(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd|aw|wg|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '');
}

function messageClass(smimeMeta: string | null): string {
  if (!smimeMeta) return 'IPM.Note';
  try {
    const m = JSON.parse(smimeMeta) as { decrypted?: boolean; encrypted?: boolean; signed?: boolean };
    if (m.decrypted || m.encrypted) return 'IPM.Note.SMIME';
    if (m.signed) return 'IPM.Note.SMIME.MultipartSigned';
  } catch { /* not JSON → plain note */ }
  return 'IPM.Note';
}

/** email2:ConversationId — 16 bytes, stable per thread (threadId, else the message itself). */
export function conversationId(msg: Pick<EasMessage, 'id' | 'threadId'>): Buffer {
  return createHash('md5').update(msg.threadId ?? msg.id).digest();
}

/** email2:ConversationIndex — one 5-byte timestamp (high 40 bits of the FILETIME). */
export function conversationIndex(date: Date): Buffer {
  const ft = (BigInt(date.getTime()) + 11644473600000n) * 10000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(ft);
  return b.subarray(0, 5);
}

/**
 * Email/AirSyncBase/Email2 properties of a message in [MS-ASEMAIL] order — the
 * children of airsync:ApplicationData (Sync) or itemoperations:Properties.
 */
export async function buildEmailProperties(msg: EasMessage, pref: BodyPreference, loadRaw: LoadRaw): Promise<WbxmlElement[]> {
  const E = CP.Email;
  const out: WbxmlElement[] = [];
  if (msg.toAddrs.length) out.push(pel(E, 'To', msg.toAddrs.join(', ')));
  if (msg.ccAddrs.length) out.push(pel(E, 'Cc', msg.ccAddrs.join(', ')));
  out.push(pel(E, 'From', formatAddress(msg.fromName, msg.fromAddr)));
  out.push(pel(E, 'Subject', msg.subject));
  if (msg.replyTo) out.push(pel(E, 'ReplyTo', msg.replyTo));
  out.push(pel(E, 'DateReceived', msg.date.toISOString()));
  out.push(pel(E, 'DisplayTo', msg.toAddrs.join('; ')));
  out.push(pel(E, 'ThreadTopic', threadTopic(msg.subject)));
  out.push(pel(E, 'Importance', '1'));
  out.push(pel(E, 'Read', msg.flags.includes('\\Seen') ? '1' : '0'));
  const atts = buildAttachments(msg.attachments);
  if (atts) out.push(atts);
  out.push(await buildBody(pref, msg, loadRaw));
  out.push(pel(E, 'MessageClass', messageClass(msg.smimeMeta)));
  out.push(pel(E, 'InternetCPID', '65001'));
  out.push(pel(E, 'ContentClass', 'urn:content-classes:message'));
  out.push(pel(CP.AirSyncBase, 'NativeBodyType', String(nativeBodyType(msg))));
  out.push(pel(CP.Email2, 'ConversationId', conversationId(msg), { opaque: true }));
  out.push(pel(CP.Email2, 'ConversationIndex', conversationIndex(msg.date), { opaque: true }));
  return out;
}

/** Prisma select for EasMessage columns (attachments loaded separately). */
export const EAS_MESSAGE_SELECT = {
  id: true, flags: true, subject: true, fromAddr: true, fromName: true, toAddrs: true, ccAddrs: true,
  replyTo: true, messageId: true, inReplyTo: true, threadId: true, date: true, bodyText: true, bodyHtml: true,
  storagePath: true, smimeMeta: true,
} as const;

export const EAS_ATTACHMENT_SELECT = { id: true, messageId: true, filename: true, mimeType: true, size: true, contentId: true, inline: true } as const;
