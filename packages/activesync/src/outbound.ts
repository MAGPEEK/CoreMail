/**
 * Outbound submission for ActiveSync (SendMail / SmartReply / SmartForward).
 *
 * Enqueues on the BullMQ queue `smtp-outbound` (hyphen — BullMQ v5 forbids
 * ':'), consumed by the smtp-server outbound worker. Same job shape as SMTP
 * submission / JMAP: `rawMessage` base64. The worker delivers local
 * recipients directly into their mailbox, relays external ones and resolves
 * the DKIM key from the envelope-from domain.
 *
 * Before v5.9.x mails were LPUSHed to the Redis list `smtp:outbound:eas`,
 * which nothing consumed — mail from phones was silently lost.
 */
import { Queue } from 'bullmq';
import { createBullMqConnection } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

export const OUTBOUND_QUEUE_NAME = 'smtp-outbound';

export interface RawOutboundJob {
  messageId:    string;   // tracking ID
  from:         string;   // envelope MAIL FROM
  to:           string[]; // envelope RCPT TO (To + Cc + Bcc)
  senderUserId: string;   // S/MIME auto-sign + MAIL_FLOW log
  rawMessage:   string;   // RFC 5322, base64
}

export interface OutboundJobOptions {
  jobId:    string;
  attempts: number;
  backoff:  { type: 'exponential'; delay: number };
}

/** Pure: retry options, mirroring smtp-server `enqueueOutbound` (QueueSettings or 10 × 60 s). */
export function outboundJobOptions(
  jobId: string,
  settings: { maxRetryAttempts: number; retryBackoffDelaySec: number } | null,
): OutboundJobOptions {
  return {
    jobId,
    attempts: settings?.maxRetryAttempts ?? 10,
    backoff:  { type: 'exponential', delay: (settings?.retryBackoffDelaySec ?? 60) * 1000 },
  };
}

let queue: Queue | null = null;
function outboundQueue(): Queue {
  if (!queue) {
    queue = new Queue(OUTBOUND_QUEUE_NAME, {
      connection: createBullMqConnection(),
      defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
    });
  }
  return queue;
}

/** Enqueue a raw message; throws when Redis is unreachable (caller reports an EAS error). */
export async function enqueueRawOutbound(job: RawOutboundJob): Promise<string> {
  let settings: { maxRetryAttempts: number; retryBackoffDelaySec: number } | null = null;
  try {
    settings = await prisma.queueSettings.findUnique({
      where:  { id: 'singleton' },
      select: { maxRetryAttempts: true, retryBackoffDelaySec: true },
    });
  } catch { /* DB unreachable — defaults */ }
  const added = await outboundQueue().add('send', job, outboundJobOptions(job.messageId, settings));
  return added.id ?? job.messageId;
}
