import { Queue, Worker, type Job } from 'bullmq';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { relayMessage } from './relay.js';
import { signMessageForUser, encryptMessageForRecipient } from '../smime/index.js';
import { journalMessage } from '../journaling/engine.js';

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

      await relayMessage(buffer, from, to, {
        ...(dkimDomain ? { dkimDomain } : {}),
        ...(dkimSelector ? { dkimSelector } : {}),
        ...(dkimPrivateKey ? { dkimPrivateKey } : {}),
      });

      // ── Phase 9: Journaling (outbound) ────────────────────────────────────
      await journalMessage({ rawMessage: buffer, from, to, direction: 'OUTBOUND' });

      log.info({ jobId: job.id, to }, 'Message delivered');
    },
    {
      connection: createBullMqConnection(), // BullMQ Worker braucht maxRetriesPerRequest: null
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Delivery failed');
  });

  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Delivery completed');
  });

  return worker;
}
