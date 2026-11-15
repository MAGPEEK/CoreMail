/**
 * Pure planning step for EAS SendMail / SmartReply / SmartForward:
 * parse the client MIME, enforce the sender identity, derive the envelope
 * and prepare the raw message for the outbound queue. No I/O.
 */
import { randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';

/** EAS status codes (MS-ASCMD §2.2.2 common status codes) used by SendMail. */
export const EAS_SEND_STATUS = {
  SUCCESS:           '1',
  INVALID_MIME:      '107',
  SERVER_ERROR:      '110',
  MESSAGE_PREVIOUSLY_SENT: '118',
  NO_RECIPIENTS:     '119',
  SUBMISSION_FAILED: '120',
  ACCESS_DENIED:     '130',
  ITEM_NOT_FOUND:    '150',
} as const;

export interface EasSubmissionPlan {
  envelopeFrom: string;
  recipients:   string[];   // To + Cc + Bcc, lower-cased, de-duplicated
  raw:          Buffer;     // Bcc stripped, From/Date/Message-ID ensured
  subject:      string;
  to:           string[];
  cc:           string[];
  bcc:          string[];
  text:         string;
  html:         string;
}

export type EasPlanResult =
  | { ok: true; plan: EasSubmissionPlan }
  | { ok: false; status: string; reason: string };

// ── Raw header helpers ────────────────────────────────────────────────────────

/** Index where the header block ends (start of the blank line), or -1. */
function headerBlockEnd(raw: Buffer): { end: number; sepLen: number } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf   = raw.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { end: crlf, sepLen: 4 };
  if (lf >= 0) return { end: lf, sepLen: 2 };
  return { end: -1, sepLen: 0 };
}

/** True if the header block contains a header field `name`. */
export function hasHeader(raw: Buffer, name: string): boolean {
  const { end } = headerBlockEnd(raw);
  const block = raw.subarray(0, end >= 0 ? end : raw.length).toString('latin1');
  return new RegExp(`^${name}[ \\t]*:`, 'im').test(block);
}

/** Remove every occurrence of header `name` (incl. folded continuation lines). */
export function stripHeader(raw: Buffer, name: string): Buffer {
  const { end, sepLen } = headerBlockEnd(raw);
  if (end < 0) return raw;
  // `block` holds the header lines; its last line has no terminator because
  // raw[end..] starts with the blank-line separator (CRLFCRLF / LFLF).
  const block = raw.subarray(0, end).toString('latin1');
  const lines = block.split(/(?<=\n)/); // keep line terminators
  const kept: string[] = [];
  let skipping = false;
  const re = new RegExp(`^${name}[ \\t]*:`, 'i');
  for (const line of lines) {
    if (skipping && /^[ \t]/.test(line)) continue; // folded continuation
    skipping = re.test(line);
    if (!skipping) kept.push(line);
  }
  const head = kept.join('').replace(/\r?\n$/, '');
  if (head === '') {
    // Every header removed: keep a single blank line before the body.
    return Buffer.from(raw.subarray(end + sepLen / 2));
  }
  return Buffer.concat([Buffer.from(head, 'latin1'), raw.subarray(end)]);
}

/** Prepend header lines (CRLF-terminated). */
export function prependHeaders(raw: Buffer, lines: string[]): Buffer {
  if (lines.length === 0) return raw;
  return Buffer.concat([Buffer.from(lines.map((l) => `${l}\r\n`).join(''), 'utf8'), raw]);
}

/** Header fields (each with its folded continuation lines) and the body octets. */
function splitMessage(raw: Buffer): { headers: string[]; body: Buffer } {
  const { end, sepLen } = headerBlockEnd(raw);
  const block = raw.subarray(0, end >= 0 ? end : raw.length).toString('latin1');
  const headers: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && headers.length > 0) headers[headers.length - 1] += `\r\n${line}`;
    else headers.push(line);
  }
  return { headers, body: end >= 0 ? raw.subarray(end + sepLen) : Buffer.alloc(0) };
}

/**
 * SmartReply / SmartForward ([MS-ASCMD]: the server adds the original message unless
 * ReplaceMime is set): the client's message becomes the first part of a multipart/mixed,
 * the original octets follow unchanged as an embedded `message/rfc822` part — inline for a
 * reply, as an attachment for a forward — so its body and attachments travel with it.
 * The client's header fields stay on the outer message (content fields move to part 1).
 */
export function appendOriginalMessage(clientMime: Buffer, original: Buffer, kind: 'reply' | 'forward', subject: string): Buffer {
  const { headers, body } = splitMessage(clientMime);
  const isContentField = (h: string) => /^content-[a-z0-9-]*[ \t]*:/i.test(h);
  const outer = headers.filter((h) => !isContentField(h) && !/^mime-version[ \t]*:/i.test(h));
  const content = headers.filter(isContentField);
  const boundary = `=_eas_${randomUUID()}`;
  const fileName = encodeURIComponent(`${(subject || 'message').replace(/[\r\n]/g, ' ').slice(0, 100)}.eml`)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const eightBit = original.some((b) => b >= 0x80);
  return Buffer.concat([
    Buffer.from([...outer, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n') + '\r\n\r\n', 'latin1'),
    Buffer.from(`--${boundary}\r\n${(content.length > 0 ? content : ['Content-Type: text/plain; charset=utf-8']).join('\r\n')}\r\n\r\n`, 'latin1'),
    body,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n`
      + `Content-Disposition: ${kind === 'forward' ? 'attachment' : 'inline'}; filename*=UTF-8''${fileName}\r\n`
      + (eightBit ? 'Content-Transfer-Encoding: 8bit\r\n' : '') + '\r\n', 'latin1'),
    original,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
}

// ── Address helpers ───────────────────────────────────────────────────────────

function flattenAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  const walk = (list: EmailAddress[]): void => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push(a.address.trim().toLowerCase());
    }
  };
  for (const o of objs) walk(o.value);
  return out;
}

const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

// ── Planner ───────────────────────────────────────────────────────────────────

export interface PlanOptions {
  /** The authenticated user's primary address (default From when missing). */
  userEmail: string;
  /** Addresses the user may send as (own, aliases, Shared Mailbox SEND_AS/FULL_ACCESS). */
  allowedSenders: string[];
  now?: Date;
}

export async function planEasSubmission(mime: Buffer, opts: PlanOptions): Promise<EasPlanResult> {
  if (mime.length === 0) {
    return { ok: false, status: EAS_SEND_STATUS.INVALID_MIME, reason: 'Empty MIME' };
  }

  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  try {
    parsed = await simpleParser(mime, { skipImageLinks: true, skipTextToHtml: true });
  } catch (err) {
    return { ok: false, status: EAS_SEND_STATUS.INVALID_MIME, reason: `MIME parse error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const allowed = new Set(opts.allowedSenders.map((a) => a.trim().toLowerCase()));
  const userEmail = opts.userEmail.trim().toLowerCase();

  // ── Sender identity: never trust the client From blindly ────────────────
  const fromAddrs = flattenAddresses(parsed.from);
  let envelopeFrom: string;
  const extraHeaders: string[] = [];
  if (fromAddrs.length === 0) {
    if (hasHeader(mime, 'From')) {
      return { ok: false, status: EAS_SEND_STATUS.INVALID_MIME, reason: 'Unparsable From header' };
    }
    envelopeFrom = userEmail;
    extraHeaders.push(`From: <${userEmail}>`);
  } else if (fromAddrs.length > 1) {
    return { ok: false, status: EAS_SEND_STATUS.ACCESS_DENIED, reason: 'Multiple From addresses are not allowed' };
  } else {
    const from = fromAddrs[0]!;
    if (!allowed.has(from)) {
      return { ok: false, status: EAS_SEND_STATUS.ACCESS_DENIED, reason: `Sender address ${from} not allowed for ${userEmail}` };
    }
    envelopeFrom = from;
  }

  // ── Recipients ─────────────────────────────────────────────────────────
  const to  = flattenAddresses(parsed.to);
  const cc  = flattenAddresses(parsed.cc);
  const bcc = flattenAddresses(parsed.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc])];
  if (recipients.length === 0) {
    return { ok: false, status: EAS_SEND_STATUS.NO_RECIPIENTS, reason: 'No recipients' };
  }
  const bad = recipients.filter((r) => !EMAIL_RE.test(r));
  if (bad.length) {
    return { ok: false, status: EAS_SEND_STATUS.INVALID_MIME, reason: `Invalid recipient(s): ${bad.join(', ')}` };
  }

  // ── RFC 5322 hygiene: required headers, never transmit Bcc ──────────────
  const now = opts.now ?? new Date();
  if (!hasHeader(mime, 'Date')) extraHeaders.push(`Date: ${now.toUTCString().replace('GMT', '+0000')}`);
  if (!hasHeader(mime, 'Message-ID')) {
    extraHeaders.push(`Message-ID: <${randomUUID()}@${envelopeFrom.split('@')[1] ?? 'localhost'}>`);
  }
  const raw = prependHeaders(stripHeader(mime, 'Bcc'), extraHeaders);

  return {
    ok: true,
    plan: {
      envelopeFrom,
      recipients,
      raw,
      subject: parsed.subject ?? '',
      to, cc, bcc,
      text: parsed.text ?? '',
      html: typeof parsed.html === 'string' ? parsed.html : '',
    },
  };
}
