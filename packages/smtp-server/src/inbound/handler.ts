/**
 * Inbound SMTP Handlers — Port 25
 *
 * - onConnect: DNSBL / rate-limit check via security-filter
 * - onMailFrom: accept all senders (Port 25 — inter-MTA relay)
 * - onRcptTo: verify recipient exists (User / SharedMailbox / DistGroup / ResourceMailbox)
 * - onMessage: content scan → quarantine or store for each expanded recipient
 */

import { createLogger } from '@coremail/core';
import { prisma, stripHeaders, INTERNAL_MAIL_HEADERS } from '@coremail/storage';
import crypto from 'crypto';
import { storeInboundMessage } from '../handlers/message.js';
import { quarantineMessage } from '../handlers/quarantine.js';
import { expandRecipients, isPostmasterAddress } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import { BARE_POSTMASTER, type SmtpHandlers, type AuthUser, type MessageMeta } from '../core/types.js';
import { buildReceivedHeader, countReceived, prependHeader, MAX_RECEIVED_HOPS } from '../handlers/trace.js';
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
  const text = raw.slice(0, end > 0 ? end : Math.min(raw.length, 8192)).toString('binary');
  const subjectMatch = /^Subject:\s*(.+?)(?=\r?\n\S|\r?\n\r?\n|$)/im.exec(text);
  const msgIdMatch   = /^Message-ID:\s*([^\r\n]+)/im.exec(text);
  return {
    subject:   (subjectMatch?.[1] ?? '').replace(/\r?\n[ \t]/g, ' ').trim(),
    messageId: (msgIdMatch?.[1] ?? '').trim(),
  };
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
    const exists = await verifyRecipient(to);
    if (!exists) return '5.1.1 User unknown';
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
  // Internal CoreMail headers (quarantine-release trace) are never accepted
  // from outside — strip them before filtering, quarantine or delivery.
  const stripped = stripHeaders(receivedRaw, INTERNAL_MAIL_HEADERS);

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
      'X-Filter-Context': JSON.stringify({
        senderIp: ip,
        mailFrom: from,
        rcptTo: to[0] ?? '',
      }),
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

  if (filterResult.action === 'quarantine') {
    await quarantineMessage({
      raw,
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
  const deliveryAddresses = await expandRecipients(to);

  // 3. Split into local vs. external (Distribution groups may contain external
  //    members like "partner@kunde.com" — these need outbound forwarding, not
  //    local mailbox storage. Without this split, external members were silently
  //    dropped (Bug-Fix v3.18.7).
  const localDeliveries:    string[] = [];
  const externalDeliveries: string[] = [];
  for (const rcpt of deliveryAddresses) {
    const domain = rcpt.split('@')[1]?.toLowerCase();
    if (!domain) { localDeliveries.push(rcpt); continue; }
    const localDomain = await prisma.domain.findFirst({
      where: { name: domain, active: true },
    });
    if (localDomain) localDeliveries.push(rcpt);
    else             externalDeliveries.push(rcpt);
  }

  // 3. Local storage + external forwarding. 250 only when every part is done;
  //    a failure answers 451 and the retry skips what was already delivered
  //    (RFC 5321 §6.1 — neither lost nor duplicated mail).
  const txKey = deliveryKey(from, receivedRaw);
  await deliverOnce(txKey, localDeliveries, externalDeliveries, {
    ledger: redisDeliveryLedger,
    storeLocal: (rcpt) => storeInboundMessage(raw, {
      fromAddr: from,
      rcptTo: rcpt,
      deliveryKey: txKey,
      toJunk: filterResult.junkFolder ?? false,
      ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
    }),
    enqueueExternal: async (rcpts) => {
      await enqueueOutbound({
        messageId:  crypto.randomUUID(),
        from,
        to:         rcpts,
        rawMessage: raw.toString('base64'),
      });
      log.info({ from, external: rcpts, originalTo: to }, 'External targets are forwarded via the outbound queue');
    },
  });

  // 4. Handle resource mailbox auto-accept for calendar invitations
  await processResourceMailboxes(raw, to, from);
}

// ── Exported handler object ───────────────────────────────────────────────────

export const inboundHandlers: SmtpHandlers = {
  onConnect,
  onMailFrom,
  onRcptTo,
  onMessage,
};

// ── Helper: verifyRecipient ───────────────────────────────────────────────────

async function verifyRecipient(rcptTo: string): Promise<boolean> {
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

// ── Helper: processResourceMailboxes ─────────────────────────────────────────

/**
 * Auto-accept/decline calendar invitations for resource mailboxes.
 * Parses iCal data from the message and creates/declines bookings accordingly.
 */
async function processResourceMailboxes(
  rawMessage: Buffer,
  rcptTo: string[],
  mailFrom: string,
): Promise<void> {
  for (const email of rcptTo) {
    const resource = await prisma.resourceMailbox.findFirst({
      where: { email: email.toLowerCase(), active: true },
      include: { calendar: true },
    });

    if (!resource) continue;

    // Extract iCal data from message (look for VEVENT in text/calendar attachment)
    const rawText = rawMessage.toString('utf8');
    const icalMatch = rawText.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/);
    if (!icalMatch) continue;

    const icalData = icalMatch[0];

    // Extract essential fields
    const uidMatch = /^UID:(.+)$/m.exec(icalData);
    const dtStartMatch = /^DTSTART[^:]*:(\d{8}T\d{6}Z?|\d{8})/m.exec(icalData);
    const dtEndMatch = /^DTEND[^:]*:(\d{8}T\d{6}Z?|\d{8})/m.exec(icalData);
    const summaryMatch = /^SUMMARY:(.+)$/m.exec(icalData);
    const methodMatch = /^METHOD:(.+)$/m.exec(icalData);

    if (!uidMatch || !dtStartMatch || !dtEndMatch) continue;

    const uid = uidMatch[1]?.trim() ?? '';
    const summary = summaryMatch?.[1]?.trim() ?? 'Meeting';
    const method = methodMatch?.[1]?.trim() ?? 'REQUEST';

    // Parse dates (basic ISO conversion)
    const parseDtStamp = (s: string): Date => {
      const clean = s.replace(/Z$/, '');
      if (clean.length === 8) {
        return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
      }
      return new Date(
        `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T` +
          `${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`,
      );
    };

    const dtStart = parseDtStamp(dtStartMatch[1] ?? '');
    const dtEnd = parseDtStamp(dtEndMatch[1] ?? '');

    if (isNaN(dtStart.getTime()) || isNaN(dtEnd.getTime())) continue;

    // Handle CANCEL method — remove booking
    if (method === 'CANCEL') {
      await prisma.resourceBooking.deleteMany({ where: { uid } });
      log.info({ resource: email, uid }, 'Resource booking cancelled');
      continue;
    }

    if (!resource.autoAccept || resource.requireApproval) {
      // Store as PENDING for manual approval
      const calendarId = resource.calendar?.id;
      if (!calendarId) continue;
      await prisma.resourceBooking.upsert({
        where: { uid },
        create: {
          calendarId,
          uid,
          summary,
          organizer: mailFrom,
          dtStart,
          dtEnd,
          status: 'PENDING',
          icalData,
        },
        update: { dtStart, dtEnd, summary, status: 'PENDING', icalData },
      });
      log.info({ resource: email, uid }, 'Resource booking pending approval');
      continue;
    }

    // Check for conflicts
    if (resource.autoDeclineConflict) {
      const conflict = await prisma.resourceBooking.findFirst({
        where: {
          calendar: { resourceId: resource.id },
          uid: { not: uid },
          status: { in: ['ACCEPTED', 'TENTATIVE'] },
          dtStart: { lt: dtEnd },
          dtEnd: { gt: dtStart },
        },
      });

      if (conflict) {
        log.info(
          { resource: email, uid, conflict: conflict.uid },
          'Resource booking declined — conflict',
        );
        const calendarId = resource.calendar?.id;
        if (calendarId) {
          await prisma.resourceBooking.upsert({
            where: { uid },
            create: {
              calendarId,
              uid,
              summary,
              organizer: mailFrom,
              dtStart,
              dtEnd,
              status: 'DECLINED',
              icalData,
            },
            update: { status: 'DECLINED' },
          });
        }
        continue;
      }
    }

    // Auto-accept
    const calendarId = resource.calendar?.id;
    if (!calendarId) continue;

    await prisma.resourceBooking.upsert({
      where: { uid },
      create: {
        calendarId,
        uid,
        summary,
        organizer: mailFrom,
        dtStart,
        dtEnd,
        status: 'ACCEPTED',
        icalData,
      },
      update: { dtStart, dtEnd, summary, status: 'ACCEPTED', icalData },
    });

    log.info({ resource: email, uid, dtStart, dtEnd }, 'Resource booking accepted');
  }
}
