/**
 * DSN (Delivery Status Notification, RFC 3464) — bounce / delay / success
 * report generator.
 *
 * When mail that was accepted with 250 cannot be delivered (permanent reply,
 * retries exhausted), the server MUST notify the envelope sender (RFC 5321
 * §6.1). The report is a multipart/report with a message/delivery-status part,
 * sent with a null reverse-path so it can never bounce again.
 *
 * v8.1: the DSN request of the transaction (RFC 3461) is honoured —
 * NOTIFY=NEVER suppresses every report, DELAY/SUCCESS only when requested (no
 * NOTIFY = FAILURE,DELAY), RET=HDRS/FULL selects the returned content, ENVID
 * and ORCPT are echoed (Original-Envelope-Id, Original-Recipient). UTF-8
 * addresses use message/global-delivery-status (RFC 6533).
 */

import { storeInboundMessage } from '../handlers/message.js';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { formatRfc5322Date } from '../handlers/trace.js';
import { rcptDsn, wantsNotification, type DsnKind, type EnvelopeDsn } from '../core/dsn-params.js';
import { domainVariants } from '../core/idn.js';

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

/** One recipient of a DSN. */
export interface DsnRecipient {
  rcpt:       string;
  /** RFC 3463 enhanced status code, e.g. "5.1.1". */
  status:     string;
  /** Remote reply / local reason (one line). */
  diagnostic: string;
  /** Reply came from a remote SMTP server ("smtp" diagnostic type). */
  remote?:    boolean;
}

/** RFC 3464 §2.3.3 Action values produced by CoreMail. */
export type DsnAction = 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded';

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
   * RFC 3464 §2.3.3 Action: `failed` (default, final bounce), `delayed`
   * (delay notification — delivery is still being retried), `delivered` /
   * `relayed` / `expanded` (success notifications, only on NOTIFY=SUCCESS).
   */
  action?:           DsnAction;
  /** RFC 3464 §2.3.9 Will-Retry-Until (delay notifications). */
  willRetryUntil?:   Date;
  /** The DSN request of the transaction (RFC 3461): NOTIFY, RET, ENVID, ORCPT. */
  dsn?:              EnvelopeDsn;
  /** The original message — returned as headers (default) or in full (RET=FULL, failures). */
  originalRaw?:      Buffer;
}

/** RET=FULL returns at most this much of the original; larger messages return their headers. */
export const DSN_FULL_RETURN_MAX_BYTES = 10 * 1024 * 1024;

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

const NON_ASCII_RE = /[^\x00-\x7f]/;

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

/** The RFC 3461 notification kind of a DSN action. */
export function dsnKind(action: DsnAction | undefined): DsnKind {
  if (action === 'delayed') return 'delay';
  if (action === 'delivered' || action === 'relayed' || action === 'expanded') return 'success';
  return 'failure';
}

function defaultRecipients(opts: DsnOptions): DsnRecipient[] {
  return opts.recipients ?? opts.originalTo.map((rcpt) => ({
    rcpt,
    status: statusFromCode(opts.smtpCode),
    diagnostic: opts.smtpCode ? `${opts.smtpCode} ${oneLine(opts.failureReason)}` : oneLine(opts.failureReason),
    remote: opts.smtpCode !== null,
  }));
}

/**
 * Pure: applies the NOTIFY request of every recipient (RFC 3461 §4.1).
 * Returns the options restricted to the recipients that want this kind of
 * report, or null when nobody does (NOTIFY=NEVER, no DELAY/SUCCESS request).
 */
export function applyDsnRequest(opts: DsnOptions): DsnOptions | null {
  const kind = dsnKind(opts.action);
  const recipients = defaultRecipients(opts).filter((r) => wantsNotification(rcptDsn(opts.dsn, r.rcpt), kind));
  if (recipients.length === 0) return null;
  return { ...opts, recipients, originalTo: recipients.map((r) => r.rcpt) };
}

/** Header block of a message (up to and including the empty line). */
export function messageHeaders(raw: Buffer): Buffer {
  const end = raw.indexOf('\r\n\r\n');
  if (end >= 0) return raw.subarray(0, end + 2);
  const lfEnd = raw.indexOf('\n\n');
  return lfEnd >= 0 ? raw.subarray(0, lfEnd + 1) : raw;
}

/** RFC 3461 §4.3: what to return — full message only for failures with RET=FULL. */
function returnedContent(opts: DsnOptions): { type: string; body: Buffer } | null {
  const raw = opts.originalRaw;
  if (!raw || raw.length === 0) return null;
  const full = opts.dsn?.ret === 'FULL' && dsnKind(opts.action) === 'failure' && raw.length <= DSN_FULL_RETURN_MAX_BYTES;
  const headers = messageHeaders(raw);
  // RFC 6532/6533: UTF-8 header fields → message/global(-headers).
  const utf8Headers = /[\x80-\xff]/.test(headers.toString('latin1'));
  if (full) return { type: utf8Headers ? 'message/global' : 'message/rfc822', body: raw };
  return { type: utf8Headers ? 'message/global-headers' : 'text/rfc822-headers', body: headers };
}

/** "rfc822; addr" or, for a UTF-8 address, "utf-8; addr" (RFC 6533 §3). */
function addressField(addr: string): string {
  const clean = oneLine(addr);
  return `${NON_ASCII_RE.test(clean) ? 'utf-8' : 'rfc822'}; ${clean}`;
}

const SUBJECTS: Record<DsnAction, string> = {
  failed:    'Undelivered Mail Returned to Sender',
  delayed:   'Delayed Mail (still being retried)',
  delivered: 'Successful Mail Delivery Report',
  relayed:   'Relayed Mail Delivery Report',
  expanded:  'Expanded Mail Delivery Report',
};

function humanText(action: DsnAction): string[] {
  switch (action) {
    case 'delayed':
      return [
        'This is the mail delivery system. Your message has not been delivered yet',
        'to one or more recipients. Delivery is still being retried — you do not',
        'need to resend it:',
      ];
    case 'delivered':
      return ['This is the mail delivery system. Your message was delivered to the', 'mailbox of the following recipients:'];
    case 'relayed':
    case 'expanded':
      return [
        'This is the mail delivery system. Your message was passed on to the following',
        'recipients. The next mail server does not support delivery notifications,',
        'so no further reports will be sent:',
      ];
    default:
      return ['This is the mail delivery system. Your message could not be delivered', 'to one or more recipients:'];
  }
}

/** Pure: builds the RFC 3464 report (CRLF line endings). */
export function buildDsnMessage(opts: DsnOptions, now = new Date(), random = Math.random): Buffer {
  const date = formatRfc5322Date(now);
  const nonce = `${now.getTime()}-${random().toString(36).slice(2, 10)}`;
  const dsnMessageId = `<dsn-${nonce}@${opts.serverHostname}>`;
  const boundary = `dsn-boundary-${nonce}`;
  const recipients = defaultRecipients(opts);
  const action: DsnAction = opts.action ?? 'failed';
  const delayed = action === 'delayed';
  const success = dsnKind(action) === 'success';

  const human = [
    ...humanText(action),
    '',
    ...recipients.map((r) => (success ? `  <${oneLine(r.rcpt)}>` : `  <${oneLine(r.rcpt)}>: ${oneLine(r.diagnostic)}`)),
    '',
    ...(delayed && opts.willRetryUntil ? [`Delivery attempts stop at: ${formatRfc5322Date(opts.willRetryUntil)}`, ''] : []),
    `Reporting server: ${opts.serverHostname}`,
    '',
  ].join('\r\n');

  // RFC 3464 §2.2: per-message fields, a blank line, then one block per
  // recipient (§2.3). Only the reported recipients are listed.
  const envid = opts.dsn?.envid;
  const report = [
    ...(envid !== undefined ? [`Original-Envelope-Id: ${oneLine(envid)}`] : []),
    `Reporting-MTA: dns; ${opts.serverHostname}`,
    `Arrival-Date: ${date}`,
    '',
    recipients.map((r) => {
      const orcpt = rcptDsn(opts.dsn, r.rcpt)?.orcpt;
      const status = success && !r.status.startsWith('2.') ? '2.0.0' : r.status;
      return [
        ...(orcpt ? [`Original-Recipient: ${orcpt.type}; ${oneLine(orcpt.address)}`] : []),
        `Final-Recipient: ${addressField(r.rcpt)}`,
        `Action: ${action}`,
        `Status: ${status}`,
        ...(!success && r.diagnostic ? [`Diagnostic-Code: ${r.remote ? 'smtp' : 'x-local'}; ${oneLine(r.diagnostic)}`] : []),
        ...(delayed && opts.willRetryUntil ? [`Will-Retry-Until: ${formatRfc5322Date(opts.willRetryUntil)}`] : []),
      ].join('\r\n');
    }).join('\r\n\r\n'),
    '',
  ].join('\r\n');
  const reportType = NON_ASCII_RE.test(report) ? 'message/global-delivery-status' : 'message/delivery-status';

  const subject = encodeHeaderWord(`${SUBJECTS[action]}: ${opts.originalSubject || '(no subject)'}`);
  const refs = opts.originalMessageId
    ? [`In-Reply-To: ${oneLine(opts.originalMessageId)}`, `References: ${oneLine(opts.originalMessageId)}`]
    : [];

  const head = [
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
    `Content-Type: ${reportType}`,
    '',
    report,
  ].join('\r\n');

  const returned = returnedContent(opts);
  const parts: Buffer[] = [Buffer.from(head, 'utf8')];
  if (returned) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${returned.type}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`, 'utf8'));
    parts.push(returned.body);
    if (!returned.body.subarray(-2).equals(Buffer.from('\r\n'))) parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

/**
 * Sends a DSN to MAIL FROM: local senders get it stored directly, external
 * senders only with `deliverExternal` (via the outbound queue, null sender).
 *
 * If MAIL FROM is empty (= already a bounce mail!) no new DSN is generated
 * (RFC 5321 §6.1, "double-bounce prevention"). Recipients whose NOTIFY does
 * not ask for this kind of report are left out; with none left nothing is sent.
 */
export async function sendDsnBounce(input: DsnOptions): Promise<void> {
  // RFC 5321 §6.1: no bounce for empty MAIL FROM (= "<>" bounce mail itself)
  if (!input.originalFrom || input.originalFrom === '<>') {
    log.info({ originalTo: input.originalTo }, 'DSN suppressed: empty MAIL FROM (double-bounce protection)');
    return;
  }
  const opts = applyDsnRequest(input);
  if (!opts) {
    log.info({ originalTo: input.originalTo, action: input.action ?? 'failed' }, 'DSN suppressed: not requested (RFC 3461 NOTIFY)');
    return;
  }

  const domain = opts.originalFrom.slice(opts.originalFrom.lastIndexOf('@') + 1).toLowerCase();
  if (!opts.originalFrom.includes('@') || !domain) return;
  const localDomain = await prisma.domain.findFirst({
    where: { name: { in: domainVariants(domain) }, active: true },
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
      log.info({ to: opts.originalFrom, code: opts.smtpCode, action: opts.action ?? 'failed' }, 'DSN enqueued to external sender');
    } catch (err) {
      log.error({ err, to: opts.originalFrom }, 'DSN enqueue failed');
    }
    return;
  }

  try {
    await storeInboundMessage(raw, {
      fromAddr: '',     // null sender for bounce (RFC 5321)
      rcptTo:   opts.originalFrom,
      toJunk:   false,
      systemNotice: true, // 9.4: our own NDR passes the mailbox's sender lists / size limit
    });
    log.info(
      { to: opts.originalFrom, code: opts.smtpCode, originalMessageId: opts.originalMessageId, action: opts.action ?? 'failed' },
      'DSN delivered',
    );
  } catch (err) {
    log.error({ err, to: opts.originalFrom }, 'DSN delivery failed');
  }
}

/**
 * Success notifications (RFC 3461 NOTIFY=SUCCESS) for recipients that were
 * delivered locally (`delivered`) or passed to a next hop without DSN support
 * (`relayed`). Only recipients that asked for SUCCESS are reported; nothing is
 * sent when none did. Never throws.
 */
export async function sendSuccessDsn(opts: {
  from: string;
  rcpts: string[];
  action: 'delivered' | 'relayed';
  dsn: EnvelopeDsn | undefined;
  hostname: string;
  originalRaw?: Buffer;
  subject?: string;
  messageId?: string | null;
  deliverExternal?: boolean;
}, send: (o: DsnOptions) => Promise<void> = sendDsnBounce): Promise<string[]> {
  const wanted = opts.rcpts.filter((r) => wantsNotification(rcptDsn(opts.dsn, r), 'success'));
  if (wanted.length === 0 || !opts.from) return [];
  try {
    await send({
      originalFrom:      opts.from,
      originalTo:        wanted,
      originalSubject:   opts.subject ?? '',
      originalMessageId: opts.messageId ?? null,
      failureReason:     '',
      smtpCode:          null,
      serverHostname:    opts.hostname,
      recipients:        wanted.map((rcpt) => ({ rcpt, status: '2.0.0', diagnostic: '' })),
      deliverExternal:   opts.deliverExternal ?? true,
      action:            opts.action,
      ...(opts.dsn ? { dsn: opts.dsn } : {}),
      ...(opts.originalRaw ? { originalRaw: opts.originalRaw } : {}),
    });
  } catch (err) {
    log.warn({ err, from: opts.from }, 'Success DSN failed');
  }
  return wanted;
}

/** Subject and Message-ID of a raw message (for DSN texts and threading). */
export function rawSubjectAndId(raw: Buffer): { subject: string; messageId: string | null } {
  const head = messageHeaders(raw).toString('utf8');
  const subject = /^Subject:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? '';
  const messageId = /^Message-ID:[ \t]*(\S+)/im.exec(head)?.[1] ?? null;
  return { subject, messageId };
}
