/**
 * 9.4 review: sender rights of a held message are checked again when it is sent.
 *
 * A scheduled send, an undo-send hold or a JMAP FUTURERELEASE waits in the
 * outbound queue as a delayed BullMQ job. Its send-as / send-on-behalf rights
 * (and the account itself) were checked when it was queued — when they are
 * revoked in the meantime, the worker must not send it. The sending user gets
 * an NDR (5.7.1) in their own mailbox — not the Shared Mailbox that may be the
 * envelope sender — and the job fails without a second NDR.
 */
import { UnrecoverableError } from 'bullmq';
import { prisma, checkSubmissionSenderIdentity, type HeaderSenderVerdict } from '@coremail/storage';
import type { DsnOptions } from './dsn.js';
import { rawSubjectAndId } from './dsn.js';
import type { OutboundJob } from './queue.js';

export const SENDER_REVOKED_PREFIX = 'Sender permission revoked';

/** Pure: the one-line diagnostic of a refused held message. */
export function senderRevokedReason(verdict: HeaderSenderVerdict): string {
  return `${SENDER_REVOKED_PREFIX}: ${(verdict.reason ?? 'not allowed').replace(/[\r\n]+/g, ' ')}`;
}

/** Pure: the NDR to the sending user for every recipient of the refused job. */
export function senderRevokedDsn(job: OutboundJob, buffer: Buffer, userEmail: string, reason: string, hostname: string): DsnOptions {
  const original = rawSubjectAndId(buffer);
  return {
    originalFrom:      userEmail,
    originalTo:        [...job.to],
    originalSubject:   job.message?.subject ?? original.subject,
    originalMessageId: job.message?.messageId ?? original.messageId,
    failureReason:     reason,
    smtpCode:          550,
    serverHostname:    hostname,
    recipients:        job.to.map((rcpt) => ({ rcpt, status: '5.7.1', diagnostic: reason })),
    originalRaw:       buffer,
  };
}

export interface SendTimeSenderDeps {
  check(raw: Buffer, envelopeFrom: string, userId: string): Promise<HeaderSenderVerdict>;
  userEmail(userId: string): Promise<string | null>;
  bounce(opts: DsnOptions): Promise<void>;
  hostname(): Promise<string>;
  /** Marks the scheduled Sent copy of the job as not sent (banner in the webmail). */
  cancelScheduled(jobId: string): Promise<void>;
}

export const defaultSendTimeSenderDeps: Pick<SendTimeSenderDeps, 'check' | 'userEmail' | 'cancelScheduled'> = {
  check: checkSubmissionSenderIdentity,
  userEmail: async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null,
  cancelScheduled: async (jobId) => {
    await prisma.message.updateMany({ where: { scheduledJobId: jobId, scheduledStatus: 'PENDING' }, data: { scheduledStatus: 'CANCELLED' } });
  },
};

/**
 * Re-checks the sender of a held job. Returns null when it may be sent;
 * otherwise notifies the user, records every recipient as bounced (the failed
 * handler sends no second NDR) and returns the error the worker throws.
 */
export async function refuseRevokedSender(
  job: { id?: string | undefined; data: OutboundJob; updateData(data: OutboundJob): Promise<void> },
  buffer: Buffer,
  deps: SendTimeSenderDeps,
): Promise<UnrecoverableError | null> {
  const userId = job.data.senderUserId;
  if (!userId) return null;
  const verdict = await deps.check(buffer, job.data.from, userId);
  if (verdict.ok) return null;

  const reason = senderRevokedReason(verdict);
  const data: OutboundJob = { ...job.data, bouncedRcpts: [...new Set([...(job.data.bouncedRcpts ?? []), ...job.data.to])] };
  await job.updateData(data);
  job.data = data;
  if (job.id) await deps.cancelScheduled(job.id);
  const userEmail = await deps.userEmail(userId);
  if (userEmail) await deps.bounce(senderRevokedDsn(job.data, buffer, userEmail, reason, await deps.hostname()));
  return new UnrecoverableError(reason);
}
