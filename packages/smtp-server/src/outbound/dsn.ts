/**
 * DSN (Delivery Status Notification, RFC 3464) — bounce generator.
 *
 * When mail that was accepted with 250 cannot be delivered (permanent reply,
 * retries exhausted), the server MUST notify the envelope sender (RFC 5321
 * §6.1). The bounce is a multipart/report with a message/delivery-status part,
 * sent with a null reverse-path so it can never bounce again.
 */

import { storeInboundMessage } from '../handlers/message.js';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { formatRfc5322Date } from '../handlers/trace.js';

const log = createLogger('smtp:dsn');

/**
 * Extracts the SMTP reply code of a delivery error. Only nodemailer's
 * `responseCode` or a reply code at the very start of the message counts —
 * a port number in a network error ("connect ETIMEDOUT 10.0.0.5:587") is not
 * a reply code. Without a reply code the failure is transient.
 */
export function extractSmtpCode(err: unknown): { code: number | null; isPermanent: boolean } {
  const rc = (err as { responseCode?: unknown } | null)?.responseCode;
  let code: number | null = typeof rc === 'number' && rc >= 200 && rc < 600 ? rc : null;
  if (code === null) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /^\s*([245]\d\d)(?:[ -]|$)/.exec(msg);
    code = m ? parseInt(m[1]!, 10) : null;
  }
  return { code, isPermanent: code !== null && code >= 500 };
}

/** One failed recipient of a DSN. */
export interface DsnRecipient {
  rcpt:       string;
  /** RFC 3463 enhanced status code, e.g. "5.1.1". */
  status:     string;
  /** Remote reply / local reason (one line). */
  diagnostic: string;
  /** Reply came from a remote SMTP server ("smtp" diagnostic type). */
  remote?:    boolean;
}

export interface DsnOptions {
  originalFrom:      string;
  originalTo:        string[];
  originalSubject:   string;
  originalMessageId: string | null;
  failureReason:     string;
  smtpCode:          number | null;
  serverHostname:    string;
  /**
   * Per-recipient results. When omitted every `originalTo` entry is reported
   * with `failureReason` / `smtpCode`.
   */
  recipients?:       DsnRecipient[];
  /**
   * Also deliver the DSN to an EXTERNAL sender (via the outbound queue with a
   * null envelope sender). Required for every failure after the server
   * answered 250 (RFC 5321 §6.1).
   */
  deliverExternal?:  boolean;
  /**
   * RFC 3464 §2.3.3 Action: `failed` (default, final bounce) or `delayed`
   * (delay notification — delivery is still being retried).
   */
  action?:           'failed' | 'delayed';
  /** RFC 3464 §2.3.9 Will-Retry-Until (delay notifications). */
  willRetryUntil?:   Date;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderWord(text: string): string {
  const clean = oneLine(text);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function statusFromCode(code: number | null): string {
  if (code === null) return '5.0.0';
  const klass = Math.floor(code / 100);
  return klass === 4 || klass === 5 ? `${klass}.0.0` : '5.0.0';
}

/** Pure: builds the RFC 3464 report (CRLF line endings). */
export function buildDsnMessage(opts: DsnOptions, now = new Date(), random = Math.random): Buffer {
  const date = formatRfc5322Date(now);
  const nonce = `${now.getTime()}-${random().toString(36).slice(2, 10)}`;
  const dsnMessageId = `<dsn-${nonce}@${opts.serverHostname}>`;
  const boundary = `dsn-boundary-${nonce}`;
  const recipients: DsnRecipient[] = opts.recipients ?? opts.originalTo.map((rcpt) => ({
    rcpt,
    status: statusFromCode(opts.smtpCode),
    diagnostic: opts.smtpCode ? `${opts.smtpCode} ${oneLine(opts.failureReason)}` : oneLine(opts.failureReason),
    remote: opts.smtpCode !== null,
  }));

  const delayed = opts.action === 'delayed';
  const human = [
    ...(delayed
      ? [
        'This is the mail delivery system. Your message has not been delivered yet',
        'to one or more recipients. Delivery is still being retried — you do not',
        'need to resend it:',
      ]
      : [
        'This is the mail delivery system. Your message could not be delivered',
        'to one or more recipients:',
      ]),
    '',
    ...recipients.map((r) => `  <${oneLine(r.rcpt)}>: ${oneLine(r.diagnostic)}`),
    '',
    ...(delayed && opts.willRetryUntil ? [`Delivery attempts stop at: ${formatRfc5322Date(opts.willRetryUntil)}`, ''] : []),
    `Reporting server: ${opts.serverHostname}`,
    '',
  ].join('\r\n');

  // RFC 3464 §2.2: per-message fields, a blank line, then one block per
  // recipient (§2.3). Only the failed recipients are listed.
  const report = [
    `Reporting-MTA: dns; ${opts.serverHostname}`,
    `Arrival-Date: ${date}`,
    '',
    recipients.map((r) => [
      `Final-Recipient: rfc822; ${oneLine(r.rcpt)}`,
      `Action: ${delayed ? 'delayed' : 'failed'}`,
      `Status: ${r.status}`,
      `Diagnostic-Code: ${r.remote ? 'smtp' : 'x-local'}; ${oneLine(r.diagnostic)}`,
      ...(delayed && opts.willRetryUntil ? [`Will-Retry-Until: ${formatRfc5322Date(opts.willRetryUntil)}`] : []),
    ].join('\r\n')).join('\r\n\r\n'),
    '',
  ].join('\r\n');

  const subject = encodeHeaderWord(`${delayed ? 'Delayed Mail (still being retried)' : 'Undelivered Mail Returned to Sender'}: ${opts.originalSubject || '(no subject)'}`);
  const refs = opts.originalMessageId
    ? [`In-Reply-To: ${oneLine(opts.originalMessageId)}`, `References: ${oneLine(opts.originalMessageId)}`]
    : [];

  const raw = [
    `From: Mail Delivery System <MAILER-DAEMON@${opts.serverHostname}>`,
    `To: <${oneLine(opts.originalFrom)}>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${dsnMessageId}`,
    ...refs,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    'Auto-Submitted: auto-replied',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    human,
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    report,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(raw, 'utf8');
}

/**
 * Sends a bounce to MAIL FROM: local senders get it stored directly, external
 * senders only with `deliverExternal` (via the outbound queue, null sender).
 *
 * If MAIL FROM is empty (= already a bounce mail!) no new bounce is generated
 * (RFC 5321 §6.1, "double-bounce prevention").
 */
export async function sendDsnBounce(opts: DsnOptions): Promise<void> {
  // RFC 5321 §6.1: no bounce for empty MAIL FROM (= "<>" bounce mail itself)
  if (!opts.originalFrom || opts.originalFrom === '<>') {
    log.info({ originalTo: opts.originalTo }, 'DSN suppressed: empty MAIL FROM (double-bounce protection)');
    return;
  }

  const domain = opts.originalFrom.slice(opts.originalFrom.lastIndexOf('@') + 1).toLowerCase();
  if (!opts.originalFrom.includes('@') || !domain) return;
  const localDomain = await prisma.domain.findFirst({
    where: { name: domain, active: true },
    select: { id: true },
  });
  if (!localDomain && !opts.deliverExternal) {
    log.info({ to: opts.originalFrom }, 'DSN suppressed: external sender of a message that was never accepted here');
    return;
  }

  const raw = buildDsnMessage(opts);

  if (!localDomain) {
    try {
      // Lazy import: queue.ts imports this module (failed-job DSN).
      const { enqueueOutbound } = await import('./queue.js');
      await enqueueOutbound({
        messageId:  `dsn-${Date.now()}`,
        from:       '',                       // null sender (RFC 5321 §4.5.5)
        to:         [opts.originalFrom],
        rawMessage: raw.toString('base64'),
      });
      log.info({ to: opts.originalFrom, code: opts.smtpCode }, 'DSN bounce enqueued to external sender');
    } catch (err) {
      log.error({ err, to: opts.originalFrom }, 'DSN bounce enqueue failed');
    }
    return;
  }

  try {
    await storeInboundMessage(raw, {
      fromAddr: '',     // null sender for bounce (RFC 5321)
      rcptTo:   opts.originalFrom,
      toJunk:   false,
    });
    log.info(
      { to: opts.originalFrom, code: opts.smtpCode, originalMessageId: opts.originalMessageId },
      'DSN bounce delivered',
    );
  } catch (err) {
    log.error({ err, to: opts.originalFrom }, 'DSN bounce delivery failed');
  }
}
