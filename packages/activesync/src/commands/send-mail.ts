import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import {
  listAllowedSenderAddresses, createMessage, setFlags, loadRawMessage, parseRawMessage, storeRawMessage,
  truncateBodyColumn, uploadBuffer, attachmentKey, checkSendQuota, maxOutgoingMessageBytes, deferMailboxChanges,
  checkUserSendLimits, afterForeignSend,
  type RawSourceMessage, type SendLimitVerdict,
} from '@coremail/storage';
import { createLogger, getRedisClient } from '@coremail/core';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { enqueueRawOutbound, type RawOutboundJob } from '../outbound.js';
import {
  EAS_SEND_STATUS, planEasSubmission, appendOriginalMessage, headerValue, type EasSubmissionPlan,
} from './send-mail-plan.js';
import type { EasCommandParams } from '../request.js';

const log = createLogger('activesync:send-mail');

export type ComposeCommand = 'SendMail' | 'SmartReply' | 'SmartForward';

/** How long a SendMail ClientId is remembered ([MS-ASCMD] ClientId — retry detection). */
const CLIENT_ID_TTL_SEC = 3 * 24 * 3600;
/**
 * 9.4: a request without ClientId (always for 12.1) is recognised as a retry by its
 * Message-ID header from the same device within this window — a device that timed out
 * resends the identical message right away.
 */
const MESSAGE_ID_TTL_SEC = 10 * 60;

/** Source message of SmartReply / SmartForward (own mailbox only). */
export interface SourceMessage { id: string; folderId: string; flags: string[]; mailboxId: string; subject: string; raw: Buffer }

export interface SendMailDeps {
  enqueue: (job: RawOutboundJob) => Promise<unknown>;
  /** true = first use of this idempotency key (claimed for ttlSec), false = already sent. */
  claimClientId: (userId: string, clientId: string, ttlSec: number) => Promise<boolean>;
  releaseClientId: (userId: string, clientId: string) => Promise<void>;
  saveSentCopy: (userId: string, plan: EasSubmissionPlan) => Promise<void>;
  loadSource: (userId: string, ref: { itemId: string; folderId?: string }) => Promise<SourceMessage | null>;
  markSource: (source: SourceMessage, flag: string) => Promise<void>;
  /** v8.1: false = the mailbox is at/over its ProhibitSendQuota. Default: storage checkSendQuota. */
  sendAllowed?: (userId: string) => Promise<boolean>;
  /** 9.4: maximum message size in octets. Default: storage maxOutgoingMessageBytes. */
  maxMessageBytes?: () => Promise<number>;
  /** 9.4: per-mailbox send limits of the user. Default: storage checkUserSendLimits. */
  sendLimits?: (userId: string, sizeBytes: number, recipients: number) => Promise<SendLimitVerdict>;
  /** 9.4: audit + Shared Mailbox Sent copy of a send as / on behalf. Default: storage afterForeignSend. */
  afterSend?: (userId: string, plan: EasSubmissionPlan) => Promise<unknown>;
}

const NO_GLOBAL_LIMIT = { maxBytes: Number.POSITIVE_INFINITY, maxRecipients: Number.POSITIVE_INFINITY };
const defaultSendLimits = (userId: string, size: number, rcpts: number): Promise<SendLimitVerdict> =>
  checkUserSendLimits(userId, NO_GLOBAL_LIMIT, size, rcpts);
const defaultAfterSend = (userId: string, plan: EasSubmissionPlan): Promise<unknown> =>
  afterForeignSend({ userId, raw: plan.raw, source: 'activesync' });

const clientIdKey = (userId: string, clientId: string) => `eas:clientid:${userId}:${clientId}`;

export const defaultSendMailDeps: SendMailDeps = {
  enqueue: enqueueRawOutbound,
  claimClientId: async (userId, clientId, ttlSec) => {
    try {
      return (await getRedisClient().set(clientIdKey(userId, clientId), '1', 'EX', ttlSec, 'NX')) === 'OK';
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

/**
 * 14.0+ response body: empty on success — [MS-ASCMD] 2.2.1.17 SendMail "If the message was
 * sent successfully, the server returns an empty response" (likewise SmartForward 2.2.1.19,
 * SmartReply 2.2.1.20) — otherwise `<Command><Status>` with the failure code.
 */
export function composeResponse(command: string, status: string): Buffer {
  if (status === EAS_SEND_STATUS.SUCCESS) return Buffer.alloc(0);
  return encodeWbxml(el(command, undefined, [el('Status', status)]));
}

/**
 * Idempotency key of a compose request: its ClientId ([MS-ASCMD] 2.2.3.28.1, 14.0+), else
 * (12.1 has no ClientId) the Message-ID header of the client's MIME together with the device.
 * null = no retry detection possible (no ClientId, no Message-ID or no device id).
 */
export function idempotencyKey(request: ComposeRequest): { id: string; ttlSec: number } | null {
  if (request.clientId) return { id: request.clientId, ttlSec: CLIENT_ID_TTL_SEC };
  const messageId = request.mime ? headerValue(request.mime, 'Message-ID') : null;
  if (!messageId || !request.deviceId) return null;
  const digest = createHash('sha256').update(`${request.deviceId}\n${messageId}`).digest('hex').slice(0, 32);
  return { id: `mid:${digest}`, ttlSec: MESSAGE_ID_TTL_SEC };
}

/** A SendMail / SmartReply / SmartForward request, independent of its encoding. */
export interface ComposeRequest {
  /** The client's RFC 5322 message, byte-exact. */
  mime: Buffer | undefined;
  saveInSent: boolean;
  /** ComposeMail ClientId ('' = none — always for 12.1). */
  clientId: string;
  /** Source item of SmartReply / SmartForward (folderId only with ItemId, not LongId). */
  source: { itemId: string; folderId?: string } | null;
  /** ComposeMail ReplaceMime (14.0+): the client's MIME already contains the original. */
  replaceMime: boolean;
  /** EAS DeviceId of the request ('' = unknown) — scope of the Message-ID retry detection. */
  deviceId: string;
}

function sourceRef(itemId: string, longId: string, folderId: string): ComposeRequest['source'] {
  const id = itemId || longId;
  if (!id) return null;
  return longId || !folderId ? { itemId: id } : { itemId: id, folderId };
}

/** 14.0+: the ComposeMail WBXML request (`composemail:Mime` as opaque octets). */
export function composeRequestFromWbxml(body: WbxmlElement, deviceId = ''): ComposeRequest {
  const src = getChild(body, 'Source');
  return {
    mime: getChild(body, 'Mime')?.bytes,
    saveInSent: getText(body, 'SaveInSentItems') !== '0',
    clientId: getText(body, 'ClientId'),
    source: src ? sourceRef(getText(src, 'ItemId'), getText(src, 'LongId'), getText(src, 'FolderId')) : null,
    replaceMime: !!getChild(body, 'ReplaceMime'),
    deviceId,
  };
}

/**
 * 12.1: the request body is the raw MIME message (`Content-Type: message/rfc822`), the
 * rest travels in the request line — `SaveInSent=T`, and for SmartReply / SmartForward
 * `ItemId` + `CollectionId` or `LongId` ([MS-ASCMD] SendMail/SmartReply/SmartForward,
 * [MS-ASHTTP] request parameters). There is no ClientId and no ReplaceMime.
 */
export function composeRequestFromMime(mime: Buffer, params: EasCommandParams, deviceId = ''): ComposeRequest {
  return {
    mime,
    saveInSent: params.saveInSent,
    clientId: '',
    source: sourceRef(params.itemId ?? '', params.longId ?? '', params.collectionId ?? ''),
    replaceMime: false,
    deviceId,
  };
}

/**
 * Pure (9.4): the SendMail / SmartReply / SmartForward status of a refused
 * per-mailbox send limit ([MS-ASCMD] 2.2.2 common status codes,
 * https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-ascmd/95cb9d7c-d33d-4b94-9366-d59911c7a060):
 * size → 122 AttachmentIsTooLarge (the only size status); recipient count → 120
 * MailSubmissionFailed (MS-ASCMD has no status for too many recipients — 116 is
 * an unresolvable recipient, 160 counts availability lookups only).
 */
export function sendLimitStatus(kind: 'size' | 'recipients'): string {
  return kind === 'size' ? EAS_SEND_STATUS.MESSAGE_TOO_LARGE : EAS_SEND_STATUS.SUBMISSION_FAILED;
}

/**
 * HTTP status of a 12.1 compose request — the response has no body ([MS-ASHTTP]): sent →
 * 200; a request that cannot succeed when repeated → 400 (malformed MIME, no recipient,
 * unknown source item) / 403 (sender address not allowed) / 413 (over the sender's size
 * limit) / 507 (send quota); a server failure → 500, so the device keeps the message and
 * retries.
 */
export function legacySendHttpStatus(status: string): number {
  switch (status) {
    case EAS_SEND_STATUS.SUCCESS:
    case EAS_SEND_STATUS.MESSAGE_PREVIOUSLY_SENT:
      return 200;
    case EAS_SEND_STATUS.INVALID_MIME:
    case EAS_SEND_STATUS.NO_RECIPIENTS:
    case EAS_SEND_STATUS.ITEM_NOT_FOUND:
      return 400;
    case EAS_SEND_STATUS.ACCESS_DENIED:
      return 403;
    case EAS_SEND_STATUS.MESSAGE_TOO_LARGE:
      return 413; // Request Entity Too Large — repeating the same message cannot succeed
    case EAS_SEND_STATUS.MAILBOX_QUOTA_EXCEEDED:
      return 507;
    default:
      return 500;
  }
}

/** 14.0+ SendMail / SmartReply / SmartForward: ComposeMail WBXML in, empty body or `<Command><Status>` out. */
export async function handleSendMail(
  body: WbxmlElement,
  userId: string,
  command: ComposeCommand = 'SendMail',
  deps: SendMailDeps = defaultSendMailDeps,
  deviceId = '',
): Promise<Buffer> {
  return composeResponse(command, await submitCompose(composeRequestFromWbxml(body, deviceId), userId, command, deps));
}

/** 12.1 SendMail / SmartReply / SmartForward: raw MIME + request-line parameters in, HTTP status out. */
export async function handleLegacySendMail(
  mime: Buffer,
  params: EasCommandParams,
  userId: string,
  command: ComposeCommand,
  deps: SendMailDeps = defaultSendMailDeps,
  deviceId = '',
): Promise<number> {
  return legacySendHttpStatus(await submitCompose(composeRequestFromMime(mime, params, deviceId), userId, command, deps));
}

/**
 * SendMail / SmartReply / SmartForward ([MS-ASCMD]) — returns the EAS send status.
 *
 * The MIME (taken byte-exact, never re-encoded) is handed to the smtp-server outbound
 * worker via the BullMQ queue `smtp-outbound` (local recipients are delivered into their
 * mailbox, external ones relayed and DKIM-signed). The From header must be an address the
 * authenticated user may send as; the envelope sender is that verified address.
 *
 * SmartReply / SmartForward: the Source item (FolderId+ItemId or LongId, own mailbox) is
 * appended to the client's message as an embedded `message/rfc822` part (inline for a
 * reply, as attachment for a forward — body and attachments of the original travel with
 * it) unless `ReplaceMime` is present; the source gets `\Answered` / `$Forwarded`.
 * An unknown source → Status 150.
 *
 * `ClientId` is remembered per user: a retried request with the same ClientId (e.g. after
 * a timeout) is answered with Status 118 instead of sending the mail twice. Without a
 * ClientId (12.1) the Message-ID of the client's MIME from the same device is remembered
 * for a short window instead (`idempotencyKey`).
 *
 * 9.4: a message (including the appended original) above the configured maximum message
 * size is refused with Status 122 AttachmentIsTooLarge (12.1: HTTP 413); the sender's
 * per-mailbox send limits refuse a larger message with 122 and too many recipients with 120.
 */
export async function submitCompose(
  request: ComposeRequest,
  userId: string,
  command: ComposeCommand,
  deps: SendMailDeps,
): Promise<string> {
  const { mime, saveInSent } = request;
  if (!mime || mime.length === 0) return EAS_SEND_STATUS.SUBMISSION_FAILED;

  const idem = idempotencyKey(request);
  let claimed = false;
  try {
    const user = await prisma.user.findFirst({
      where:  { id: userId, active: true },
      select: { email: true },
    });
    if (!user) return EAS_SEND_STATUS.ACCESS_DENIED;

    // v8.1: ProhibitSendQuota (same check as SMTP submission, REST and JMAP)
    const allowed = await (deps.sendAllowed ?? (async (id: string) => (await checkSendQuota(id)).allowed))(userId);
    if (!allowed) {
      log.info({ userId }, 'SendMail refused: mailbox over its send quota');
      return EAS_SEND_STATUS.MAILBOX_QUOTA_EXCEEDED;
    }

    // SmartReply / SmartForward: the original message.
    let raw: Buffer = Buffer.from(mime);
    let source: SourceMessage | null = null;
    if (command !== 'SendMail' && request.source) {
      source = await deps.loadSource(userId, request.source);
      if (!source) return EAS_SEND_STATUS.ITEM_NOT_FOUND;
      if (!request.replaceMime) {
        raw = appendOriginalMessage(raw, source.raw, command === 'SmartForward' ? 'forward' : 'reply', source.subject);
      }
    }

    const limit = await (deps.maxMessageBytes ?? maxOutgoingMessageBytes)();
    if (raw.length > limit) {
      log.info({ userId, command, size: raw.length, limit }, 'EAS send refused: message larger than the maximum message size');
      return EAS_SEND_STATUS.MESSAGE_TOO_LARGE;
    }

    const result = await planEasSubmission(raw, {
      userEmail:      user.email,
      allowedSenders: await listAllowedSenderAddresses(userId),
    });
    if (!result.ok) {
      log.warn({ userId, command, status: result.status, reason: result.reason }, 'EAS send rejected');
      return result.status;
    }
    const plan = result.plan;

    // 9.4: per-mailbox send limits (size, recipients)
    const sendLimit = await (deps.sendLimits ?? defaultSendLimits)(userId, plan.raw.length, plan.recipients.length);
    if (!sendLimit.ok) {
      log.info({ userId, command, kind: sendLimit.kind, limit: sendLimit.limit }, 'EAS send refused: per-mailbox send limit');
      return sendLimitStatus(sendLimit.kind);
    }

    if (idem) {
      claimed = await deps.claimClientId(userId, idem.id, idem.ttlSec);
      if (!claimed) {
        log.info({ userId, command, key: idem.id }, 'EAS send retried (same ClientId / Message-ID) — not sent again');
        return EAS_SEND_STATUS.MESSAGE_PREVIOUSLY_SENT;
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
    claimed = false; // sent: the key stays claimed
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
    // Send as / on behalf of a Shared Mailbox: audit + its Sent copy (never throws).
    await (deps.afterSend ?? defaultAfterSend)(userId, plan).catch(() => undefined);

    return EAS_SEND_STATUS.SUCCESS;
  } catch (err) {
    log.error({ err, userId, command }, 'EAS send failed');
    if (claimed && idem) await deps.releaseClientId(userId, idem.id).catch(() => undefined);
    return EAS_SEND_STATUS.SERVER_ERROR;
  }
}

/**
 * Sent copy through the normal raw-storage path (like the REST and JMAP senders): the
 * original octets are stored, the row is parsed from them and the attachments are stored
 * as attachment rows — IMAP/POP3/JMAP and the web client see the full message.
 */
export function saveSentCopy(userId: string, plan: EasSubmissionPlan): Promise<void> {
  // 9.4: announced once the attachments and the folder counter are written
  return deferMailboxChanges(() => storeSentCopy(userId, plan));
}

async function storeSentCopy(userId: string, plan: EasSubmissionPlan): Promise<void> {
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
