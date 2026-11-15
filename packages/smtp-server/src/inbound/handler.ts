/**
 * Inbound SMTP Handlers — Port 25
 *
 * - onConnect: DNSBL / rate-limit check via security-filter
 * - onMailFrom: accept all senders (Port 25 — inter-MTA relay)
 * - onRcptTo: verify recipient exists (User / SharedMailbox / DistGroup / ResourceMailbox)
 * - onMessage: content scan → quarantine or store for each expanded recipient
 */

import { createLogger } from '@coremail/core';
import { prisma, stripHeaders, INTERNAL_MAIL_HEADERS, checkReceiveQuotaForAddress, type SenderAuth } from '@coremail/storage';
import { bounceUnknownLocal, bounceQuotaLocal } from '../handlers/local-delivery.js';
import crypto from 'crypto';
import { storeInboundMessage } from '../handlers/message.js';
import { quarantineMessage } from '../handlers/quarantine.js';
import { expandRecipients, isPostmasterAddress, canonicalRecipient, isLocalDomainAddress } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import { sendSuccessDsn, rawSubjectAndId } from '../outbound/dsn.js';
import { dsnForRecipients } from '../core/dsn-params.js';
import { BARE_POSTMASTER, type SmtpHandlers, type AuthUser, type MessageMeta } from '../core/types.js';
import {
  buildReceivedHeader, countReceived, prependHeader, MAX_RECEIVED_HOPS, stripOwnAuthResults, sanitizeAuthHeaders,
} from '../handlers/trace.js';
import { deliverOnce, deliveryKey, redisDeliveryLedger } from '../handlers/delivery.js';
import {
  callConnectionFilter,
  connectionAllowed,
  dataStageGreylistReply,
  rcptReplyForDecision,
  interpretContentFilterResponse,
  CONTENT_FILTER_MAX_BYTES,
  type ConnectionFilterDecision,
} from './connection-filter.js';

const log = createLogger('smtp:inbound');

const SECURITY_FILTER_URL =
  process.env['SECURITY_FILTER_URL'] ?? 'http://security-filter:3002';

// ── RFC 822 lightweight header extraction (regex, no full parse) ──────────────
function extractRawHeaders(raw: Buffer): { subject: string; messageId: string } {
  const end = raw.indexOf('\r\n\r\n');
  // UTF-8 header fields (RFC 6532, SMTPUTF8 mail) are decoded as UTF-8.
  const text = raw.slice(0, end > 0 ? end : Math.min(raw.length, 8192)).toString('utf8');
  const subjectMatch = /^Subject:\s*(.+?)(?=\r?\n\S|\r?\n\r?\n|$)/im.exec(text);
  const msgIdMatch   = /^Message-ID:\s*([^\r\n]+)/im.exec(text);
  return {
    subject:   (subjectMatch?.[1] ?? '').replace(/\r?\n[ \t]/g, ' ').trim(),
    messageId: (msgIdMatch?.[1] ?? '').trim(),
  };
}

/** JSON with every non-ASCII character \u-escaped (safe as an HTTP header value). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ── onConnect ─────────────────────────────────────────────────────────────────

// At connect time only the client IP is known → IP-based checks only
// (DNSBL/DNSWL, GeoIP). Greylisting needs the full triple and runs at RCPT TO.
async function onConnect(ip: string): Promise<boolean> {
  const decision = await callConnectionFilter(SECURITY_FILTER_URL, { stage: 'connect', senderIp: ip });
  if (decision.kind === 'unavailable') {
    log.error({ ip, detail: decision.detail }, 'Security filter unavailable (connect stage) — failing open');
  } else if (decision.kind === 'block') {
    log.info({ ip, action: decision.action, reason: decision.reason }, 'Inbound connection blocked');
  }
  return connectionAllowed(decision);
}

async function greylistDecision(ip: string, from: string, rcpt: string): Promise<ConnectionFilterDecision> {
  // Addresses keep the case of their local-part (RFC 5321 §2.4) — the greylist
  // triple is case-insensitive.
  const decision = await callConnectionFilter(SECURITY_FILTER_URL, {
    stage: 'rcpt', senderIp: ip, mailFrom: from.toLowerCase(), rcptTo: rcpt.toLowerCase(),
  });
  if (decision.kind === 'unavailable') {
    log.error({ ip, from, rcpt, detail: decision.detail }, 'Security filter unavailable (greylisting) — failing open');
  } else if (decision.kind === 'block') {
    log.info({ ip, from, rcpt, action: decision.action, reason: decision.reason }, 'Recipient deferred/rejected by connection filter');
  }
  return decision;
}

// ── onMailFrom ────────────────────────────────────────────────────────────────

async function onMailFrom(
  _from: string,
  _ip: string,
  _authUser: AuthUser | null,
): Promise<string | null> {
  // Port 25: accept all senders (inter-MTA relay)
  return null;
}

// ── onRcptTo ──────────────────────────────────────────────────────────────────

async function onRcptTo(
  to: string,
  from: string,
  authUser: AuthUser | null,
  ip?: string,
): Promise<string | null> {
  try {
    // Local delivery can be disabled globally via SmtpSettings.localDeliveryEnabled.
    // Reject with 5.7.1 (prohibited) so the external MTA stops delivering.
    const settings = await prisma.smtpSettings.findUnique({
      where: { id: 'singleton' }, select: { localDeliveryEnabled: true },
    });
    if (settings && settings.localDeliveryEnabled === false) {
      return '5.7.1 Local delivery is disabled by administrator';
    }
    // v8.1: an IDN domain matches the local domain in either spelling.
    const canonical = await canonicalRecipient(to);
    const exists = await verifyRecipient(canonical);
    if (!exists) return '5.1.1 User unknown';
    // v8.1: ProhibitSendReceiveQuota — refuse at RCPT TO (cached usage, no
    // mailbox scan): 552 5.2.2, or 452 4.2.2 per QUOTA_FULL_PERMANENT.
    const full = await checkReceiveQuotaForAddress(canonical);
    if (full) return full;
  } catch (err) {
    log.error({ err, to }, 'verifyRecipient error');
    return '4.3.0 Temporary failure';
  }

  // Greylisting with the real (IP, MAIL FROM, RCPT TO) triple — only for
  // existing recipients, never for authenticated sessions.
  if (ip && !authUser) {
    return rcptReplyForDecision(await greylistDecision(ip, from, to));
  }
  return null;
}

// ── onMessage ─────────────────────────────────────────────────────────────────

async function onMessage(
  receivedRaw: Buffer,
  from: string,
  to: string[],
  authUser: AuthUser | null,
  ip: string,
  meta?: MessageMeta,
): Promise<void> {
  const hostname = meta?.hostname ?? process.env['SMTP_HOSTNAME'] ?? 'mail.localhost';
  // Internal CoreMail headers (quarantine-release trace) are never accepted
  // from outside — strip them before filtering, quarantine or delivery. Same
  // for Authentication-Results fields carrying our authserv-id (RFC 8601 §5).
  const stripped = stripOwnAuthResults(stripHeaders(receivedRaw, INTERNAL_MAIL_HEADERS), hostname);

  // RFC 5321 §6.3: loop detection by hop count.
  if (countReceived(stripped) > MAX_RECEIVED_HOPS) {
    throw new Error('554 5.4.6 Too many hops - mail loop detected');
  }

  // 0. Greylisting fallback for callers that do not pass the session data
  //    (SmtpSession always passes `meta` and the client IP to onRcptTo, where
  //    greylisting runs).
  if (!meta && !authUser) {
    const decisions = await Promise.all(to.map((rcpt) => greylistDecision(ip, from, rcpt)));
    const reply = dataStageGreylistReply(decisions);
    if (reply) throw new Error(reply);
  }

  // RFC 5321 §4.4: every SMTP server that receives a message inserts a
  // Received: trace field (`for` only with a single recipient, §7.2).
  const raw = meta ? prependHeader(stripped, buildReceivedHeader({ ip, meta, recipients: to })) : stripped;

  // The content filter cannot inspect larger bodies — never deliver unscanned
  // and never defer forever (an over-limit 413 would repeat on every retry).
  if (raw.length > CONTENT_FILTER_MAX_BYTES) {
    throw new Error('552 5.3.4 Message too big for content inspection');
  }

  // 1. Full content scan (SPF/DKIM/DMARC, blacklist, ClamAV, rspamd)
  const response = await fetch(`${SECURITY_FILTER_URL}/check/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      // The real SMTP session: SPF/DMARC and rspamd evaluate MAIL FROM, HELO and IP.
      // ASCII-only JSON: an HTTP header value cannot carry raw UTF-8
      // (SMTPUTF8 addresses) — non-ASCII characters are \u-escaped.
      'X-Filter-Context': asciiJson(filterContext({
        senderIp: ip,
        mailFrom: from,
        rcpts: to,
        hostname,
        ...(meta?.helo ? { helo: meta.helo } : {}),
        ...(authUser ? { authUser: authUser.email } : {}),
      })),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });

  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  const verdict = interpretContentFilterResponse(response.status, body);
  if (verdict.kind === 'unavailable') {
    log.error({ from, detail: verdict.detail }, 'Content filter answer invalid — message deferred');
    throw new Error('451 4.7.1 Content filter temporarily unavailable, try again later');
  }
  const filterResult = verdict.result;

  log.info(
    { action: filterResult.action, from, score: filterResult.spamScore },
    'Content check result',
  );

  if (filterResult.action === 'reject') {
    const headers = extractRawHeaders(raw);
    void prisma.systemLog.create({
      data: {
        level: 'WARN',
        service: 'smtp-server',
        category: 'MAIL_FLOW',
        message: `Rejected: ${from} → ${to[0] ?? ''}`,
        ...(headers.messageId ? { messageId: headers.messageId } : {}),
        metadata: {
          sender: from,
          recipient: to.join(', '),
          subject: headers.subject,
          status: 'REJECTED',
          messageId: headers.messageId,
          size: String(raw.length),
          spamScore: filterResult.spamScore !== undefined ? String(filterResult.spamScore) : '',
          reason: filterResult.reason ?? 'Message rejected',
          direction: 'INBOUND',
        },
      },
    }).catch((err: unknown) => log.error({ err }, 'MAIL_FLOW log failed'));
    throw new Error(`550 5.7.1 ${filterResult.reason ?? 'Message rejected'}`);
  }

  if (filterResult.action === 'defer') {
    // e.g. ClamAV unavailable with clamavBlockOnFailure — sender retries later
    throw new Error(`451 4.7.1 ${filterResult.reason ?? 'Temporary content filter failure'}`);
  }

  // RFC 8601: our verdict travels with the stored message.
  const authHeaders = filterResult.authHeaders ? sanitizeAuthHeaders(filterResult.authHeaders) : '';
  const delivered = authHeaders ? prependHeader(raw, authHeaders) : raw;
  const senderAuth: SenderAuth = authUser
    ? { authenticatedSender: from }
    : { verifiedDomains: filterResult.verifiedDomains ?? [] };

  if (filterResult.action === 'quarantine') {
    await quarantineMessage({
      raw: delivered,
      from,
      recipients: to,
      reason:     filterResult.virusName ? 'VIRUS' : 'SPAM',
      details:    {
        source: 'content-filter',
        ...(filterResult.virusName ? { virusName: filterResult.virusName } : {}),
        ...(filterResult.reason ? { filterReason: filterResult.reason } : {}),
      },
      ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
    });
    return;
  }

  // 2. Expand distribution groups → individual delivery addresses
  //    (IDN domains are mapped onto the configured spelling — v8.1).
  const deliveryAddresses = await expandRecipients(to);

  // 3. Split into local vs. external (Distribution groups may contain external
  //    members like "partner@kunde.com" — these need outbound forwarding, not
  //    local mailbox storage. Without this split, external members were silently
  //    dropped (Bug-Fix v3.18.7).
  const localDeliveries:    string[] = [];
  const externalDeliveries: string[] = [];
  for (const rcpt of deliveryAddresses) {
    if (!rcpt.includes('@')) { localDeliveries.push(rcpt); continue; }
    if (await isLocalDomainAddress(rcpt)) localDeliveries.push(rcpt);
    else                                  externalDeliveries.push(rcpt);
  }
  const dsn = meta?.envelope?.dsn;

  // 3. Local storage + external forwarding. 250 only when every part is done;
  //    a failure answers 451 and the retry skips what was already delivered
  //    (RFC 5321 §6.1 — neither lost nor duplicated mail).
  const txKey = deliveryKey(from, receivedRaw);
  const unknownRcpts: string[] = [];
  const fullRcpts: string[] = [];
  await deliverOnce(txKey, localDeliveries, externalDeliveries, {
    ledger: redisDeliveryLedger,
    // Resource mailboxes (room bookings) are handled inside storeInboundMessage.
    storeLocal: async (rcpt) => {
      const result = await storeInboundMessage(delivered, {
        fromAddr: from,
        rcptTo: rcpt,
        deliveryKey: txKey,
        toJunk: filterResult.junkFolder ?? false,
        senderAuth,
        ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
      });
      if (result === 'unknown') unknownRcpts.push(rcpt);
      if (result === 'quota') fullRcpts.push(rcpt);
    },
    enqueueExternal: async (rcpts) => {
      const jobDsn = dsnForRecipients(dsn, rcpts);
      await enqueueOutbound({
        messageId:  crypto.randomUUID(),
        from,
        to:         rcpts,
        rawMessage: delivered.toString('base64'),
        ...(jobDsn ? { dsn: jobDsn } : {}),
      });
      log.info({ from, external: rcpts, originalTo: to }, 'External targets are forwarded via the outbound queue');
    },
  });

  // 4. RFC 3461 NOTIFY=SUCCESS: "delivered" DSN for the local recipients as
  //    addressed. Not for mail filed as junk (no delivery confirmation to spammers).
  if (dsn && !filterResult.junkFolder) {
    await notifyLocalSuccess(from, to.filter((r) => !unknownRcpts.includes(r) && !fullRcpts.includes(r)), dsn, hostname, delivered);
  }

  // 5. A recipient verified at RCPT TO but gone at delivery time (deleted in
  //    between) — the message was accepted (250), so the sender gets an NDR.
  if (unknownRcpts.length > 0) {
    await bounceUnknownLocal(raw, from, unknownRcpts, { hostname }).catch((err: unknown) =>
      log.error({ err, from, unknownRcpts }, 'NDR for unknown local recipients failed'));
  }
  // 6. v8.1: a mailbox that filled up between RCPT TO and delivery → NDR (5.2.2).
  if (fullRcpts.length > 0) {
    await bounceQuotaLocal(raw, from, fullRcpts, { hostname }).catch((err: unknown) =>
      log.error({ err, from, fullRcpts }, 'NDR for over-quota local recipients failed'));
  }
}

/** Sends the "delivered" DSN for the local recipients that asked for SUCCESS (never throws). */
async function notifyLocalSuccess(
  from: string,
  to: string[],
  dsn: NonNullable<NonNullable<MessageMeta['envelope']>['dsn']>,
  hostname: string,
  raw: Buffer,
): Promise<void> {
  try {
    const local: string[] = [];
    for (const rcpt of to) if (rcpt === BARE_POSTMASTER || await isLocalDomainAddress(rcpt)) local.push(rcpt);
    const original = rawSubjectAndId(raw);
    await sendSuccessDsn({
      from, rcpts: local, action: 'delivered', dsn, hostname, originalRaw: raw,
      subject: original.subject, messageId: original.messageId, deliverExternal: true,
    });
  } catch (err) {
    log.warn({ err, from }, 'Success DSN not sent');
  }
}


/** Most recipients listed in X-Filter-Context (HTTP header size limit, 16 KB). */
export const FILTER_CONTEXT_MAX_RCPTS = 100;

/**
 * Pure: the content-filter context. At most FILTER_CONTEXT_MAX_RCPTS recipients
 * are listed (`rcptCount` carries the total) — a long list would exceed the
 * HTTP header limit (431) and defer the message forever.
 */
export function filterContext(c: {
  senderIp: string; mailFrom: string; rcpts: string[]; hostname: string; helo?: string; authUser?: string;
}): Record<string, unknown> {
  const capped = c.rcpts.length > FILTER_CONTEXT_MAX_RCPTS;
  return {
    senderIp: c.senderIp,
    mailFrom: c.mailFrom,
    rcptTo: c.rcpts[0] ?? '',
    rcpts: capped ? c.rcpts.slice(0, FILTER_CONTEXT_MAX_RCPTS) : c.rcpts,
    ...(capped ? { rcptCount: c.rcpts.length } : {}),
    hostname: c.hostname,
    ...(c.helo ? { helo: c.helo } : {}),
    ...(c.authUser ? { authUser: c.authUser } : {}),
  };
}

// ── Exported handler object ───────────────────────────────────────────────────

export const inboundHandlers: SmtpHandlers = {
  onConnect,
  onMailFrom,
  onRcptTo,
  onMessage,
};

// ── Helper: verifyRecipient ───────────────────────────────────────────────────

export async function verifyRecipient(rcptTo: string): Promise<boolean> {
  const email = rcptTo.toLowerCase();
  // RFC 5321 §4.5.1: <Postmaster> MUST be accepted.
  if (email === BARE_POSTMASTER) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!email.includes('@') || !domain) return false;

  // postmaster@<local domain> MUST be accepted even without a mailbox of that
  // name — expandRecipients delivers it to an administrator.
  if (isPostmasterAddress(email)) {
    const local = await prisma.domain.findFirst({ where: { name: domain, active: true }, select: { id: true } });
    if (local) return true;
  }

  const [user, sharedMailbox, resourceMailbox, alias] = await Promise.all([
    prisma.user.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.sharedMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
    // v5.6.1: distributionGroup lookup removed (feature completely dropped)
    prisma.resourceMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
    // Alias must be active and the target must be active as well
    prisma.emailAlias.findFirst({
      where: {
        address: email,
        active: true,
        OR: [
          { targetUser:   { active: true } },
          { targetShared: { active: true } },
        ],
      },
      select: { id: true },
    }),
  ]);

  return !!(user ?? sharedMailbox ?? resourceMailbox ?? alias);
}

// The expandRecipients helper was moved to handlers/expand.ts so it can also be
// used by the outbound queue worker and the submission handler
// (local delivery needs alias resolution BEFORE storeInboundMessage).

// Resource mailboxes (room/equipment bookings) are processed inside
// storeInboundMessage() for every delivery path — see handlers/resource-booking.ts.
export { processResourceMailboxes } from '../handlers/resource-booking.js';
