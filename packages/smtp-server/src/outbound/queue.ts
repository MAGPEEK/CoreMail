import { Queue, Worker, type Job } from 'bullmq';
import { Readable } from 'stream';
import nodemailer from 'nodemailer';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { prisma, downloadBuffer, deleteObject } from '@coremail/storage';
import { relayMessage } from './relay.js';
import { signMessageForUser, encryptMessageForRecipient } from '../smime/index.js';
import { storeInboundMessage } from '../handlers/message.js';
import { expandRecipients } from '../handlers/expand.js';
// Journaling-Feature komplett entfernt in v3.13.6

const log = createLogger('smtp:outbound-queue');

// ── Message-Format ────────────────────────────────────────────────────────────
//
// Ab v3.17.30: api-gateway übergibt strukturierte Nachrichten (kein base64-Blob
// im Redis-Job mehr). Der Worker baut den RFC-5322-Buffer mit nodemailer auf.
// SMTP-Submission (Ports 465/587) nutzt weiterhin rawMessage (base64) — E-Mail-
// Clients liefern bereits vollständige RFC-5322-Nachrichten.

export interface StructuredAttachment {
  filename:    string;
  minioPath:   string;   // Schlüssel in MinIO (outbound-queue/{jobId}/{filename})
  contentType: string;
  size:        number;
}

export interface StructuredMessage {
  from:       string;    // Absender-E-Mail-Adresse
  fromName:   string;    // Anzeigename (leer → kein Quoted-String)
  to:         string[];
  cc:         string[];
  bcc:        string[];  // nur SMTP-Envelope, NICHT im Header
  subject:    string;
  html:       string;
  text:       string;
  messageId:  string;    // <uuid@domain>
  date:       string;    // ISO-String
  inReplyTo?:  string;
  references?: string;
  attachments: StructuredAttachment[];
}

export interface OutboundJob {
  messageId:      string;    // Tracking-ID (nicht die E-Mail-Message-ID)
  from:           string;    // SMTP-Envelope MAIL FROM
  to:             string[];  // SMTP-Envelope RCPT TO (alle: To + CC + BCC)
  senderUserId?:  string;    // für S/MIME Auto-Sign
  dkimDomain?:    string;
  dkimSelector?:  string;
  dkimPrivateKey?: string;
  // Genau eines der folgenden Felder muss gesetzt sein:
  message?:    StructuredMessage;  // Web-Client-Pfad (v3.17.30+)
  rawMessage?: string;             // base64, SMTP-Submission-Pfad (Clients)
}

// ── RFC-5322-Buffer aus strukturierter Nachricht aufbauen ─────────────────────

async function buildRawFromMessage(msg: StructuredMessage): Promise<Buffer> {
  // Anhänge aus MinIO laden (parallel)
  const attachments: nodemailer.SendMailOptions['attachments'] = await Promise.all(
    msg.attachments.map(async (att) => ({
      filename:    att.filename,
      content:     await downloadBuffer(att.minioPath),
      contentType: att.contentType,
    }))
  );

  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: 'crlf',   // RFC 5321: SMTP erfordert CRLF-Zeilenenden
  });

  const fromField: nodemailer.SendMailOptions['from'] = msg.fromName
    ? { name: msg.fromName, address: msg.from }
    : msg.from;

  const info = await transport.sendMail({
    messageId: msg.messageId,
    from:      fromField,
    to:        msg.to,
    subject:   msg.subject,
    date:      new Date(msg.date),
    ...(msg.cc.length         ? { cc: msg.cc }                                : {}),
    // BCC: NIE in den Message-Headern — nur im SMTP-Envelope (job.to)
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

/** MinIO-Anhänge eines Queue-Jobs nach erfolgreicher Zustellung bereinigen. */
async function cleanupMinioAttachments(msg: StructuredMessage): Promise<void> {
  await Promise.allSettled(
    msg.attachments.map((att) => deleteObject(att.minioPath))
  );
}

// ── BullMQ-Queue ──────────────────────────────────────────────────────────────

const QUEUE_NAME = 'smtp-outbound'; // BullMQ v5: kein ':' im Queue-Namen erlaubt

let _queue: Queue<OutboundJob> | null = null;

export function getOutboundQueue(): Queue<OutboundJob> {
  if (!_queue) {
    _queue = new Queue<OutboundJob>(QUEUE_NAME, {
      connection: createBullMqConnection(),
      defaultJobOptions: {
        attempts: 10,
        backoff: {
          type: 'exponential',
          delay: 60_000, // 1 min Initial-Delay, verdoppelt sich bei jedem Retry
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
  const result = await queue.add('send', job, {
    jobId: `${job.messageId}-${Date.now()}`,
  });
  log.info({ jobId: result.id, to: job.to }, 'Nachricht in Ausgangs-Queue eingereiht');
  return result.id ?? '';
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_NAME,
    async (job: Job<OutboundJob>) => {
      const { from, to, senderUserId, dkimDomain, dkimSelector, dkimPrivateKey } = job.data;

      log.info({ jobId: job.id, from, to, attempt: job.attemptsMade + 1 }, 'Zustellung gestartet');

      // ── Schedule-Send: Cancellation-Check ────────────────────────────────
      // Wenn der User die geplante Mail im MWA über „Planung abbrechen"
      // storniert hat, wurde der Job zwar entfernt (BullMQ.remove()), aber
      // wenn er bereits gestartet ist, muss der Worker selbst prüfen ob
      // die Message inzwischen auf CANCELLED gesetzt wurde.
      if (job.id) {
        const scheduled = await prisma.message.findFirst({
          where: { scheduledJobId: job.id },
          select: { id: true, scheduledStatus: true },
        });
        if (scheduled && scheduled.scheduledStatus === 'CANCELLED') {
          log.info({ jobId: job.id, msgId: scheduled.id }, 'Geplanter Versand abgebrochen — Worker stoppt');
          return; // Job als erfolgreich markieren ohne zu senden
        }
      }

      // ── RFC-5322-Buffer aufbauen ──────────────────────────────────────────
      // Entweder aus strukturierter Nachricht (Web-Client-Pfad, v3.17.30+)
      // oder aus base64-Rohdaten (SMTP-Submission-Pfad, Clients).
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

      // ── Lokale vs. externe Empfänger trennen ──────────────────────────────
      const localRcpts:    string[] = [];
      const externalRcpts: string[] = [];

      for (const rcpt of to) {
        const domain = rcpt.split('@')[1]?.toLowerCase();
        if (!domain) { externalRcpts.push(rcpt); continue; }
        const localDomain = await prisma.domain.findFirst({
          where: { name: domain, active: true },
        });
        if (localDomain) {
          localRcpts.push(rcpt);
        } else {
          externalRcpts.push(rcpt);
        }
      }

      // Lokale Empfänger auflösen (Aliase + Verteilergruppen + Shared-Mailbox-Aliase)
      const expandedLocalRcpts = localRcpts.length > 0
        ? await expandRecipients(localRcpts)
        : [];

      // ── Lokale Zustellung (direkt ins Postfach schreiben) ─────────────────
      for (const rcpt of expandedLocalRcpts) {
        await storeInboundMessage(buffer, {
          fromAddr: from,
          rcptTo:   rcpt,
          toJunk:   false,
        });
        log.info({ rcpt, jobId: job.id }, 'Lokale Zustellung (outbound → Postfach)');
      }

      // ── Externe Zustellung via MX / Smarthost ─────────────────────────────
      if (externalRcpts.length > 0) {
        await relayMessage(buffer, from, externalRcpts, {
          ...(dkimDomain    ? { dkimDomain }    : {}),
          ...(dkimSelector  ? { dkimSelector }  : {}),
          ...(dkimPrivateKey ? { dkimPrivateKey } : {}),
        });
      }

      // ── MAIL_FLOW-Log ─────────────────────────────────────────────────────
      const allDelivered = [...localRcpts, ...externalRcpts];
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
            localRcpts:    localRcpts.join(', '),
            externalRcpts: externalRcpts.join(', '),
            direction:     'OUTBOUND',
          },
        },
      }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW-Log fehlgeschlagen'));

      log.info({ jobId: job.id, to }, 'Nachricht zugestellt');

      // Schedule-Send: Status auf SENT setzen damit der Banner in MWA verschwindet
      if (job.id) {
        await prisma.message.updateMany({
          where: { scheduledJobId: job.id, scheduledStatus: 'PENDING' },
          data:  { scheduledStatus: 'SENT' },
        }).catch((e: unknown) => log.warn({ err: e }, 'scheduledStatus=SENT Update fehlgeschlagen'));
      }
    },
    {
      connection: createBullMqConnection(), // maxRetriesPerRequest: null (BullMQ-Pflicht)
      concurrency: 10,
    },
  );

  // ── MinIO-Bereinigung nach Abschluss ──────────────────────────────────────
  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Zustellung abgeschlossen');
    if (job.data.message?.attachments.length) {
      void cleanupMinioAttachments(job.data.message).catch(
        (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO-Bereinigung fehlgeschlagen')
      );
    }
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Zustellung fehlgeschlagen');
    if (job?.data) {
      const attemptsMax = job.opts.attempts ?? 10;
      const isPermanent = job.attemptsMade >= attemptsMax;

      // MinIO-Anhänge erst bei permanentem Fehler bereinigen (Retries brauchen sie)
      if (isPermanent && job.data.message?.attachments.length) {
        void cleanupMinioAttachments(job.data.message).catch(
          (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO-Bereinigung fehlgeschlagen')
        );
      }

      void prisma.systemLog.create({
        data: {
          level:    isPermanent ? 'ERROR' : 'WARN',
          service:  'smtp-server',
          category: 'MAIL_FLOW',
          message:  `${isPermanent ? 'Failed' : 'Deferred'}: ${job.data.from} → ${job.data.to.join(', ')}`,
          messageId: job.data.messageId,
          ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
          metadata: {
            sender:    job.data.from,
            recipient: job.data.to.join(', '),
            subject:   job.data.message?.subject ?? '',
            status:    isPermanent ? 'REJECTED' : 'DEFERRED',
            messageId: job.data.messageId,
            reason:    (err as Error).message,
            attempt:   String(job.attemptsMade),
            direction: 'OUTBOUND',
          },
        },
      }).catch(() => {});
    }
  });

  return worker;
}
