import { Queue, Worker, type Job } from 'bullmq';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { relayMessage } from './relay.js';
import { signMessageForUser, encryptMessageForRecipient } from '../smime/index.js';
import { storeInboundMessage } from '../handlers/message.js';
// Journaling-Feature komplett entfernt in v3.13.6

const log = createLogger('smtp:outbound-queue');

export interface OutboundJob {
  messageId: string;
  from: string;
  to: string[];
  rawMessage: string;  // base64-encoded
  senderUserId?: string; // for S/MIME auto-sign lookup
  dkimDomain?: string;
  dkimSelector?: string;
  dkimPrivateKey?: string;
}

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
          delay: 60_000, // 1 minute initial delay, doubles each retry
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
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
  log.info({ jobId: result.id, to: job.to }, 'Message enqueued for delivery');
  return result.id ?? '';
}

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_NAME,
    async (job: Job<OutboundJob>) => {
      const { from, to, rawMessage, senderUserId, dkimDomain, dkimSelector, dkimPrivateKey } = job.data;
      let buffer = Buffer.from(rawMessage, 'base64');

      log.info({ jobId: job.id, from, to, attempt: job.attemptsMade + 1 }, 'Delivering message');

      // ── Phase 9: S/MIME auto-sign ─────────────────────────────────────────
      if (senderUserId) {
        const settings = await prisma.smimeSettings.findUnique({
          where: { userId: senderUserId },
        });
        if (settings?.autoSign) {
          // Buffer.from() coerces ArrayBufferLike → ArrayBuffer (TS strict mode)
          buffer = Buffer.from(await signMessageForUser(buffer, senderUserId));
        }
        // ── Phase 9: S/MIME auto-encrypt (opportunistic) ───────────────────
        if (settings?.autoEncrypt && to.length === 1) {
          // Single-recipient encryption only (multi-recipient requires per-cert wrapping)
          buffer = Buffer.from(await encryptMessageForRecipient(buffer, to[0]!));
        }
      }

      // ── Local-Domain-Check: Lokale Empfänger direkt zustellen, externe via MX ──
      const localRcpts: string[] = [];
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

      // Lokale Zustellung (Postfach direkt schreiben)
      for (const rcpt of localRcpts) {
        await storeInboundMessage(buffer, {
          fromAddr: from,
          rcptTo:   rcpt,
          toJunk:   false, // Ausgehende Mails werden nicht als Spam markiert
        });
        log.info({ rcpt, jobId: job.id }, 'Local delivery (outbound → mailbox)');
      }

      // Externe Zustellung via MX / Smarthost
      if (externalRcpts.length > 0) {
        await relayMessage(buffer, from, externalRcpts, {
          ...(dkimDomain ? { dkimDomain } : {}),
          ...(dkimSelector ? { dkimSelector } : {}),
          ...(dkimPrivateKey ? { dkimPrivateKey } : {}),
        });
      }

      // MAIL_FLOW — delivery confirmed (local + external)
      const allDelivered = [...localRcpts, ...externalRcpts];
      void prisma.systemLog.create({
        data: {
          level: 'INFO',
          service: 'smtp-server',
          category: 'MAIL_FLOW',
          message: `Delivered: ${from} → ${allDelivered.join(', ')}`,
          messageId: job.data.messageId,
          ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
          metadata: {
            sender:    from,
            recipient: allDelivered.join(', '),
            subject:   '',
            status:    'DELIVERED',
            messageId: job.data.messageId,
            size:      String(buffer.length),
            localRcpts: localRcpts.join(', '),
            externalRcpts: externalRcpts.join(', '),
            direction: 'OUTBOUND',
          },
        },
      }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW log failed'));

      log.info({ jobId: job.id, to }, 'Message delivered');
    },
    {
      connection: createBullMqConnection(), // BullMQ Worker braucht maxRetriesPerRequest: null
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Delivery failed');
    if (job?.data) {
      const attemptsMax = job.opts.attempts ?? 10;
      const isPermanent = job.attemptsMade >= attemptsMax;
      void prisma.systemLog.create({
        data: {
          level: isPermanent ? 'ERROR' : 'WARN',
          service: 'smtp-server',
          category: 'MAIL_FLOW',
          message: `${isPermanent ? 'Failed' : 'Deferred'}: ${job.data.from} → ${job.data.to.join(', ')}`,
          messageId: job.data.messageId,
          ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
          metadata: {
            sender: job.data.from,
            recipient: job.data.to.join(', '),
            subject: '',
            status: isPermanent ? 'REJECTED' : 'DEFERRED',
            messageId: job.data.messageId,
            reason: (err as Error).message,
            attempt: String(job.attemptsMade),
            direction: 'OUTBOUND',
          },
        },
      }).catch(() => {});
    }
  });

  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Delivery completed');
  });

  return worker;
}
