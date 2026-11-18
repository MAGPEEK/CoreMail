/**
 * 9.4: read receipts (message disposition notifications). Pure module:
 *  - the Disposition-Notification-To address of a raw message (stored at delivery,
 *    re-read before a receipt is sent),
 *  - the receipt itself: a multipart/report (report-type=disposition-notification)
 *    with a short human-readable part and the machine-readable
 *    message/disposition-notification part.
 * The "displayed" disposition is the only one CoreMail reports.
 */
import { randomBytes } from 'node:crypto';
import { findBodyStart, headerValue, parseHeaderFields } from './mime/tree.js';
import { parseAddressList } from './mime/address.js';
import { encodeUnstructured, formatMailbox, formatRfc5322Date, sanitizeAddrSpec, sanitizeHeaderValue } from './mime/build.js';

/** Header section bytes looked at — receipts are requested in the top-level header. */
const MAX_HEADER_SCAN = 256 * 1024;
const ADDR_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** First valid mailbox address of a Disposition-Notification-To value, or null. */
export function receiptAddressOf(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const entry of parseAddressList(value)) {
    const mailbox = entry.kind === 'mailbox' ? entry : entry.members[0];
    const addr = mailbox?.address.trim().toLowerCase() ?? '';
    if (ADDR_RE.test(addr) && addr.length <= 320) return addr;
  }
  return null;
}

/** Disposition-Notification-To address of raw RFC 5322 octets (top-level header only), or null. */
export function receiptAddressOfRaw(raw: Buffer): string | null {
  const s = raw.subarray(0, Math.min(raw.length, MAX_HEADER_SCAN)).toString('latin1');
  const bodyStart = findBodyStart(s, 0, s.length);
  return receiptAddressOf(headerValue(parseHeaderFields(s, 0, bodyStart), 'disposition-notification-to'));
}

/** How the user sent the receipt: answered a prompt, or the policy "always" did. */
export type ReceiptMode = 'manual' | 'automatic';

export interface ReceiptInput {
  /** Reporting user (the reader). */
  fromAddr: string;
  fromName: string;
  /** Disposition-Notification-To address of the original. */
  to: string;
  /** Message-ID of the original (with or without angle brackets), if any. */
  originalMessageId: string | null;
  originalSubject: string;
  /** Final recipient: the mailbox that received the original. */
  finalRecipient: string;
  /** Host name for the Reporting-UA field and the receipt's own Message-ID. */
  reportingHost: string;
  mode: ReceiptMode;
  date?: Date;
}

export interface BuiltReceipt {
  raw: Buffer;
  messageId: string;
}

function msgIdOf(id: string | null): string | null {
  if (!id) return null;
  const clean = sanitizeHeaderValue(id).replace(/[<>\s]/g, '');
  return clean ? `<${clean}>` : null;
}

/** Host name usable in a header (letters, digits, dots, hyphens), else "localhost". */
function safeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : 'localhost';
}

/** Builds the read receipt for an original message. */
export function buildReadReceipt(input: ReceiptInput): BuiltReceipt {
  const host = safeHost(input.reportingHost);
  const date = input.date ?? new Date();
  const boundary = `=_cm_mdn_${randomBytes(12).toString('hex')}`;
  const messageId = `<mdn.${randomBytes(12).toString('hex')}@${host}>`;
  const original = msgIdOf(input.originalMessageId);
  const subject = sanitizeHeaderValue(input.originalSubject);
  const disposition = input.mode === 'manual'
    ? 'manual-action/MDN-sent-manually; displayed'
    : 'automatic-action/MDN-sent-automatically; displayed';
  const recipient = sanitizeAddrSpec(input.finalRecipient);

  const human = [
    `Ihre Nachricht${subject ? ` "${subject}"` : ''} an ${recipient} wurde am ${formatRfc5322Date(date)} angezeigt.`,
    '',
    `Your message${subject ? ` "${subject}"` : ''} to ${recipient} was displayed on ${formatRfc5322Date(date)}.`,
    '',
    'Dies bestätigt nur, dass die Nachricht angezeigt wurde, nicht dass sie gelesen oder verstanden wurde.',
  ].join('\r\n');

  const report = [
    `Reporting-UA: ${host}; CoreMail`,
    `Final-Recipient: rfc822;${recipient}`,
    ...(original ? [`Original-Message-ID: ${original}`] : []),
    `Disposition: ${disposition}`,
  ].join('\r\n');

  const lines = [
    `From: ${formatMailbox(input.fromName, input.fromAddr)}`,
    `To: ${sanitizeAddrSpec(input.to)}`,
    `Subject: ${encodeUnstructured(`Gelesen: ${subject}`)}`,
    `Date: ${formatRfc5322Date(date)}`,
    `Message-ID: ${messageId}`,
    ...(original ? [`In-Reply-To: ${original}`, `References: ${original}`] : []),
    ...(input.mode === 'automatic' ? ['Auto-Submitted: auto-replied'] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    human,
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    report,
    '',
    `--${boundary}--`,
    '',
  ];
  return { raw: Buffer.from(lines.join('\r\n'), 'utf8'), messageId };
}
