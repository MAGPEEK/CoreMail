import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import { createHash } from 'crypto';
import { extractReferences } from '../references.js';
import { receiptAddressOfRaw } from '../mdn.js';

export interface ParsedMessage {
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  /** References header: normalized msg-ids in header order, capped (references.ts). */
  references: string[];
  /** 9.4: Disposition-Notification-To address (read receipt requested), or null. */
  dispositionNotificationTo: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string;
  attachments: ParsedAttachment[];
  size: number;
}

export interface ParsedAttachment {
  contentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  buffer: Buffer;
  inline: boolean;
}

/**
 * Upper bound for the top-level header section handed to the MIME parser
 * (Postfix `header_size_limit` semantics, 2.5× its default). Address headers are
 * attacker-controlled; the cap bounds the parser's work independently of the
 * address parser in use. The stored raw message is never changed.
 */
export const MAX_PARSE_HEADER_BYTES = 256 * 1024;

const isFoldWs = (b: number | undefined): boolean => b === 0x20 || b === 0x09;

/**
 * Pure: returns `raw` unchanged when its header section fits `maxBytes`;
 * otherwise a copy that keeps the complete header fields within the first
 * `maxBytes` bytes, drops the rest of the header section and keeps the body.
 */
export function capHeaderSection(raw: Buffer, maxBytes = MAX_PARSE_HEADER_BYTES): Buffer {
  if (raw.length <= maxBytes) return raw;
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  // Offset of the line break that ends the last header line, and where the
  // blank line + body start after it.
  let headerEnd = -1;
  let rest = -1;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) { headerEnd = crlf; rest = crlf + 2; }
  else if (lf >= 0) { headerEnd = lf; rest = lf + 1; }
  if (headerEnd >= 0 && headerEnd <= maxBytes) return raw;

  // Last complete header field that ends within the limit: a line break whose
  // next line does not start with folding whitespace.
  let cut = 0;
  for (let p = maxBytes - 1; p >= 0;) {
    const nl = raw.lastIndexOf(0x0a, p);
    if (nl < 0) break;
    if (!isFoldWs(raw[nl + 1])) { cut = nl + 1; break; }
    p = nl - 1;
  }
  const kept = raw.subarray(0, cut);
  if (rest < 0) return Buffer.concat([kept, Buffer.from('\r\n')]);
  return Buffer.concat([kept, raw.subarray(rest)]);
}

export async function parseRawMessage(rawBuffer: Buffer): Promise<ParsedMessage> {
  const capped = capHeaderSection(rawBuffer);
  const parsed: ParsedMail = await simpleParser(capped);

  const toAddrs = addressesToArray(parsed.to);
  const ccAddrs = addressesToArray(parsed.cc);
  const bccAddrs = addressesToArray(parsed.bcc);
  const fromAddr = parsed.from?.value[0]?.address ?? '';
  const fromName = parsed.from?.value[0]?.name ?? '';
  const replyTo = parsed.replyTo?.value[0]?.address ?? null;

  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map(
    (att: Attachment) => {
      const buffer = att.content;
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      return {
        contentId: att.contentId ?? null,
        filename: att.filename ?? 'attachment',
        mimeType: att.contentType ?? 'application/octet-stream',
        size: buffer.length,
        sha256,
        buffer,
        inline: att.contentDisposition === 'inline',
      };
    },
  );

  return {
    subject: parsed.subject ?? '',
    fromAddr,
    fromName,
    toAddrs,
    ccAddrs,
    bccAddrs,
    replyTo,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: extractReferences(capped),
    dispositionNotificationTo: receiptAddressOfRaw(capped),
    date: parsed.date ?? new Date(),
    bodyText: parsed.text ?? '',
    bodyHtml: parsed.html !== false ? (parsed.html ?? '') : '',
    attachments,
    size: rawBuffer.length,
  };
}

function addressesToArray(
  field: ParsedMail['to'] | ParsedMail['cc'] | ParsedMail['bcc'],
): string[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((addrObj) => addrObj.value.map((v) => v.address ?? '').filter(Boolean));
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
