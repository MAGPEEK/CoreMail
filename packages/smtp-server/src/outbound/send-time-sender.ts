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

/**
 * Pure: recipients of the job not yet handled — neither delivered nor bounced
 * on an earlier attempt nor named in a final NDR (an admin "Retry" keeps that
 * progress). Only these are refused and named in the NDR.
 */
export function openRecipients(job: Pick<OutboundJob, 'to' | 'deliveredRcpts' | 'bouncedRcpts' | 'finalNdrRcpts'>): string[] {
  const done = new Set([...(job.deliveredRcpts ?? []), ...(job.bouncedRcpts ?? []), ...(job.finalNdrRcpts ?? [])]);
  return job.to.filter((rcpt) => !done.has(rcpt));
}

/** Pure: the NDR to the sending user for the refused recipients `rcpts`. */
export function senderRevokedDsn(
  job: OutboundJob, buffer: Buffer, userEmail: string, reason: string, hostname: string, rcpts: readonly string[] = job.to,
): DsnOptions {
  const original = rawSubjectAndId(buffer);
  return {
    originalFrom:      userEmail,
    originalTo:        [...rcpts],
    originalSubject:   job.message?.subject ?? original.subject,
    originalMessageId: job.message?.messageId ?? original.messageId,
    failureReason:     reason,
    smtpCode:          550,
    serverHostname:    hostname,
    recipients:        rcpts.map((rcpt) => ({ rcpt, status: '5.7.1', diagnostic: reason })),
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
 * otherwise notifies the user about the still open recipients (not those
 * delivered on an earlier attempt), records them as bounced (neither the
 * failed handler nor a later admin "Retry" sends a second NDR) and returns
 * the error the worker throws.
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
  if (job.id) await deps.cancelScheduled(job.id);
  const refused = openRecipients(job.data);
  if (refused.length === 0) return new UnrecoverableError(reason);   // everyone was handled before: no NDR
  const data: OutboundJob = { ...job.data, bouncedRcpts: [...new Set([...(job.data.bouncedRcpts ?? []), ...refused])] };
  await job.updateData(data);
  job.data = data;
  const userEmail = await deps.userEmail(userId);
  if (userEmail) await deps.bounce(senderRevokedDsn(job.data, buffer, userEmail, reason, await deps.hostname(), refused));
  return new UnrecoverableError(reason);
}
