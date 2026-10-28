import { Queue, Worker, type Job } from 'bullmq';
import { Readable } from 'stream';
import nodemailer from 'nodemailer';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { prisma, downloadBuffer, deleteObject } from '@coremail/storage';
import { relayMessage } from './relay.js';
import { extractSmtpCode, sendDsnBounce } from './dsn.js';
import { signMessageForUser, encryptMessageForRecipient } from '../smime/index.js';
import { storeInboundMessage } from '../handlers/message.js';
import { expandRecipients } from '../handlers/expand.js';
// Journaling feature completely removed in v3.13.6

const log = createLogger('smtp:outbound-queue');

// ── Message format ────────────────────────────────────────────────────────────
//
// Since v3.17.30: api-gateway passes structured messages (no more base64 blob
// in the Redis job). The worker builds the RFC 5322 buffer with nodemailer.
// SMTP submission (ports 465/587) still uses rawMessage (base64) — email
// clients already deliver complete RFC 5322 messages.

export interface StructuredAttachment {
  filename:    string;
  minioPath:   string;   // key in MinIO (outbound-queue/{jobId}/{filename})
  contentType: string;
  size:        number;
}

export interface StructuredMessage {
  from:       string;    // sender email address
  fromName:   string;    // display name (empty → no quoted string)
  /** Optional RFC 5322 §3.6.2 Sender header for "on behalf of" (SEND_ON_BEHALF). */
  sender?:    string;
  to:         string[];
  cc:         string[];
  bcc:        string[];  // SMTP envelope only, NOT in the header
  subject:    string;
  html:       string;
  text:       string;
  messageId:  string;    // <uuid@domain>
  date:       string;    // ISO string
  inReplyTo?:  string;
  references?: string;
  attachments: StructuredAttachment[];
}

export interface OutboundJob {
  messageId:      string;    // tracking ID (not the email Message-ID)
  from:           string;    // SMTP-Envelope MAIL FROM
  to:             string[];  // SMTP envelope RCPT TO (all: To + CC + BCC)
  senderUserId?:  string;    // for S/MIME auto-sign
  dkimDomain?:    string;
  dkimSelector?:  string;
  dkimPrivateKey?: string;
  // Exactly one of the following fields must be set:
  message?:    StructuredMessage;  // web client path (v3.17.30+)
  rawMessage?: string;             // base64, SMTP submission path (clients)
}

// ── Build RFC 5322 buffer from structured message ─────────────────────────────

async function buildRawFromMessage(msg: StructuredMessage): Promise<Buffer> {
  // Load attachments from MinIO (in parallel)
  const attachments: nodemailer.SendMailOptions['attachments'] = await Promise.all(
    msg.attachments.map(async (att) => ({
      filename:    att.filename,
      content:     await downloadBuffer(att.minioPath),
      contentType: att.contentType,
    }))
  );

  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: 'crlf',   // RFC 5321: SMTP requires CRLF line endings
  });

  const fromField: nodemailer.SendMailOptions['from'] = msg.fromName
    ? { name: msg.fromName, address: msg.from }
    : msg.from;

  const info = await transport.sendMail({
    messageId: msg.messageId,
    from:      fromField,
    // Sender: for SEND_ON_BEHALF — Outlook shows "Stefan on behalf of info@firma.de"
    ...(msg.sender ? { sender: msg.sender } : {}),
    to:        msg.to,
    subject:   msg.subject,
    date:      new Date(msg.date),
    ...(msg.cc.length         ? { cc: msg.cc }                                : {}),
    // BCC: NEVER in the message headers — only in the SMTP envelope (job.to)
    ...(msg.html              ? { html: msg.html }                            : {}),
    ...(msg.text              ? { text: msg.text }                            : {}),
    ...(msg.inReplyTo         ? { inReplyTo:  msg.inReplyTo,
                                  references: msg.references ?? msg.inReplyTo } : {}),
    ...(attachments.length    ? { attachments }                               : {}),
  });

  const stream = info.message as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Clean up a queue job's MinIO attachments after successful delivery. */
async function cleanupMinioAttachments(msg: StructuredMessage): Promise<void> {
  await Promise.allSettled(
    msg.attachments.map((att) => deleteObject(att.minioPath))
  );
}

// ── BullMQ queue ──────────────────────────────────────────────────────────────

const QUEUE_NAME = 'smtp-outbound'; // BullMQ v5: no ':' allowed in queue names

let _queue: Queue<OutboundJob> | null = null;

export function getOutboundQueue(): Queue<OutboundJob> {
  if (!_queue) {
    _queue = new Queue<OutboundJob>(QUEUE_NAME, {
      connection: createBullMqConnection(),
      defaultJobOptions: {
        attempts: 10,
        backoff: {
          type: 'exponential',
          delay: 60_000, // 1 min initial delay, doubles on every retry
        },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 500 },
      },
    });
  }
  return _queue;
}

export async function enqueueOutbound(job: OutboundJob): Promise<string> {
  const queue = getOutboundQueue();
  // Dynamic settings from DB (admin can adjust maxRetryAttempts + backoff
  // without a container restart) — fall back to defaults if not configured.
  let attempts = 10;
  let backoffDelay = 60_000;
  try {
    const settings = await prisma.queueSettings.findUnique({ where: { id: 'singleton' } });
    if (settings) {
      attempts = settings.maxRetryAttempts;
      backoffDelay = settings.retryBackoffDelaySec * 1000;
    }
  } catch { /* DB may be unreachable — use defaults */ }

  const result = await queue.add('send', job, {
    jobId: `${job.messageId}-${Date.now()}`,
    attempts,
    backoff: { type: 'exponential', delay: backoffDelay },
  });
  log.info({ jobId: result.id, to: job.to, attempts, backoffDelay }, 'Nachricht in Ausgangs-Queue eingereiht');
  return result.id ?? '';
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_NAME,
    async (job: Job<OutboundJob>) => {
      const { from, to, senderUserId, dkimDomain, dkimSelector, dkimPrivateKey } = job.data;

      log.info({ jobId: job.id, from, to, attempt: job.attemptsMade + 1 }, 'Zustellung gestartet');

      // ── Schedule-send: cancellation check ────────────────────────────────
      // If the user cancelled the scheduled mail in the MWA via "cancel schedule",
      // the job was removed (BullMQ.remove()), but if it has already started,
      // the worker itself must check whether the message has meanwhile been
      // set to CANCELLED.
      if (job.id) {
        const scheduled = await prisma.message.findFirst({
          where: { scheduledJobId: job.id },
          select: { id: true, scheduledStatus: true },
        });
        if (scheduled && scheduled.scheduledStatus === 'CANCELLED') {
          log.info({ jobId: job.id, msgId: scheduled.id }, 'Geplanter Versand abgebrochen — Worker stoppt');
          return; // mark job as successful without sending
        }
      }

      // ── Build RFC 5322 buffer ─────────────────────────────────────────────
      // Either from a structured message (web client path, v3.17.30+)
      // or from base64 raw data (SMTP submission path, clients).
      let buffer: Buffer;
      if (job.data.message) {
        buffer = await buildRawFromMessage(job.data.message);
        log.debug({ jobId: job.id }, 'RFC-5322-Buffer aus strukturierter Nachricht aufgebaut');
      } else if (job.data.rawMessage) {
        buffer = Buffer.from(job.data.rawMessage, 'base64');
        log.debug({ jobId: job.id }, 'RFC-5322-Buffer aus base64-Rohdaten dekodiert');
      } else {
        throw new Error('OutboundJob ohne message und rawMessage — ungültiger Job');
      }

      // ── Phase 9: S/MIME Auto-Sign / Auto-Encrypt ──────────────────────────
      if (senderUserId) {
        const settings = await prisma.smimeSettings.findUnique({
          where: { userId: senderUserId },
        });
        if (settings?.autoSign) {
          buffer = Buffer.from(await signMessageForUser(buffer, senderUserId));
          log.debug({ jobId: job.id }, 'S/MIME-Signatur angewendet');
        }
        if (settings?.autoEncrypt && to.length === 1) {
          buffer = Buffer.from(await encryptMessageForRecipient(buffer, to[0]!));
          log.debug({ jobId: job.id }, 'S/MIME-Verschlüsselung angewendet');
        }
      }

      // Helper: checks whether an address belongs to a local domain
      async function isLocalAddress(addr: string): Promise<boolean> {
        const domain = addr.split('@')[1]?.toLowerCase();
        if (!domain) return false;
        const localDomain = await prisma.domain.findFirst({
          where: { name: domain, active: true },
        });
        return !!localDomain;
      }

      // ── Phase 1: split recipients into local vs. external ───────────────
      const localRcpts:    string[] = [];
      const externalRcpts: string[] = [];

      for (const rcpt of to) {
        if (await isLocalAddress(rcpt)) localRcpts.push(rcpt);
        else                            externalRcpts.push(rcpt);
      }

      // ── Phase 2: expand local recipients (aliases + distribution groups) ──
      const expandedLocalRcpts = localRcpts.length > 0
        ? await expandRecipients(localRcpts)
        : [];

      // ── Phase 3: split local/external AGAIN after expansion ─────────────
      // CRITICAL FIX (v3.18.7): distribution groups may have external members
      // (e.g. "all@firma.de" with member "partner@kunde.com"). Previously ALL
      // expanded addresses were passed to storeInboundMessage as local —
      // external members were silently lost (mail never arrived).
      const finalLocalRcpts:    string[] = [];
      const finalExternalRcpts: string[] = [...externalRcpts];

      for (const rcpt of expandedLocalRcpts) {
        if (await isLocalAddress(rcpt)) finalLocalRcpts.push(rcpt);
        else                            finalExternalRcpts.push(rcpt);
      }
      // Dedup externals
      const dedupedExternal = [...new Set(finalExternalRcpts)];

      // ── Local delivery (write directly into the mailbox) ──────────────────
      for (const rcpt of finalLocalRcpts) {
        await storeInboundMessage(buffer, {
          fromAddr: from,
          rcptTo:   rcpt,
          toJunk:   false,
        });
        log.info({ rcpt, jobId: job.id }, 'Lokale Zustellung (outbound → Postfach)');
      }

      // ── External delivery via MX / smarthost ──────────────────────────────
      if (dedupedExternal.length > 0) {
        await relayMessage(buffer, from, dedupedExternal, {
          ...(dkimDomain    ? { dkimDomain }    : {}),
          ...(dkimSelector  ? { dkimSelector }  : {}),
          ...(dkimPrivateKey ? { dkimPrivateKey } : {}),
        });
        log.info({ to: dedupedExternal, jobId: job.id }, 'Externe Zustellung (Group/Alias-Expansion)');
      }

      // ── MAIL_FLOW log ─────────────────────────────────────────────────────
      const allDelivered = [...finalLocalRcpts, ...dedupedExternal];
      void prisma.systemLog.create({
        data: {
          level:     'INFO',
          service:   'smtp-server',
          category:  'MAIL_FLOW',
          message:   `Delivered: ${from} → ${allDelivered.join(', ')}`,
          messageId: job.data.messageId,
          ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
          metadata: {
            sender:        from,
            recipient:     allDelivered.join(', '),
            subject:       job.data.message?.subject ?? '',
            status:        'DELIVERED',
            messageId:     job.data.messageId,
            size:          String(buffer.length),
            localRcpts:    finalLocalRcpts.join(', '),
            externalRcpts: dedupedExternal.join(', '),
            direction:     'OUTBOUND',
          },
        },
      }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW-Log fehlgeschlagen'));

      log.info({ jobId: job.id, to }, 'Nachricht zugestellt');

      // Schedule-send: set status to SENT so the banner in the MWA disappears
      if (job.id) {
        await prisma.message.updateMany({
          where: { scheduledJobId: job.id, scheduledStatus: 'PENDING' },
          data:  { scheduledStatus: 'SENT' },
        }).catch((e: unknown) => log.warn({ err: e }, 'scheduledStatus=SENT Update fehlgeschlagen'));
      }
    },
    {
      connection: createBullMqConnection(), // maxRetriesPerRequest: null (required by BullMQ)
      concurrency: 10,
    },
  );

  // ── MinIO cleanup after completion ────────────────────────────────────────
  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Zustellung abgeschlossen');
    if (job.data.message?.attachments.length) {
      void cleanupMinioAttachments(job.data.message).catch(
        (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO-Bereinigung fehlgeschlagen')
      );
    }
  });

  worker.on('failed', (job, err) => {
    if (!job?.data) {
      log.error({ jobId: job?.id, err }, 'Zustellung fehlgeschlagen (kein Job-Data)');
      return;
    }
    const attemptsMax = job.opts.attempts ?? 10;
    // v3.18.10: 5xx errors are PERMANENT — mark as final immediately even
    // if attempts remain (otherwise the worker retries a
    // 550 User unknown 10× → IP reputation suffers, recipient MX gets annoyed).
    const { code: smtpCode, isPermanent: isPermanent5xx } = extractSmtpCode(err);
    const attemptsExhausted = job.attemptsMade >= attemptsMax;
    const isPermanent = isPermanent5xx || attemptsExhausted;

    log.error(
      { jobId: job.id, err, smtpCode, isPermanent, isPermanent5xx, attemptsExhausted, attempt: job.attemptsMade },
      isPermanent ? 'Zustellung permanent gescheitert' : 'Zustellung temporär gescheitert (wird retried)',
    );

    // On immediate 5xx stop: do not retry the job further (BullMQ.discard is sync)
    if (isPermanent5xx && !attemptsExhausted) {
      try { job.discard(); } catch { /* ignore */ }
    }

    // Clean up MinIO attachments only on permanent failure (retries need them)
    if (isPermanent && job.data.message?.attachments.length) {
      void cleanupMinioAttachments(job.data.message).catch(
        (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO-Bereinigung fehlgeschlagen')
      );
    }

    // DSN bounce to MAIL FROM on permanent failure
    if (isPermanent) {
      void (async () => {
        try {
          const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
          await sendDsnBounce({
            originalFrom:     job.data.from,
            originalTo:       job.data.to,
            originalSubject:  job.data.message?.subject ?? '',
            originalMessageId: job.data.message?.messageId ?? null,
            failureReason:    (err as Error).message,
            smtpCode,
            serverHostname:   settings?.publicHostname ?? 'mail.local',
          });
        } catch (dsnErr) {
          log.error({ err: dsnErr, jobId: job.id }, 'DSN-Generierung fehlgeschlagen');
        }
      })();
    }

    void prisma.systemLog.create({
      data: {
        level:    isPermanent ? 'ERROR' : 'WARN',
        service:  'smtp-server',
        category: 'MAIL_FLOW',
        message:  `${isPermanent ? 'Failed' : 'Deferred'}: ${job.data.from} → ${job.data.to.join(', ')}${smtpCode ? ` [${smtpCode}]` : ''}`,
        messageId: job.data.messageId,
        ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
        metadata: {
          sender:    job.data.from,
          recipient: job.data.to.join(', '),
          subject:   job.data.message?.subject ?? '',
          status:    isPermanent ? 'REJECTED' : 'DEFERRED',
          messageId: job.data.messageId,
          reason:    (err as Error).message,
          smtpCode:  smtpCode !== null ? String(smtpCode) : '',
          attempt:   String(job.attemptsMade),
          direction: 'OUTBOUND',
        },
      },
    }).catch(() => {});
  });

  return worker;
}
