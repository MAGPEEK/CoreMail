/**
 * Submission SMTP Handlers — Ports 465 / 587
 *
 * - onConnect: allow all connections (auth is required at MAIL FROM level)
 * - onMailFrom: anti-spoofing check — FROM must be own address or shared mailbox with SEND_AS/FULL_ACCESS
 * - onRcptTo: accept all recipients (external → relay queue)
 * - onMessage: local recipients → storeInboundMessage, external → enqueueOutbound
 */

import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { storeInboundMessage } from '../handlers/message.js';
import { enqueueOutbound } from '../outbound/queue.js';
import type { SmtpHandlers, AuthUser } from '../core/types.js';

/**
 * Prepend a RFC 6409 §6.1 compliant Received: header to a message.
 *
 * Format:
 *   Received: from [<ip>] (helo=<ehlo-domain>)
 *             by <our-hostname> (CoreMail) with ESMTPSA
 *             for <rcpt>; <RFC 2822 date>
 *
 * This traces the submission hop and is required by RFC 6409 §6.1.
 */
function prependReceivedHeader(
  raw: Buffer,
  submittingIp: string,
  authUserEmail: string,
  ourHostname: string,
  firstRcpt: string,
): Buffer {
  const date = new Date().toUTCString().replace('GMT', '+0000');
  const header =
    `Received: from [${submittingIp}] (authenticated user ${authUserEmail})\r\n` +
    `\tby ${ourHostname} (CoreMail) with ESMTPSA\r\n` +
    `\tfor <${firstRcpt}>; ${date}\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), raw]);
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
): Promise<void> {
  // RFC 6409 §6.1 — prepend Received: header for submission tracing
  if (authUser && to.length > 0) {
    try {
      const settings = await prisma.serverSettings.findUnique({
        where: { id: 'singleton' },
        select: { publicHostname: true },
      });
      const hostname = settings?.publicHostname ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';
      raw = prependReceivedHeader(raw, ip, authUser.email, hostname, to[0]!);
    } catch {
      // Non-fatal: continue without Received header if DB unavailable
    }
  }

  const localRcpts: string[] = [];
  const externalRcpts: string[] = [];

  for (const rcpt of to) {
    const [, domain] = rcpt.split('@');
    if (!domain) continue;

    const localDomain = await prisma.domain.findFirst({
      where: { name: domain.toLowerCase(), active: true },
    });

    if (localDomain) {
      localRcpts.push(rcpt);
    } else {
      externalRcpts.push(rcpt);
    }
  }

  // Local delivery — store directly in mailbox
  for (const rcpt of localRcpts) {
    await storeInboundMessage(raw, {
      fromAddr: from,
      rcptTo: rcpt,
      toJunk: false,
    });
  }

  // External delivery — outbound relay queue
  if (externalRcpts.length > 0) {
    await enqueueOutbound({
      messageId: crypto.randomUUID(),
      from,
      to: externalRcpts,
      rawMessage: raw.toString('base64'),
      ...(authUser ? { senderUserId: authUser.id } : {}),
    });
  }

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
 * Returns true if userId is allowed to send as fromAddr:
 *  1. It's their own email address
 *  2. They have SEND_AS or FULL_ACCESS on a shared mailbox with that address
 */
async function checkSenderPermission(userId: string, fromAddr: string): Promise<boolean> {
  const normalised = fromAddr.toLowerCase();

  // 1. Own email address
  const user = await prisma.user.findFirst({
    where: { id: userId, email: normalised, active: true },
    select: { id: true },
  });
  if (user) return true;

  // 2. Shared mailbox permission (SEND_AS or FULL_ACCESS)
  const perm = await prisma.sharedMailboxPerm.findFirst({
    where: {
      userId,
      permission: { in: ['FULL_ACCESS', 'SEND_AS'] },
      sharedMailbox: { email: normalised, active: true },
    },
    select: { id: true },
  });
  return !!perm;
}
