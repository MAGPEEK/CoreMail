/**
 * Write paths: create a message from raw data (Email/set create, Email/import,
 * Email/copy), change flags/folder, delete — incl. folder counters,
 * mailbox UID/ModSeq and Redis notification (MWA SSE + JMAP push).
 */
import {
  prisma, parseRawMessage, uploadBuffer, storeRawMessage, truncateBodyColumn, attachmentKey,
  createMessage, moveMessages, setFlags, expunge, isMailboxWriteBlocked, OVER_QUOTA_MESSAGE,
} from '@coremail/storage';
import { setError, type SetError } from '../errors.js';
import { getRedisClient, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, createLogger } from '@coremail/core';
import type { AccountContext } from '../types.js';
import { resolveThreadId } from './thread.js';

const log = createLogger('jmap:write');

export interface StoredMessage {
  id: string;
  folderId: string;
  threadId: string;
  size: number;
}

/** SetError overQuota when the mailbox is at its hard quota (fresh usage), else null. */
export async function writeQuotaError(mailboxId: string): Promise<SetError | null> {
  return (await isMailboxWriteBlocked(mailboxId)) ? setError('overQuota', OVER_QUOTA_MESSAGE) : null;
}

export async function storeEmailFromRaw(
  account: AccountContext,
  folderId: string,
  raw: Buffer,
  flags: string[],
  receivedAt?: Date,
): Promise<StoredMessage> {
  // v8.1 hard quota (ProhibitSendReceiveQuota): Email/set create, Email/import and
  // Email/copy add content to the mailbox — SetError overQuota (RFC 8621 §4.6).
  const quotaError = await writeQuotaError(account.mailboxId);
  if (quotaError) throw quotaError;
  const parsed = await parseRawMessage(raw);
  const seen = flags.includes('\\Seen');
  // Raw-always storage, written before the row exists so no reader ever sees the
  // message without its raw object (content-addressed, shared with copies).
  const { storagePath } = await storeRawMessage(raw);

  // UID + modSeq are allocated atomically by the message store.
  // Thread (RFC 8621 §3) is assigned in the creating transaction: the row is never
  // visible without its threadId and no extra modSeq is needed.
  const msg = await prisma.$transaction(async (tx) => {
    const thread = await resolveThreadId({ id: '', messageId: parsed.messageId, inReplyTo: parsed.inReplyTo }, account.mailboxId, tx);
    const created = await createMessage(tx, account.mailboxId, folderId, {
      flags,
      subject: parsed.subject,
      fromAddr: parsed.fromAddr,
      fromName: parsed.fromName,
      toAddrs: parsed.toAddrs,
      ccAddrs: parsed.ccAddrs,
      bccAddrs: parsed.bccAddrs,
      replyTo: parsed.replyTo,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      date: parsed.date,
      bodyText: truncateBodyColumn(parsed.bodyText),
      bodyHtml: truncateBodyColumn(parsed.bodyHtml),
      rawSize: raw.length,
      storagePath,
      ...(receivedAt ? { createdAt: receivedAt } : {}),
      ...(thread ? { threadId: thread } : {}),
    });
    if (thread) return created;
    return tx.message.update({ where: { id: created.id }, data: { threadId: created.id } });
  });

  for (const [index, att] of parsed.attachments.entries()) {
    const key = attachmentKey(msg.id, `${index}-${att.sha256.slice(0, 16)}`);
    await uploadBuffer(key, att.buffer, att.mimeType);
    await prisma.attachment.create({
      data: {
        messageId: msg.id,
        contentId: att.contentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        sha256: att.sha256,
        storagePath: key,
        inline: att.inline,
      },
    });
  }

  await prisma.folder.update({
    where: { id: folderId },
    data: { totalCount: { increment: 1 }, ...(seen ? {} : { unreadCount: { increment: 1 } }) },
  }).catch((err: unknown) => log.warn({ err, folderId }, 'folder counter update failed'));

  const threadId = msg.threadId ?? msg.id;
  await notify(account, folderId, msg.id, 'new');
  return { id: msg.id, folderId, threadId, size: raw.length };
}

export interface FlagMove {
  flags?: string[];
  folderId?: string;
}

export async function applyEmailChange(
  account: AccountContext,
  msg: { id: string; folderId: string; flags: string[] },
  change: FlagMove,
): Promise<void> {
  const newFlags = change.flags ?? msg.flags;
  const newFolder = change.folderId ?? msg.folderId;
  const wasSeen = msg.flags.includes('\\Seen');
  const isSeen = newFlags.includes('\\Seen');

  const mailboxId = account.mailboxId;
  await prisma.$transaction(async (tx) => {
    if (newFolder !== msg.folderId) {
      // Move: new UID in the target folder + new modSeq (RFC 6851 semantics for IMAP clients).
      await moveMessages(tx, [msg.id], newFolder, {
        targetMailboxId: mailboxId, sourceMailboxId: mailboxId, data: { flags: newFlags },
      });
      await tx.folder.update({
        where: { id: msg.folderId },
        data: { totalCount: { decrement: 1 }, ...(wasSeen ? {} : { unreadCount: { decrement: 1 } }) },
      });
      await tx.folder.update({
        where: { id: newFolder },
        data: { totalCount: { increment: 1 }, ...(isSeen ? {} : { unreadCount: { increment: 1 } }) },
      });
    } else {
      await setFlags(tx, [{ id: msg.id, flags: newFlags }], { mailboxId });
      if (wasSeen !== isSeen) {
        await tx.folder.update({
          where: { id: msg.folderId },
          data: { unreadCount: isSeen ? { decrement: 1 } : { increment: 1 } },
        });
      }
    }
  });
  await notify(account, newFolder, msg.id, 'update');
}

export async function destroyEmail(account: AccountContext, msg: { id: string; folderId: string; flags: string[] }): Promise<void> {
  const mailboxId = account.mailboxId;
  await prisma.$transaction(async (tx) => {
    // Soft delete like IMAP EXPUNGE (30-day recovery window). The row stays as a
    // tombstone with a fresh modSeq, which lets Email/changes report it in
    // "destroyed" (RFC 8620 §5.2) instead of failing with cannotCalculateChanges.
    await expunge(tx, [msg.id], { mailboxId });
    await tx.folder.update({
      where: { id: msg.folderId },
      data: { totalCount: { decrement: 1 }, ...(msg.flags.includes('\\Seen') ? {} : { unreadCount: { decrement: 1 } }) },
    });
  });
  await notify(account, msg.folderId, msg.id, 'update');
}

/** Redis signal: MWA SSE (mail:new/mail:update) + JMAP push bus. */
export async function notify(account: AccountContext, folderId: string, messageId: string, kind: 'new' | 'update'): Promise<void> {
  try {
    await getRedisClient().publish(kind === 'new' ? CHANNEL_MAIL_NEW : CHANNEL_MAIL_UPDATE, JSON.stringify({
      ...(account.ownerUserId ? { userId: account.ownerUserId } : {}),
      accountId: account.accountId,
      folderId,
      messageId,
      source: 'jmap',
    }));
  } catch (err) {
    log.warn({ err }, 'Redis publish failed');
  }
}

export async function notifyMailboxChange(account: AccountContext): Promise<void> {
  try {
    await getRedisClient().publish(CHANNEL_MAIL_UPDATE, JSON.stringify({
      ...(account.ownerUserId ? { userId: account.ownerUserId } : {}),
      accountId: account.accountId,
      type: 'folders',
      source: 'jmap',
    }));
  } catch (err) {
    log.warn({ err }, 'Redis publish failed');
  }
}
