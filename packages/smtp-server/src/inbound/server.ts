import { SMTPServer, type SMTPServerSession, type SMTPServerDataStream } from 'smtp-server';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { storeInboundMessage } from '../handlers/message.js';

const log = createLogger('smtp:inbound');

const SECURITY_FILTER_URL =
  process.env['SECURITY_FILTER_URL'] ?? 'http://security-filter:3002';

const SMTP_HOSTNAME = process.env['SMTP_HOSTNAME'] ?? 'mail.localhost';

interface SessionMeta {
  senderIp: string;
  mailFrom: string;
  rcptTo: string[];
  domainId?: string;
  connectionAllowed?: boolean;
}

const sessionMeta = new Map<string, SessionMeta>();

export function createInboundServer(): SMTPServer {
  const server = new SMTPServer({
    name: SMTP_HOSTNAME,
    banner: `${SMTP_HOSTNAME} CoreMail ESMTP`,

    // TLS — certificates are mounted via volume in production
    secure: false, // STARTTLS
    // key: readFileSync('/certs/privkey.pem'),
    // cert: readFileSync('/certs/fullchain.pem'),

    authOptional: true,
    disabledCommands: [],

    logger: false,
    size: 52428800, // 50 MB max message size

    onConnect(session, callback) {
      const meta: SessionMeta = {
        senderIp: session.remoteAddress,
        mailFrom: '',
        rcptTo: [],
      };
      sessionMeta.set(session.id, meta);
      log.debug({ ip: session.remoteAddress }, 'SMTP connect');
      callback();
    },

    onMailFrom(address, session, callback) {
      const meta = sessionMeta.get(session.id);
      if (meta) {
        meta.mailFrom = address.address;
      }

      // Run connection-level security checks (DNSBL, Greylisting, GeoIP)
      runConnectionCheck(session, address.address)
        .then((allowed) => {
          if (meta) meta.connectionAllowed = allowed;
          if (!allowed) {
            callback(new Error('550 5.7.1 Service unavailable; policy violation'));
          } else {
            callback();
          }
        })
        .catch((err) => {
          log.error({ err }, 'Connection check error — failing open');
          callback();
        });
    },

    onRcptTo(address, session, callback) {
      const meta = sessionMeta.get(session.id);
      if (meta) {
        meta.rcptTo.push(address.address);
      }

      // Verify recipient exists in our system
      verifyRecipient(address.address)
        .then((exists) => {
          if (!exists) {
            callback(new Error('550 5.1.1 User unknown'));
          } else {
            callback();
          }
        })
        .catch((err) => {
          log.error({ err, rcpt: address.address }, 'Recipient verify error');
          callback(new Error('451 4.3.0 Temporary failure'));
        });
    },

    onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
      const meta = sessionMeta.get(session.id);
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const rawMessage = Buffer.concat(chunks);
        log.debug(
          { size: rawMessage.length, from: meta?.mailFrom, rcpt: meta?.rcptTo },
          'Message received',
        );

        processInboundMessage(rawMessage, meta ?? {
          senderIp: session.remoteAddress,
          mailFrom: '',
          rcptTo: [],
        })
          .then(() => callback())
          .catch((err) => {
            log.error({ err }, 'Message processing error');
            callback(new Error('451 4.3.0 Temporary failure, please retry'));
          });
      });

      stream.on('error', (err: Error) => {
        log.error({ err }, 'Stream error');
        callback(err);
      });
    },

    onClose(session) {
      sessionMeta.delete(session.id);
    },
  });

  return server;
}

async function runConnectionCheck(
  session: SMTPServerSession,
  mailFrom: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${SECURITY_FILTER_URL}/check/connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderIp: session.remoteAddress,
        mailFrom,
        rcptTo: '',
      }),
      signal: AbortSignal.timeout(5000),
    });

    const result = await response.json() as { action: string; reason?: string };

    if (result.action === 'reject') {
      log.info({ ip: session.remoteAddress, reason: result.reason }, 'Connection rejected');
      return false;
    }
    if (result.action === 'defer') {
      log.info({ ip: session.remoteAddress, reason: result.reason }, 'Connection deferred');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err }, 'Security filter unreachable — failing open');
    return true;
  }
}

async function verifyRecipient(rcptTo: string): Promise<boolean> {
  const [, domain] = rcptTo.toLowerCase().split('@');
  if (!domain) return false;

  const email = rcptTo.toLowerCase();

  const [user, sharedMailbox, distGroup, resourceMailbox] = await Promise.all([
    prisma.user.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.sharedMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.distributionGroup.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.resourceMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
  ]);

  return !!(user ?? sharedMailbox ?? distGroup ?? resourceMailbox);
}

async function processInboundMessage(
  rawMessage: Buffer,
  meta: SessionMeta,
): Promise<void> {
  // Run full content checks (SPF/DKIM/DMARC, blacklist, ClamAV, rspamd)
  const response = await fetch(`${SECURITY_FILTER_URL}/check/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filter-Context': JSON.stringify({
        senderIp: meta.senderIp,
        mailFrom: meta.mailFrom,
        rcptTo: meta.rcptTo[0] ?? '',
        domainId: meta.domainId,
      }),
    },
    body: rawMessage,
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
    { action: filterResult.action, from: meta.mailFrom, score: filterResult.spamScore },
    'Content check result',
  );

  if (filterResult.action === 'reject') {
    throw new Error(`550 5.7.1 ${filterResult.reason ?? 'Message rejected'}`);
  }

  if (filterResult.action === 'quarantine') {
    await quarantineMessage(rawMessage, meta, filterResult.virusName ?? 'unknown');
    return;
  }

  // Expand distribution groups and collect final delivery addresses
  const deliveryAddresses = await expandRecipients(meta.rcptTo);

  // Store the message for each final recipient
  for (const rcpt of deliveryAddresses) {
    await storeInboundMessage(rawMessage, {
      fromAddr: meta.mailFrom,
      rcptTo: rcpt,
      toJunk: filterResult.junkFolder ?? false,
      ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
    });
  }

  // Handle resource mailbox auto-accept for calendar invitations
  await processResourceMailboxes(rawMessage, meta.rcptTo, meta.mailFrom);
}

/**
 * Recursively expand distribution group addresses to individual member addresses.
 * Prevents infinite loops by tracking visited groups.
 */
async function expandRecipients(
  rcptTo: string[],
  visited = new Set<string>(),
): Promise<string[]> {
  const result: string[] = [];

  for (const email of rcptTo) {
    const normalised = email.toLowerCase();

    // Check if this is a distribution group
    const group = await prisma.distributionGroup.findFirst({
      where: { email: normalised, active: true },
      include: { members: true },
    });

    if (group && !visited.has(normalised)) {
      visited.add(normalised);
      const memberEmails = group.members.map((m) => m.memberEmail);
      // Recurse to handle nested groups
      const expanded = await expandRecipients(memberEmails, visited);
      result.push(...expanded);
    } else if (!group) {
      // Regular recipient (user / shared mailbox / resource mailbox)
      result.push(normalised);
    }
  }

  // Deduplicate
  return [...new Set(result)];
}

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
        return new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`);
      }
      return new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}T${clean.slice(9,11)}:${clean.slice(11,13)}:${clean.slice(13,15)}Z`);
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
        create: { calendarId, uid, summary, organizer: mailFrom, dtStart, dtEnd, status: 'PENDING', icalData },
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
        log.info({ resource: email, uid, conflict: conflict.uid }, 'Resource booking declined — conflict');
        const calendarId = resource.calendar?.id;
        if (calendarId) {
          await prisma.resourceBooking.upsert({
            where: { uid },
            create: { calendarId, uid, summary, organizer: mailFrom, dtStart, dtEnd, status: 'DECLINED', icalData },
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
      create: { calendarId, uid, summary, organizer: mailFrom, dtStart, dtEnd, status: 'ACCEPTED', icalData },
      update: { dtStart, dtEnd, summary, status: 'ACCEPTED', icalData },
    });

    log.info({ resource: email, uid, dtStart, dtEnd }, 'Resource booking accepted');
  }
}

async function quarantineMessage(
  rawMessage: Buffer,
  meta: SessionMeta,
  virusName: string,
): Promise<void> {
  const { uploadBuffer, quarantineKey } = await import('@coremail/storage');

  const qId = crypto.randomUUID();
  const storagePath = quarantineKey(qId);
  await uploadBuffer(storagePath, rawMessage, 'message/rfc822');

  await prisma.quarantine.create({
    data: {
      fromAddr: meta.mailFrom,
      toAddr: meta.rcptTo[0] ?? '',
      subject: '',
      reason: 'VIRUS',
      details: { virusName },
      rawPath: storagePath,
    },
  });

  log.warn({ virusName, from: meta.mailFrom }, 'Message quarantined');

  // Notify admins via Redis pub/sub
  const redis = getRedisClient();
  await redis.publish('admin:event', JSON.stringify({
    type: 'QUARANTINE',
    virusName,
    from: meta.mailFrom,
    to: meta.rcptTo,
    quarantineId: qId,
    timestamp: new Date().toISOString(),
  }));
}
