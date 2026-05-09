import { Queue, Worker, type Job } from 'bullmq';
import { getRedisClient, createLogger } from '@coremail/core';
import { relayMessage } from './relay.js';

const log = createLogger('smtp:outbound-queue');

export interface OutboundJob {
  messageId: string;
  from: string;
  to: string[];
  rawMessage: string;  // base64-encoded
  dkimDomain?: string;
  dkimSelector?: string;
  dkimPrivateKey?: string;
}

const QUEUE_NAME = 'smtp:outbound';

let _queue: Queue<OutboundJob> | null = null;

export function getOutboundQueue(): Queue<OutboundJob> {
  if (!_queue) {
    _queue = new Queue<OutboundJob>(QUEUE_NAME, {
      connection: getRedisClient(),
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
      const { from, to, rawMessage, dkimDomain, dkimSelector, dkimPrivateKey } = job.data;
      const buffer = Buffer.from(rawMessage, 'base64');

      log.info({ jobId: job.id, from, to, attempt: job.attemptsMade + 1 }, 'Delivering message');

      await relayMessage(buffer, from, to, {
        dkimDomain,
        dkimSelector,
        dkimPrivateKey,
      });

      log.info({ jobId: job.id, to }, 'Message delivered');
    },
    {
      connection: getRedisClient(),
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
