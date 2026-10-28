/**
 * Write paths: create a message from raw data (Email/set create, Email/import,
 * Email/copy), change flags/folder, delete — incl. folder counters,
 * mailbox UID/ModSeq and Redis notification (MWA SSE + JMAP push).
 */
import { prisma, parseRawMessage, uploadBuffer, rawMessageKey, attachmentKey } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, createLogger } from '@coremail/core';
import type { AccountContext } from '../types.js';
import { ensureThreadId } from './thread.js';

const log = createLogger('jmap:write');

export interface StoredMessage {
  id: string;
  folderId: string;
  threadId: string;
  size: number;
}

export async function storeEmailFromRaw(
  account: AccountContext,
  folderId: string,
  raw: Buffer,
  flags: string[],
  receivedAt?: Date,
): Promise<StoredMessage> {
  const parsed = await parseRawMessage(raw);
  const mbx = await prisma.mailbox.update({
    where: { id: account.mailboxId },
    data: { uidNext: { increment: 1 }, highestModSeq: { increment: 1 } },
    select: { uidNext: true, highestModSeq: true },
  });
  const uid = mbx.uidNext - 1;
  const modSeq = mbx.highestModSeq;
  const seen = flags.includes('\\Seen');

  const msg = await prisma.message.create({
    data: {
      folderId,
      uid,
      modSeq,
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
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      rawSize: raw.length,
      changeKey: modSeq.toString(),
      ...(receivedAt ? { createdAt: receivedAt } : {}),
    },
    select: { id: true },
  });

  const storagePath = rawMessageKey(msg.id);
  await uploadBuffer(storagePath, raw, 'message/rfc822');
  await prisma.message.update({ where: { id: msg.id }, data: { storagePath } });

  for (const att of parsed.attachments) {
    const key = attachmentKey(msg.id, att.filename);
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
  }).catch(() => undefined);

  const threadId = await ensureThreadId({ id: msg.id, threadId: null, inReplyTo: parsed.inReplyTo }, account.mailboxId);
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

  const ops: Array<ReturnType<typeof prisma.folder.update> | ReturnType<typeof prisma.message.update>> = [];
  ops.push(prisma.message.update({
    where: { id: msg.id },
    data: { flags: newFlags, folderId: newFolder, modSeq: BigInt(Date.now()), changeKey: Date.now().toString() },
  }));
  if (newFolder !== msg.folderId) {
    ops.push(prisma.folder.update({
      where: { id: msg.folderId },
      data: { totalCount: { decrement: 1 }, ...(wasSeen ? {} : { unreadCount: { decrement: 1 } }) },
    }));
    ops.push(prisma.folder.update({
      where: { id: newFolder },
      data: { totalCount: { increment: 1 }, ...(isSeen ? {} : { unreadCount: { increment: 1 } }) },
    }));
  } else if (wasSeen !== isSeen) {
    ops.push(prisma.folder.update({
      where: { id: msg.folderId },
      data: { unreadCount: isSeen ? { decrement: 1 } : { increment: 1 } },
    }));
  }
  await prisma.$transaction(ops);
  await notify(account, newFolder, msg.id, 'update');
}

export async function destroyEmail(account: AccountContext, msg: { id: string; folderId: string; flags: string[] }): Promise<void> {
  await prisma.$transaction([
    prisma.message.delete({ where: { id: msg.id } }),
    prisma.folder.update({
      where: { id: msg.folderId },
      data: { totalCount: { decrement: 1 }, ...(msg.flags.includes('\\Seen') ? {} : { unreadCount: { decrement: 1 } }) },
    }),
  ]);
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
