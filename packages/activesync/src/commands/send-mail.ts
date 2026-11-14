import { randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import { listAllowedSenderAddresses } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { encodeWbxml, el, getText, type WbxmlElement } from '../wbxml.js';
import { enqueueRawOutbound } from '../outbound.js';
import { EAS_SEND_STATUS, planEasSubmission, type EasSubmissionPlan } from './send-mail-plan.js';

const log = createLogger('activesync:send-mail');

function statusResponse(command: string, status: string): Buffer {
  return encodeWbxml(el(command, undefined, [el('Status', status)]));
}

/**
 * SendMail command — send outgoing email.
 *
 * The MIME is handed to the smtp-server outbound worker via the BullMQ queue
 * `smtp-outbound` (local recipients are delivered into their mailbox, external
 * ones relayed and DKIM-signed). The From header must be an address the
 * authenticated user may send as; the envelope sender is that verified address.
 */
export async function handleSendMail(
  body: WbxmlElement,
  userId: string,
  command: 'SendMail' | 'SmartReply' | 'SmartForward' = 'SendMail',
): Promise<Buffer> {
  const mimeData = getText(body, 'Mime');
  const saveInSent = getText(body, 'SaveInSentItems') !== '0';

  if (!mimeData) {
    return statusResponse(command, EAS_SEND_STATUS.SUBMISSION_FAILED);
  }

  try {
    const user = await prisma.user.findFirst({
      where:  { id: userId, active: true },
      select: { email: true },
    });
    if (!user) return statusResponse(command, EAS_SEND_STATUS.ACCESS_DENIED);

    const result = await planEasSubmission(Buffer.from(mimeData, 'utf8'), {
      userEmail:      user.email,
      allowedSenders: await listAllowedSenderAddresses(userId),
    });
    if (!result.ok) {
      log.warn({ userId, command, status: result.status, reason: result.reason }, 'EAS send rejected');
      return statusResponse(command, result.status);
    }
    const plan = result.plan;

    // Enqueue first: only a queued mail is reported as sent.
    const jobId = `eas-${randomUUID()}`;
    await enqueueRawOutbound({
      messageId:    jobId,
      from:         plan.envelopeFrom,
      to:           plan.recipients,
      senderUserId: userId,
      rawMessage:   plan.raw.toString('base64'),
    });
    log.info({ userId, command, jobId, from: plan.envelopeFrom, rcpt: plan.recipients.length }, 'EAS mail enqueued');

    void prisma.systemLog.create({
      data: {
        level: 'INFO', service: 'activesync', category: 'MAIL_FLOW',
        message: `Sent (EAS): ${plan.envelopeFrom} → ${plan.recipients.join(', ')}`,
        userId,
        metadata: {
          sender: plan.envelopeFrom, recipient: plan.recipients.join(', '), subject: plan.subject,
          status: 'ACCEPTED', messageId: jobId, direction: 'OUTBOUND', protocol: 'EAS',
        },
      },
    }).catch((err: unknown) => log.warn({ err }, 'MAIL_FLOW log write failed'));

    // Sent copy — the mail is already queued, so a failure here must not make
    // the client resend (duplicate delivery); log it instead.
    if (saveInSent) {
      await saveSentCopy(userId, plan, mimeData.length).catch((err: unknown) =>
        log.error({ err, userId, jobId }, 'Saving EAS Sent copy failed (mail was sent)'),
      );
    }

    return statusResponse(command, EAS_SEND_STATUS.SUCCESS);
  } catch (err) {
    log.error({ err, userId, command }, 'EAS send failed');
    return statusResponse(command, EAS_SEND_STATUS.SERVER_ERROR);
  }
}

async function saveSentCopy(userId: string, plan: EasSubmissionPlan, rawSize: number): Promise<void> {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  if (!mailbox) return;
  const sentFolder = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: 'Sent' },
  });
  if (!sentFolder) return;
  const updatedMailbox = await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: { uidNext: { increment: 1 } },
  });
  await prisma.message.create({
    data: {
      folderId: sentFolder.id,
      uid: updatedMailbox.uidNext - 1,
      modSeq: BigInt(Date.now()),
      flags: ['\\Seen'],
      subject: plan.subject,
      fromAddr: plan.envelopeFrom,
      toAddrs: plan.to,
      ccAddrs: plan.cc,
      bccAddrs: plan.bcc,
      date: new Date(),
      bodyText: plan.text,
      bodyHtml: plan.html,
      rawSize,
      storagePath: '',
    },
  });
  await prisma.folder.update({
    where: { id: sentFolder.id },
    data: { totalCount: { increment: 1 } },
  });
}

/**
 * SmartReply / SmartForward — reply/forward with original message included
 */
export async function handleSmartReply(
  body: WbxmlElement,
  userId: string,
  command: 'SmartReply' | 'SmartForward',
): Promise<Buffer> {
  // The client MIME carries the reply/forward content; same submission path.
  return handleSendMail(body, userId, command);
}
