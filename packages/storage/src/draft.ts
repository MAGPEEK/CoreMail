/**
 * Server drafts (webmail compose autosave, v8.x).
 *
 * A draft is an ordinary message in the user's Drafts folder with the `\Draft`
 * flag and a stored raw original, so IMAP/JMAP/EAS clients see it as well. This
 * module reads the compose fields back out of such a raw message (including
 * Bcc, which drafts keep in the header) — independent of the indexed columns,
 * which hold bare addresses only and truncated bodies.
 */
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { capHeaderSection } from './mime/index.js';
import { importanceOfRaw, type Importance } from './importance.js';

export const DRAFTS_FOLDER = 'Drafts';
export const DRAFT_FLAG = '\\Draft';

export interface DraftFields {
  /** Recipients as typed in compose: `Name <a@b>` or the bare address. */
  to: string[];
  cc: string[];
  bcc: string[];
  from: { address: string; name: string } | null;
  /** Address of the Sender header (send-on-behalf drafts), lower-cased. */
  sender: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  messageId: string | null;
  inReplyTo: string | null;
  /** References chain (Message-IDs with angle brackets), oldest first. */
  references: string[];
  /** 9.4: importance chosen in compose (Importance / X-Priority headers). */
  importance: Importance;
}

/** `Name <a@b>` (display name kept when present), the bare address, or the name alone. */
export function formatComposeAddress(v: { name?: string; address?: string }): string {
  const name = (v.name ?? '').replace(/[\r\n"]/g, ' ').trim();
  const address = (v.address ?? '').trim();
  // RFC 5322 specials in the name ("Doe, John") need a quoted string
  if (address && name) return /[,;<>@:()[\]\\]/.test(name) ? `"${name}" <${address}>` : `${name} <${address}>`;
  return address || name;
}

function addressList(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((o) => o.value.flatMap((v) => (v.group ?? [v]).map(formatComposeAddress))).filter(Boolean);
}

function headerString(parsed: ParsedMail, name: string): string | null {
  const v = parsed.headers.get(name);
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in v && Array.isArray((v as AddressObject).value)) {
    return (v as AddressObject).value[0]?.address ?? null;
  }
  return String(v);
}

function msgIdList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const all = (Array.isArray(v) ? v : [v]).join(' ');
  return all.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Recipients the user typed that are not (yet) valid addresses ("bob", "a@") cannot
 * be written into To/Cc/Bcc; drafts keep them in this header (base64 JSON) so
 * nothing typed is lost. Sending such a draft fails the recipient check.
 */
export const DRAFT_PENDING_HEADER = 'X-CoreMail-Draft-Pending';
export const MAX_DRAFT_PENDING_BYTES = 16 * 1024;

export interface PendingRecipients { to: string[]; cc: string[]; bcc: string[] }

/** Header value for pending recipients, or null when there are none / too many bytes. */
export function encodeDraftPending(p: PendingRecipients): string | null {
  if (!p.to.length && !p.cc.length && !p.bcc.length) return null;
  const json = JSON.stringify(p);
  if (Buffer.byteLength(json) > MAX_DRAFT_PENDING_BYTES) return null;
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeDraftPending(value: string | null): PendingRecipients {
  const empty = { to: [], cc: [], bcc: [] };
  if (!value) return empty;
  try {
    const v = JSON.parse(Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8')) as Record<string, unknown>;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').map((s) => s.replace(/[\r\n]/g, ' ')) : []);
    return { to: list(v['to']), cc: list(v['cc']), bcc: list(v['bcc']) };
  } catch {
    return empty;
  }
}

/** Compose fields of a draft's raw RFC 5322 message. */
export async function parseDraftFields(raw: Buffer): Promise<DraftFields> {
  const parsed = await simpleParser(capHeaderSection(raw));
  const from = parsed.from?.value[0];
  const sender = headerString(parsed, 'sender');
  const pending = decodeDraftPending(headerString(parsed, DRAFT_PENDING_HEADER.toLowerCase()));
  return {
    to: [...addressList(parsed.to), ...pending.to],
    cc: [...addressList(parsed.cc), ...pending.cc],
    bcc: [...addressList(parsed.bcc), ...pending.bcc],
    from: from ? { address: (from.address ?? '').toLowerCase(), name: from.name ?? '' } : null,
    sender: sender ? sender.toLowerCase() : null,
    subject: parsed.subject ?? '',
    bodyHtml: parsed.html !== false ? (parsed.html ?? '') : '',
    bodyText: parsed.text ?? '',
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: msgIdList(parsed.references),
    importance: importanceOfRaw(raw),
  };
}

/**
 * Sender mode of a draft, derived from its From/Sender headers relative to the
 * owner's address: own address → normal; Sender = owner → send on behalf of
 * From; otherwise send as From. The send path re-checks the permission.
 */
export function draftSenderMode(
  fields: Pick<DraftFields, 'from' | 'sender'>,
  ownerEmail: string,
): { sendAs: string | null; sendOnBehalfOf: string | null } {
  const own = ownerEmail.toLowerCase();
  const from = fields.from?.address ?? '';
  if (!from || from === own) return { sendAs: null, sendOnBehalfOf: null };
  if (fields.sender && fields.sender === own) return { sendAs: null, sendOnBehalfOf: from };
  return { sendAs: from, sendOnBehalfOf: null };
}
