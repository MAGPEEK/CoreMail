/**
 * Helpers shared by every local-delivery path (port 25 inbound, SMTP
 * submission, outbound worker for MWA/REST, JMAP, EAS and rule forwards):
 *
 *  - stripOwnAuthResults for all of our authserv-ids: a local user must not be
 *    able to deliver a forged `Authentication-Results: <our host>; dmarc=pass`
 *    to colleagues (RFC 8601 §5). Port 25 strips on receipt; the local paths
 *    strip here before storing. Same for the internal X-CoreMail-* headers.
 *  - an NDR for recipients that turn out to be unknown at delivery time
 *    (deleted/deactivated after the message was accepted) — never a silent drop.
 */
import { createLogger } from '@coremail/core';
import { prisma, stripHeaders, internalHeadersExcept } from '@coremail/storage';
import { stripOwnAuthResults } from './trace.js';
import { sendDsnBounce, type DsnOptions } from '../outbound/dsn.js';

const log = createLogger('smtp:local-delivery');

const IDS_TTL_MS = 60_000;
let cachedIds: { ids: string[]; at: number } | null = null;

/** Pure: our authserv-ids (public host name + legacy env names), lower case, unique. */
export function authservIdsFrom(publicHostname: string | null | undefined, env: Record<string, string | undefined> = process.env): string[] {
  const ids = [publicHostname, env['SMTP_HOSTNAME'], env['MAIL_HOSTNAME']]
    .map((v) => (v ?? '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(ids)];
}

/** Our authserv-ids (ServerSettings.publicHostname + SMTP_HOSTNAME/MAIL_HOSTNAME), cached 60 s. */
export async function ownAuthservIds(now = Date.now()): Promise<string[]> {
  if (cachedIds && now - cachedIds.at < IDS_TTL_MS) return cachedIds.ids;
  let publicHostname: string | null = null;
  try {
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
    publicHostname = s?.publicHostname ?? null;
  } catch (err) {
    log.warn({ err }, 'publicHostname lookup failed — using the env host names');
  }
  const ids = authservIdsFrom(publicHostname);
  cachedIds = { ids, at: now };
  return ids;
}

/** Pure: stripOwnAuthResults for several authserv-ids. */
export function stripOwnAuthResultsAll(raw: Buffer, ids: readonly string[]): Buffer {
  let out = raw;
  for (const id of ids) out = stripOwnAuthResults(out, id);
  return out;
}

/**
 * Removes Authentication-Results fields carrying one of our authserv-ids and
 * every internal X-CoreMail-* header (storage INTERNAL_MAIL_HEADERS: the
 * virus-scan verdict only the port-25 path adds after its own scan, the
 * rule-forward loop header, …) — a local user must not inject any of them
 * into a colleague's mailbox (rules match on the verdict, the loop header
 * suppresses forwarding). `keepHeaders`: genuine ones of an internal producer.
 */
export async function stripForLocalDelivery(
  raw: Buffer,
  extraIds: readonly string[] = [],
  keepHeaders: readonly string[] = [],
): Promise<Buffer> {
  return stripOwnAuthResultsAll(
    stripHeaders(raw, internalHeadersExcept(keepHeaders)),
    [...new Set([...(await ownAuthservIds()), ...extraIds.map((i) => i.toLowerCase())])],
  );
}

/** Pure: subject + Message-ID of a raw message (for the NDR). */
function headerInfo(raw: Buffer): { subject: string; messageId: string | null } {
  const end = raw.indexOf('\r\n\r\n');
  const text = raw.subarray(0, end > 0 ? end : Math.min(raw.length, 8192)).toString('utf8').replace(/\r?\n(?=[ \t])/g, ' ');
  return {
    subject: (/^Subject:[ \t]*(.*)$/im.exec(text)?.[1] ?? '').trim(),
    messageId: (/^Message-ID:[ \t]*(.*)$/im.exec(text)?.[1] ?? '').trim() || null,
  };
}

/** Pure: DSN options for recipients unknown at delivery time (5.1.1). */
export function unknownRecipientDsn(raw: Buffer, from: string, rcpts: readonly string[], hostname: string, deliverExternal: boolean): DsnOptions {
  const { subject, messageId } = headerInfo(raw);
  return {
    originalFrom: from,
    originalTo: [...rcpts],
    originalSubject: subject,
    originalMessageId: messageId,
    failureReason: 'Mailbox unavailable: the recipient no longer exists',
    smtpCode: 550,
    serverHostname: hostname,
    recipients: rcpts.map((rcpt) => ({ rcpt, status: '5.1.1', diagnostic: '550 5.1.1 Mailbox unavailable', remote: false })),
    deliverExternal,
  };
}

/**
 * Sends one NDR (null sender, RFC 3464) for local recipients that were unknown
 * at delivery time. Never for a null-sender message (no bounce of a bounce).
 */
export async function bounceUnknownLocal(
  raw: Buffer,
  from: string,
  rcpts: readonly string[],
  opts: { hostname?: string; deliverExternal?: boolean; bounce?: (o: DsnOptions) => Promise<void> } = {},
): Promise<void> {
  if (rcpts.length === 0) return;
  if (!from) {
    log.warn({ rcpts }, 'Unknown local recipient for a null-sender message — not bounced');
    return;
  }
  const hostname = opts.hostname ?? (await ownAuthservIds())[0] ?? 'mail.localhost';
  log.warn({ from, rcpts }, 'Recipient unknown at delivery time — sending an NDR');
  await (opts.bounce ?? sendDsnBounce)(unknownRecipientDsn(raw, from, rcpts, hostname, opts.deliverExternal ?? true));
}

/** Pure: DSN options for local recipients whose mailbox is over its receive quota (5.2.2, v8.1). */
export function quotaExceededDsn(raw: Buffer, from: string, rcpts: readonly string[], hostname: string, deliverExternal: boolean): DsnOptions {
  const { subject, messageId } = headerInfo(raw);
  return {
    originalFrom: from,
    originalTo: [...rcpts],
    originalSubject: subject,
    originalMessageId: messageId,
    failureReason: 'Mailbox full: the recipient\'s mailbox is over its storage quota',
    smtpCode: 552,
    serverHostname: hostname,
    recipients: rcpts.map((rcpt) => ({ rcpt, status: '5.2.2', diagnostic: '552 5.2.2 Mailbox full', remote: false })),
    deliverExternal,
  };
}

/**
 * NDR (5.2.2) for local recipients whose mailbox was over its
 * ProhibitSendReceiveQuota at delivery time. Never for a null-sender message.
 */
export async function bounceQuotaLocal(
  raw: Buffer,
  from: string,
  rcpts: readonly string[],
  opts: { hostname?: string; deliverExternal?: boolean; bounce?: (o: DsnOptions) => Promise<void> } = {},
): Promise<void> {
  if (rcpts.length === 0) return;
  if (!from) {
    log.warn({ rcpts }, 'Mailbox full for a null-sender message — not bounced');
    return;
  }
  const hostname = opts.hostname ?? (await ownAuthservIds())[0] ?? 'mail.localhost';
  log.warn({ from, rcpts }, 'Recipient mailbox over quota at delivery time — sending an NDR');
  await (opts.bounce ?? sendDsnBounce)(quotaExceededDsn(raw, from, rcpts, hostname, opts.deliverExternal ?? true));
}

/** NDR diagnostic of a delivery refused by the recipient's mail flow policy (9.4). */
export const POLICY_REFUSED_DIAGNOSTIC = '550 5.7.1 Delivery refused by the recipient\'s mailbox restrictions';

/** Pure: DSN options for local recipients whose mail flow policy refused the message (5.7.1, 9.4). */
export function policyRefusedDsn(raw: Buffer, from: string, rcpts: readonly string[], hostname: string, deliverExternal: boolean): DsnOptions {
  const { subject, messageId } = headerInfo(raw);
  return {
    originalFrom: from,
    originalTo: [...rcpts],
    originalSubject: subject,
    originalMessageId: messageId,
    failureReason: 'The recipient does not accept this message (sender or size restriction of the mailbox)',
    smtpCode: 550,
    serverHostname: hostname,
    recipients: rcpts.map((rcpt) => ({ rcpt, status: '5.7.1', diagnostic: POLICY_REFUSED_DIAGNOSTIC, remote: false })),
    deliverExternal,
  };
}

/**
 * NDR (5.7.1) for local recipients whose accept/reject lists or receive size
 * limit refused the message at delivery time. Never for a null-sender message.
 */
export async function bouncePolicyLocal(
  raw: Buffer,
  from: string,
  rcpts: readonly string[],
  opts: { hostname?: string; deliverExternal?: boolean; bounce?: (o: DsnOptions) => Promise<void> } = {},
): Promise<void> {
  if (rcpts.length === 0) return;
  if (!from) {
    log.warn({ rcpts }, 'Delivery refused by mailbox restrictions for a null-sender message — not bounced');
    return;
  }
  const hostname = opts.hostname ?? (await ownAuthservIds())[0] ?? 'mail.localhost';
  log.warn({ from, rcpts }, 'Delivery refused by the recipient mailbox restrictions — sending an NDR');
  await (opts.bounce ?? sendDsnBounce)(policyRefusedDsn(raw, from, rcpts, hostname, opts.deliverExternal ?? true));
}

/** Tests: forget the cached authserv-ids. */
export function resetAuthservIdCache(): void {
  cachedIds = null;
}
