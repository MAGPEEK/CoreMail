/**
 * Submission SMTP Handlers — Ports 465 / 587
 *
 * - onConnect: allow all connections (auth is required at MAIL FROM level)
 * - onMailFrom: anti-spoofing check — FROM must be own address or shared mailbox with SEND_AS/FULL_ACCESS
 * - onRcptTo: accept all recipients (external → relay queue)
 * - onMessage: local recipients → storeInboundMessage, external → enqueueOutbound
 */

import { createLogger } from '@coremail/core';
import {
  prisma, checkHeaderSenderIdentity, isSenderAddressAllowed, listAllowedSenderAddresses, checkSendQuota,
  stripHeaders, INTERNAL_MAIL_HEADERS, checkUserSendLimits, afterForeignSend, createTraceRecorder, type SendLimitVerdict,
  consumeSendRate, peekSendRate, type SendRateDecision,
} from '@coremail/storage';
import { sessionStages, aliasStage } from '../handlers/trace-stages.js';
import { storeInboundMessage, toLocalOutcome } from '../handlers/message.js';
import { expandRecipientsWithOrigins, isLocalDomainAddress } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import { dsnForRecipients } from '../core/dsn-params.js';
import { buildReceivedHeader, formatRfc5322Date, prependHeader } from '../handlers/trace.js';
import { deliverOnce, deliveryKey, redisDeliveryLedger } from '../handlers/delivery.js';
import { stripForLocalDelivery } from '../handlers/local-delivery.js';
import { notifyLocalOutcomes } from '../handlers/local-notify.js';
import type { SmtpHandlers, AuthUser, MessageMeta } from '../core/types.js';

// ── RFC 822 lightweight header extraction ─────────────────────────────────────
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

/**
 * RFC 6409 §8.2–8.3: the MSA adds a missing `Date:` and `Message-ID:` (Gmail
 * and others reject mail without a Message-ID).
 */
export function completeSubmissionHeaders(raw: Buffer, hostname: string, now = new Date()): Buffer {
  const end = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, end >= 0 ? end : raw.length).toString('latin1');
  const add: string[] = [];
  if (!/^Date:/im.test(head)) add.push(`Date: ${formatRfc5322Date(now)}`);
  if (!/^Message-ID:/im.test(head)) add.push(`Message-ID: <${crypto.randomUUID()}@${hostname}>`);
  if (add.length === 0) return raw;
  return Buffer.concat([Buffer.from(add.map((h) => `${h}\r\n`).join('')), raw]);
}

/** Pure: the SMTP reply for a per-mailbox send limit verdict (9.4), or null. */
export function submissionLimitReply(verdict: SendLimitVerdict): string | null {
  if (verdict.ok) return null;
  return verdict.kind === 'size'
    ? `552 5.3.4 Message exceeds the sender's size limit (${Math.floor(verdict.limit / (1024 * 1024))} MB)`
    : `550 5.5.3 Too many recipients for this sender (max ${verdict.limit})`;
}

/**
 * Pure (10.5): the SMTP reply of a refused send rate (storage submission-rate.ts),
 * or null — always temporary (451 4.7.1, RFC 3463 "delivery not authorized"
 * with a 4yz class): the client keeps the message and retries later.
 */
export function sendRateReply(decision: SendRateDecision): string | null {
  if (decision.allowed) return null;
  return decision.reason === 'blocked'
    ? `451 4.7.1 Sending temporarily suspended for this account, try again in ${decision.retryAfterSec} seconds`
    : `451 4.7.1 Sending rate limit exceeded (max ${decision.limit} ${decision.reason} per hour), try again in ${decision.retryAfterSec} seconds`;
}

/**
 * Pure: removes every internal X-CoreMail-* header (storage INTERNAL_MAIL_HEADERS:
 * virus-scan verdict, rule-forward loop header, …) from a submitted message —
 * local and external recipients — before any rule or forward is evaluated.
 * Port 25 strips them on receipt as well; CoreMail adds its genuine values later.
 */
export function stripSubmittedInternalHeaders(raw: Buffer): Buffer {
  return stripHeaders(raw, INTERNAL_MAIL_HEADERS);
}

const log = createLogger('smtp:submission');

// ── onConnect ─────────────────────────────────────────────────────────────────

async function onConnect(_ip: string): Promise<boolean> {
  // Submission: accept all connections — authentication is enforced at MAIL FROM
  return true;
}

// ── onMailFrom ────────────────────────────────────────────────────────────────

async function onMailFrom(
  from: string,
  ip: string,
  authUser: AuthUser | null,
): Promise<string | null> {
  if (!authUser) {
    // requireAuth=true in config means the session would have already blocked this,
    // but guard here as well.
    return '5.7.0 Authentication required';
  }

  const allowed = await checkSenderPermission(authUser.id, from);
  if (!allowed) {
    log.warn(
      { authed: authUser.email, from },
      'SMTP submission: sender address not allowed',
    );
    return '5.7.1 Sender address not allowed for authenticated user';
  }

  // v8.1: ProhibitSendQuota — a mailbox at/over its send limit may not send
  // (552 5.2.2, RFC 3463 "mailbox full"). Same check as REST/JMAP/EAS.
  const quota = await checkSendQuota(authUser.id);
  if (!quota.allowed) {
    log.info({ authed: authUser.email, usedBytes: quota.status.usedBytes }, 'SMTP submission refused: mailbox over its send quota');
    return quota.reply;
  }

  // 10.5: per-user send rate — refused early (no data transfer) when the account
  // is blocked or already at its hourly message limit. Not counted here: the
  // message is counted with its recipients at the end of DATA.
  const rate = sendRateReply(await peekSendRate({ userId: authUser.id, recipients: 0, protocol: 'smtp', ipAddress: ip }));
  if (rate) {
    log.info({ authed: authUser.email, reply: rate }, 'SMTP submission refused at MAIL FROM: send rate limit');
    return rate;
  }

  return null;
}

// ── onRcptTo ──────────────────────────────────────────────────────────────────

async function onRcptTo(
  _to: string,
  _from: string,
  _authUser: AuthUser | null,
): Promise<string | null> {
  // Submission accepts all recipients — relay check happens in outbound queue
  return null;
}

// ── onMessage ─────────────────────────────────────────────────────────────────

async function onMessage(
  raw: Buffer,
  from: string,
  to: string[],
  authUser: AuthUser | null,
  ip: string,
  meta?: MessageMeta,
): Promise<void> {
  const receivedRaw = raw;
  // Anti-spoofing on the header level: MAIL FROM was checked in onMailFrom, but
  // recipients display From:/Sender:. Both must name the user's own address, an
  // alias, or a Shared Mailbox with SEND_AS/FULL_ACCESS (SEND_ON_BEHALF only with
  // the user's own address in Sender:). Checked before anything is delivered.
  if (!authUser) throw new Error('530 5.7.0 Authentication required');
  const verdict = await checkHeaderSenderIdentity(raw, authUser.id);
  if (!verdict.ok) {
    log.warn({ authed: authUser.email, from, reason: verdict.reason }, 'SMTP submission: header sender not allowed');
    throw new Error('550 5.7.1 From/Sender header not allowed for authenticated user');
  }
  // 9.4: per-mailbox send limits (the listener's global limits were applied by
  // the session already; a per-mailbox value can only narrow them here).
  const limitReply = submissionLimitReply(
    await checkUserSendLimits(authUser.id, { maxBytes: Number.POSITIVE_INFINITY, maxRecipients: Number.POSITIVE_INFINITY }, raw.length, to.length),
  );
  if (limitReply) {
    log.info({ authed: authUser.email, reply: limitReply }, 'SMTP submission refused: per-mailbox send limit');
    throw new Error(limitReply);
  }
  // 10.5: per-user send rate (messages + recipients per hour, shared with every
  // submission path) — counted here, after every other check; refused → 451 4.7.1.
  const rateReply = sendRateReply(await consumeSendRate({ userId: authUser.id, recipients: to.length, protocol: 'smtp', ipAddress: ip }));
  if (rateReply) {
    log.info({ authed: authUser.email, reply: rateReply }, 'SMTP submission refused: send rate limit');
    throw new Error(rateReply);
  }

  const hostname = meta?.hostname ?? await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  }).then((s) => s?.publicHostname ?? null).catch(() => null) ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';

  // The internal virus-scan verdict is only ever set by the port-25 path after
  // its own scan — never accepted from an authenticated client.
  raw = stripSubmittedInternalHeaders(raw);

  // RFC 6409 §8.2–8.3: add a missing Date:/Message-ID:.
  raw = completeSubmissionHeaders(raw, hostname);

  // RFC 5321 §4.4 / RFC 6409 §6.1 — Received: for the submission hop. `for` only
  // with a single recipient: with several (e.g. all-Bcc mail) it would expose a
  // Bcc recipient to everybody (§7.2).
  raw = prependHeader(raw, buildReceivedHeader({
    ip,
    meta: meta ?? { helo: '', protocol: 'ESMTPSA', hostname, sessionId: crypto.randomUUID().slice(0, 8).toUpperCase() },
    recipients: to,
    authenticatedUser: authUser.email,
  }));

  const localRcpts: string[] = [];
  const externalRcpts: string[] = [];

  for (const rcpt of to) {
    // Bare <Postmaster> (RFC 5321 §4.1.1.3) is the local postmaster.
    if (!rcpt.includes('@')) { localRcpts.push(rcpt); continue; }

    // IDN domains match the local domain in either spelling (v8.1).
    if (await isLocalDomainAddress(rcpt)) {
      localRcpts.push(rcpt);
    } else {
      externalRcpts.push(rcpt);
    }
  }

  // Resolve local recipients first (aliases, distribution groups, shared mailbox aliases)
  const { targets: expandedLocalRcpts, origins } = localRcpts.length > 0
    ? await expandRecipientsWithOrigins(localRcpts)
    : { targets: [] as string[], origins: new Map<string, string[]>() };

  // 10.2 message trace: session (port, TLS, AUTH user), sender checks, aliases.
  const trace = createTraceRecorder(sessionStages(ip, meta));
  trace.add('submission', 'ok', { authUser: authUser.email, senderAllowed: true, local: localRcpts.length, external: externalRcpts.length });
  const aliases = aliasStage(origins);
  if (aliases) trace.push(aliases);
  const queueIds: string[] = [];

  // Local delivery (mailbox) + external delivery (outbound queue). 250 only
  // when both are done; a failure answers 451 and the client's retry skips
  // what was already delivered (no duplicates, no loss — RFC 5321 §6.1).
  const submittedRaw = raw;
  // RFC 8601 §5: a local user must not hand colleagues a forged
  // `Authentication-Results: <our host>; dmarc=pass` (port 25 strips on receipt).
  const localRaw = expandedLocalRcpts.length > 0 ? await stripForLocalDelivery(submittedRaw, [hostname]) : submittedRaw;
  const txKey = deliveryKey(from, receivedRaw);
  const { outcomes } = await deliverOnce(txKey, expandedLocalRcpts, externalRcpts, {
    ledger: redisDeliveryLedger,
    // MAIL FROM was checked against the SMTP AUTH identity in onMailFrom.
    storeLocal: async (rcpt) => {
      const result = await storeInboundMessage(localRaw, {
        fromAddr: from, rcptTo: rcpt, toJunk: false, deliveryKey: txKey,
        senderAuth: { authenticatedSender: from },
        trace: trace.stages(),
      });
      return toLocalOutcome(result);
    },
    enqueueExternal: async (rcpts) => {
      // RFC 3461: the DSN request travels with the queue job (passed on to a
      // DSN-capable next hop, honoured by the queue's DSNs).
      const jobDsn = dsnForRecipients(meta?.envelope?.dsn, rcpts);
      const trackingId = crypto.randomUUID();
      const jobId = await enqueueOutbound({
        messageId: trackingId,
        from,
        to: rcpts,
        rawMessage: submittedRaw.toString('base64'),
        senderUserId: authUser.id,
        ...(jobDsn ? { dsn: jobDsn } : {}),
      });
      queueIds.push(trackingId);
      trace.add('queued', 'info', { trackingId, ...(jobId ? { jobId } : {}), recipients: rcpts.length });
    },
  });

  // RFC 3461 NOTIFY=SUCCESS: "delivered" DSN for local recipients (stored in the sender's mailbox).
  // A local recipient that does not exist or is over quota is never dropped
  // silently: the sender gets an NDR (also on a retry after a partial failure).
  await notifyLocalOutcomes({
    from, originals: localRcpts, origins, outcomes, dsn: meta?.envelope?.dsn, hostname,
    deliveredRaw: submittedRaw, ndrRaw: submittedRaw,
  });

  // 9.4: sent as / on behalf of a Shared Mailbox → audit + its Sent copy.
  await afterForeignSend({ userId: authUser.id, raw: submittedRaw, source: 'smtp', ipAddress: ip });

  // MAIL_FLOW — message flow tracing (outbound ACCEPTED)
  const headers = extractRawHeaders(raw);
  void prisma.systemLog.create({
    data: {
      level: 'INFO',
      service: 'smtp-server',
      category: 'MAIL_FLOW',
      message: `Sent: ${from} → ${to.join(', ')}`,
      ...(authUser ? { userId: authUser.id } : {}),
      ...(headers.messageId ? { messageId: headers.messageId } : {}),
      metadata: {
        sender: from,
        recipient: to.join(', '),
        subject: headers.subject,
        status: 'ACCEPTED',
        messageId: headers.messageId,
        size: String(raw.length),
        localCount: String(localRcpts.length),
        externalCount: String(externalRcpts.length),
        direction: 'OUTBOUND',
        // 10.2 message trace: the queue rows of this submission carry these tracking ids
        ...(queueIds.length ? { queueTrackingIds: queueIds.join(', ') } : {}),
        trace: trace.toJSON(),
      },
    },
  }).catch((err: unknown) => log.error({ err }, 'MAIL_FLOW log failed'));

  log.info(
    { from, local: localRcpts.length, external: externalRcpts.length },
    'Submission processed',
  );
}

// ── Exported handler object ───────────────────────────────────────────────────

export const submissionHandlers: SmtpHandlers = {
  onConnect,
  onMailFrom,
  onRcptTo,
  onMessage,
};

// ── Helper: checkSenderPermission ─────────────────────────────────────────────

/**
 * Returns true if userId may use fromAddr as envelope sender: own address, an
 * active alias of the own mailbox, or a Shared Mailbox (address or alias) with
 * SEND_AS/FULL_ACCESS — the shared sender identity policy (@coremail/storage).
 */
async function checkSenderPermission(userId: string, fromAddr: string): Promise<boolean> {
  return isSenderAddressAllowed(fromAddr, await listAllowedSenderAddresses(userId));
}
