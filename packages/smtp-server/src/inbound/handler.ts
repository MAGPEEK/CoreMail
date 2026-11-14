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
import { expandRecipients } from '../handlers/expand.js';
import { enqueueOutbound } from '../outbound/queue.js';
import type { SmtpHandlers, AuthUser } from '../core/types.js';
import {
  callConnectionFilter,
  connectionAllowed,
  dataStageGreylistReply,
  rcptReplyForDecision,
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

// True once the session passes the client IP to onRcptTo — then greylisting
// runs at RCPT TO and the DATA-stage fallback in onMessage is skipped.
let rcptStageHasIp = false;

async function greylistDecision(ip: string, from: string, rcpt: string): Promise<ConnectionFilterDecision> {
  const decision = await callConnectionFilter(SECURITY_FILTER_URL, {
    stage: 'rcpt', senderIp: ip, mailFrom: from, rcptTo: rcpt,
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
    rcptStageHasIp = true;
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
): Promise<void> {
  // Internal CoreMail headers (quarantine-release trace) are never accepted
  // from outside — strip them before filtering, quarantine or delivery.
  const raw = stripHeaders(receivedRaw, INTERNAL_MAIL_HEADERS);

  // 0. Greylisting fallback: if the SMTP session does not hand the client IP
  //    to onRcptTo, the triple is checked here (after DATA) instead.
  if (!rcptStageHasIp && !authUser) {
    const decisions = await Promise.all(to.map((rcpt) => greylistDecision(ip, from, rcpt)));
    const reply = dataStageGreylistReply(decisions);
    if (reply) throw new Error(reply);
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

  const filterResult = await response.json() as {
    action: string;
    reason?: string;
    junkFolder?: boolean;
    spamScore?: number;
    virusName?: string;
  };

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

  // 3a. Local mailbox storage
  for (const rcpt of localDeliveries) {
    await storeInboundMessage(raw, {
      fromAddr: from,
      rcptTo: rcpt,
      toJunk: filterResult.junkFolder ?? false,
      ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
    });
  }

  // 3b. External members of expanded groups → enqueue outbound (forward)
  if (externalDeliveries.length > 0) {
    try {
      await enqueueOutbound({
        messageId:  crypto.randomUUID(),
        from,
        to:         externalDeliveries,
        rawMessage: raw.toString('base64'),
      });
      log.info(
        { from, externalDeliveries, originalTo: to },
        'External distribution-group members are forwarded via outbound queue',
      );
    } catch (err) {
      log.error({ err, externalDeliveries }, 'Outbound forward for distribution-group members failed');
    }
  }

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
  const [, domain] = rcptTo.toLowerCase().split('@');
  if (!domain) return false;

  const email = rcptTo.toLowerCase();

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
