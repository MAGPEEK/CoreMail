import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import { createHash } from 'crypto';

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

export async function parseRawMessage(rawBuffer: Buffer): Promise<ParsedMessage> {
  const parsed: ParsedMail = await simpleParser(rawBuffer);

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
