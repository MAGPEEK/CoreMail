import { randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import {
  listAllowedSenderAddresses, createMessage, setFlags, loadRawMessage, parseRawMessage, storeRawMessage,
  truncateBodyColumn, uploadBuffer, attachmentKey, type RawSourceMessage,
} from '@coremail/storage';
import { createLogger, getRedisClient } from '@coremail/core';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { enqueueRawOutbound, type RawOutboundJob } from '../outbound.js';
import { EAS_SEND_STATUS, planEasSubmission, appendOriginalMessage, type EasSubmissionPlan } from './send-mail-plan.js';

const log = createLogger('activesync:send-mail');

type ComposeCommand = 'SendMail' | 'SmartReply' | 'SmartForward';

/** How long a SendMail ClientId is remembered ([MS-ASCMD] ClientId — retry detection). */
const CLIENT_ID_TTL_SEC = 3 * 24 * 3600;

/** Source message of SmartReply / SmartForward (own mailbox only). */
export interface SourceMessage { id: string; folderId: string; flags: string[]; mailboxId: string; subject: string; raw: Buffer }

export interface SendMailDeps {
  enqueue: (job: RawOutboundJob) => Promise<unknown>;
  /** true = first use of this ClientId (claimed), false = already sent. */
  claimClientId: (userId: string, clientId: string) => Promise<boolean>;
  releaseClientId: (userId: string, clientId: string) => Promise<void>;
  saveSentCopy: (userId: string, plan: EasSubmissionPlan) => Promise<void>;
  loadSource: (userId: string, ref: { itemId: string; folderId?: string }) => Promise<SourceMessage | null>;
  markSource: (source: SourceMessage, flag: string) => Promise<void>;
}

const clientIdKey = (userId: string, clientId: string) => `eas:clientid:${userId}:${clientId}`;

export const defaultSendMailDeps: SendMailDeps = {
  enqueue: enqueueRawOutbound,
  claimClientId: async (userId, clientId) => {
    try {
      return (await getRedisClient().set(clientIdKey(userId, clientId), '1', 'EX', CLIENT_ID_TTL_SEC, 'NX')) === 'OK';
    } catch (err) {
      log.warn({ err }, 'ClientId check unavailable (Redis) — sending without duplicate detection');
      return true;
    }
  },
  releaseClientId: async (userId, clientId) => {
    await getRedisClient().del(clientIdKey(userId, clientId)).catch(() => undefined);
  },
  saveSentCopy,
  loadSource: async (userId, ref) => {
    const msg = await prisma.message.findFirst({
      where: { id: ref.itemId, deletedAt: null, folder: { mailbox: { userId } }, ...(ref.folderId ? { folderId: ref.folderId } : {}) },
      include: { folder: { select: { mailboxId: true } } },
    });
    if (!msg) return null;
    const raw = await loadRawMessage(msg as unknown as RawSourceMessage);
    return { id: msg.id, folderId: msg.folderId, flags: msg.flags, mailboxId: msg.folder.mailboxId, subject: msg.subject, raw };
  },
  markSource: async (source, flag) => {
    if (source.flags.includes(flag)) return;
    await prisma.$transaction((tx) => setFlags(tx, [{ id: source.id, flags: [...source.flags, flag] }], { mailboxId: source.mailboxId }));
  },
};

function statusResponse(command: string, status: string): Buffer {
  return encodeWbxml(el(command, undefined, [el('Status', status)]));
}

/**
 * SendMail / SmartReply / SmartForward ([MS-ASCMD] ComposeMail).
 *
 * The MIME (`composemail:Mime`, opaque octets — taken byte-exact, never re-encoded) is
 * handed to the smtp-server outbound worker via the BullMQ queue `smtp-outbound` (local
 * recipients are delivered into their mailbox, external ones relayed and DKIM-signed).
 * The From header must be an address the authenticated user may send as; the envelope
 * sender is that verified address.
 *
 * SmartReply / SmartForward: the Source item (FolderId+ItemId or LongId, own mailbox) is
 * appended to the client's message as an embedded `message/rfc822` part (inline for a
 * reply, as attachment for a forward — body and attachments of the original travel with
 * it) unless `ReplaceMime` is present; the source gets `\Answered` / `$Forwarded`.
 * An unknown source → Status 150.
 *
 * `ClientId` is remembered per user: a retried request with the same ClientId (e.g. after
 * a timeout) is answered with Status 118 instead of sending the mail twice.
 */
export async function handleSendMail(
  body: WbxmlElement,
  userId: string,
  command: ComposeCommand = 'SendMail',
  deps: SendMailDeps = defaultSendMailDeps,
): Promise<Buffer> {
  const mime = getChild(body, 'Mime')?.bytes;
  const saveInSent = getText(body, 'SaveInSentItems') !== '0';
  const clientId = getText(body, 'ClientId');

  if (!mime || mime.length === 0) {
    return statusResponse(command, EAS_SEND_STATUS.SUBMISSION_FAILED);
  }

  let claimed = false;
  try {
    const user = await prisma.user.findFirst({
      where:  { id: userId, active: true },
      select: { email: true },
    });
    if (!user) return statusResponse(command, EAS_SEND_STATUS.ACCESS_DENIED);

    // SmartReply / SmartForward: the original message.
    let raw: Buffer = Buffer.from(mime);
    let source: SourceMessage | null = null;
    if (command !== 'SendMail') {
      const src = getChild(body, 'Source');
      const itemId = src ? (getText(src, 'ItemId') || getText(src, 'LongId')) : '';
      if (itemId) {
        const folderId = src && !getText(src, 'LongId') ? getText(src, 'FolderId') : '';
        source = await deps.loadSource(userId, { itemId, ...(folderId ? { folderId } : {}) });
        if (!source) return statusResponse(command, EAS_SEND_STATUS.ITEM_NOT_FOUND);
        if (!getChild(body, 'ReplaceMime')) {
          raw = appendOriginalMessage(raw, source.raw, command === 'SmartForward' ? 'forward' : 'reply', source.subject);
        }
      }
    }

    const result = await planEasSubmission(raw, {
      userEmail:      user.email,
      allowedSenders: await listAllowedSenderAddresses(userId),
    });
    if (!result.ok) {
      log.warn({ userId, command, status: result.status, reason: result.reason }, 'EAS send rejected');
      return statusResponse(command, result.status);
    }
    const plan = result.plan;

    if (clientId) {
      claimed = await deps.claimClientId(userId, clientId);
      if (!claimed) {
        log.info({ userId, command, clientId }, 'EAS send retried with a used ClientId — not sent again');
        return statusResponse(command, EAS_SEND_STATUS.MESSAGE_PREVIOUSLY_SENT);
      }
    }

    // Enqueue first: only a queued mail is reported as sent.
    const jobId = `eas-${randomUUID()}`;
    await deps.enqueue({
      messageId:    jobId,
      from:         plan.envelopeFrom,
      to:           plan.recipients,
      senderUserId: userId,
      rawMessage:   plan.raw.toString('base64'),
    });
    claimed = false; // sent: the ClientId stays claimed
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

    if (source) {
      await deps.markSource(source, command === 'SmartReply' ? '\\Answered' : '$Forwarded').catch((err: unknown) =>
        log.warn({ err, userId }, 'Flagging the source message failed'));
    }

    // Sent copy — the mail is already queued, so a failure here must not make
    // the client resend (duplicate delivery); log it instead.
    if (saveInSent) {
      await deps.saveSentCopy(userId, plan).catch((err: unknown) =>
        log.error({ err, userId, jobId }, 'Saving EAS Sent copy failed (mail was sent)'),
      );
    }

    return statusResponse(command, EAS_SEND_STATUS.SUCCESS);
  } catch (err) {
    log.error({ err, userId, command }, 'EAS send failed');
    if (claimed && clientId) await deps.releaseClientId(userId, clientId).catch(() => undefined);
    return statusResponse(command, EAS_SEND_STATUS.SERVER_ERROR);
  }
}

/**
 * Sent copy through the normal raw-storage path (like the REST and JMAP senders): the
 * original octets are stored, the row is parsed from them and the attachments are stored
 * as attachment rows — IMAP/POP3/JMAP and the web client see the full message.
 */
export async function saveSentCopy(userId: string, plan: EasSubmissionPlan): Promise<void> {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  if (!mailbox) return;
  const sentFolder = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: 'Sent' },
  });
  if (!sentFolder) return;
  const parsed = await parseRawMessage(plan.raw);
  const { storagePath } = await storeRawMessage(plan.raw);
  // UID + modSeq are allocated atomically by the message store.
  const msg = await prisma.$transaction((tx) => createMessage(tx, mailbox.id, sentFolder.id, {
    flags: ['\\Seen'],
    subject: parsed.subject,
    fromAddr: parsed.fromAddr,
    fromName: parsed.fromName,
    toAddrs: parsed.toAddrs,
    ccAddrs: parsed.ccAddrs,
    bccAddrs: plan.bcc,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    date: parsed.date,
    bodyText: truncateBodyColumn(parsed.bodyText),
    bodyHtml: truncateBodyColumn(parsed.bodyHtml),
    rawSize: plan.raw.length,
    storagePath,
  }));
  for (const [index, att] of parsed.attachments.entries()) {
    const key = attachmentKey(msg.id, `${index}-${att.sha256.slice(0, 16)}`);
    await uploadBuffer(key, att.buffer, att.mimeType);
    await prisma.attachment.create({
      data: {
        messageId: msg.id, contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
        size: att.size, sha256: att.sha256, storagePath: key, inline: att.inline,
      },
    });
  }
  await prisma.folder.update({
    where: { id: sentFolder.id },
    data: { totalCount: { increment: 1 } },
  });
}

/** SmartReply / SmartForward — same submission path with the Source message appended. */
export async function handleSmartReply(
  body: WbxmlElement,
  userId: string,
  command: 'SmartReply' | 'SmartForward',
  deps: SendMailDeps = defaultSendMailDeps,
): Promise<Buffer> {
  return handleSendMail(body, userId, command, deps);
}
