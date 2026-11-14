/**
 * EWS CreateItem (SendOnly / SendAndSaveCopy) → smtp-server outbound worker.
 *
 * Uses the BullMQ queue `smtp-outbound` with the structured-message job shape
 * of the api-gateway (`OutboundJob.message`, see smtp-server/src/outbound/queue.ts):
 * the worker builds the RFC 5322 message with nodemailer, delivers local
 * recipients into their mailbox, relays external ones and DKIM-signs with
 * the key of the envelope-from domain.
 *
 * Before v5.9.x EWS LPUSHed to the Redis list `smtp:outbound:ews`, which
 * nothing consumed — the mail was reported as sent but never delivered.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createBullMqConnection } from '@coremail/core';
import { prisma } from '@coremail/storage';

export const OUTBOUND_QUEUE_NAME = 'smtp-outbound';

export interface EwsStructuredMessage {
  from: string; fromName: string;
  to: string[]; cc: string[]; bcc: string[];
  subject: string; html: string; text: string;
  messageId: string; date: string;
  attachments: [];
}

export interface EwsOutboundJob {
  messageId:    string;    // tracking ID
  from:         string;    // envelope MAIL FROM = authenticated user
  to:           string[];  // To + Cc + Bcc
  senderUserId: string;
  message:      EwsStructuredMessage;
}

export interface EwsSendInput {
  userId:   string;
  email:    string;        // authenticated user — the client cannot override From
  subject:  string;
  bodyText: string;
  bodyHtml: string;
  to: string[]; cc: string[]; bcc: string[];
  now?: Date;
}

/** Pure: build the outbound job; null when there is no recipient. */
export function buildEwsOutboundJob(input: EwsSendInput): EwsOutboundJob | null {
  const norm = (l: string[]): string[] => [...new Set(l.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const to = norm(input.to), cc = norm(input.cc), bcc = norm(input.bcc);
  const envelopeTo = [...new Set([...to, ...cc, ...bcc])];
  if (envelopeTo.length === 0) return null;
  const from = input.email.trim().toLowerCase();
  const domain = from.split('@')[1] ?? 'localhost';
  return {
    messageId:    `ews-${randomUUID()}`,
    from,
    to:           envelopeTo,
    senderUserId: input.userId,
    message: {
      from, fromName: '',
      to, cc, bcc,
      subject: input.subject,
      html:    input.bodyHtml,
      text:    input.bodyText,
      messageId: `<${randomUUID()}@${domain}>`,
      date:    (input.now ?? new Date()).toISOString(),
      attachments: [],
    },
  };
}

/** Pure: EWS `Body` element → text/html parts by its BodyType (default HTML). */
export function splitEwsBody(bodyRaw: unknown): { bodyText: string; bodyHtml: string } {
  if (typeof bodyRaw === 'string') return { bodyText: '', bodyHtml: bodyRaw };
  if (!bodyRaw || typeof bodyRaw !== 'object') return { bodyText: '', bodyHtml: '' };
  const b = bodyRaw as { _?: unknown; $?: { BodyType?: unknown } };
  const content = typeof b._ === 'string' ? b._ : '';
  const type = typeof b.$?.BodyType === 'string' ? b.$.BodyType : 'HTML';
  return type === 'Text' ? { bodyText: content, bodyHtml: '' } : { bodyText: '', bodyHtml: content };
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

/** Enqueue with the retry policy of smtp-server `enqueueOutbound`. Throws on Redis errors. */
export async function enqueueEwsOutbound(job: EwsOutboundJob): Promise<void> {
  let attempts = 10;
  let delay = 60_000;
  try {
    const s = await prisma.queueSettings.findUnique({ where: { id: 'singleton' } });
    if (s) { attempts = s.maxRetryAttempts; delay = s.retryBackoffDelaySec * 1000; }
  } catch { /* DB unreachable — defaults */ }
  await outboundQueue().add('send', job, {
    jobId: job.messageId,
    attempts,
    backoff: { type: 'exponential', delay },
  });
}
