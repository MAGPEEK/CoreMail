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

  const [user, sharedMailbox] = await Promise.all([
    prisma.user.findFirst({
      where: { email: rcptTo.toLowerCase(), active: true },
      select: { id: true },
    }),
    prisma.sharedMailbox.findFirst({
      where: { email: rcptTo.toLowerCase(), active: true },
      select: { id: true },
    }),
  ]);

  return !!(user ?? sharedMailbox);
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

  // Store the message for each recipient
  for (const rcpt of meta.rcptTo) {
    await storeInboundMessage(rawMessage, {
      fromAddr: meta.mailFrom,
      rcptTo: rcpt,
      toJunk: filterResult.junkFolder ?? false,
      ...(filterResult.spamScore !== undefined ? { spamScore: filterResult.spamScore } : {}),
    });
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
