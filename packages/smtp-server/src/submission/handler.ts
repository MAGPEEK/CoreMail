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
  prisma, checkHeaderSenderIdentity, isSenderAddressAllowed, listAllowedSenderAddresses,
} from '@coremail/storage';
import { storeInboundMessage } from '../handlers/message.js';
import { expandRecipients, isLocalDomainAddress } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import { sendSuccessDsn, rawSubjectAndId } from '../outbound/dsn.js';
import { dsnForRecipients } from '../core/dsn-params.js';
import { buildReceivedHeader, formatRfc5322Date, prependHeader } from '../handlers/trace.js';
import { deliverOnce, deliveryKey, redisDeliveryLedger } from '../handlers/delivery.js';
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

const log = createLogger('smtp:submission');

// ── onConnect ─────────────────────────────────────────────────────────────────

async function onConnect(_ip: string): Promise<boolean> {
  // Submission: accept all connections — authentication is enforced at MAIL FROM
  return true;
}

// ── onMailFrom ────────────────────────────────────────────────────────────────

async function onMailFrom(
  from: string,
  _ip: string,
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

  const hostname = meta?.hostname ?? await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  }).then((s) => s?.publicHostname ?? null).catch(() => null) ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';

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
  const expandedLocalRcpts = localRcpts.length > 0
    ? await expandRecipients(localRcpts)
    : [];

  // Local delivery (mailbox) + external delivery (outbound queue). 250 only
  // when both are done; a failure answers 451 and the client's retry skips
  // what was already delivered (no duplicates, no loss — RFC 5321 §6.1).
  const submittedRaw = raw;
  const txKey = deliveryKey(from, receivedRaw);
  await deliverOnce(txKey, expandedLocalRcpts, externalRcpts, {
    ledger: redisDeliveryLedger,
    // MAIL FROM was checked against the SMTP AUTH identity in onMailFrom.
    storeLocal: (rcpt) => storeInboundMessage(submittedRaw, {
      fromAddr: from, rcptTo: rcpt, toJunk: false, deliveryKey: txKey,
      senderAuth: { authenticatedSender: from },
    }),
    enqueueExternal: async (rcpts) => {
      // RFC 3461: the DSN request travels with the queue job (passed on to a
      // DSN-capable next hop, honoured by the queue's DSNs).
      const jobDsn = dsnForRecipients(meta?.envelope?.dsn, rcpts);
      await enqueueOutbound({
        messageId: crypto.randomUUID(),
        from,
        to: rcpts,
        rawMessage: submittedRaw.toString('base64'),
        senderUserId: authUser.id,
        ...(jobDsn ? { dsn: jobDsn } : {}),
      });
    },
  });

  // RFC 3461 NOTIFY=SUCCESS: "delivered" DSN for local recipients (stored in the sender's mailbox).
  const dsn = meta?.envelope?.dsn;
  if (dsn && localRcpts.length > 0) {
    const original = rawSubjectAndId(submittedRaw);
    await sendSuccessDsn({
      from, rcpts: localRcpts, action: 'delivered', dsn, hostname, originalRaw: submittedRaw,
      subject: original.subject, messageId: original.messageId, deliverExternal: true,
    });
  }

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
