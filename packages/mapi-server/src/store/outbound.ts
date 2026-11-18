/**
 * Outbound submission: the BullMQ queue `smtp-outbound` consumed by the
 * smtp-server worker (local recipients delivered into their mailbox, external
 * ones relayed and DKIM-signed by the envelope-from domain). Same job shape as
 * SMTP submission, JMAP and ActiveSync: the raw message in base64.
 */
import { Queue } from 'bullmq';
import { createBullMqConnection } from '@coremail/core';
import { buildOutboundJobOptions, loadQueueSettings } from '@coremail/storage/queue-options';

export const OUTBOUND_QUEUE_NAME = 'smtp-outbound';

export interface RawOutboundJob {
  messageId: string;
  from: string;
  to: string[];
  senderUserId: string;
  rawMessage: string;
}

let queue: Queue | null = null;

/** Enqueues a raw message; throws when Redis is unreachable. */
export async function enqueueRawOutbound(job: RawOutboundJob): Promise<void> {
  queue ??= new Queue(OUTBOUND_QUEUE_NAME, { connection: createBullMqConnection() });
  const settings = await loadQueueSettings();
  await queue.add('send', job, { ...buildOutboundJobOptions(settings), jobId: job.messageId });
}
