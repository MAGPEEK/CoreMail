/**
 * Files raw RFC 5322 octets as a message in a folder (9.4, first used by the
 * MAPI server for drafts and Sent copies; the same steps the ActiveSync and
 * JMAP senders perform):
 *
 *  1. the raw original is stored first (content-addressed), so no reader ever
 *     sees the row without its raw object;
 *  2. the row is created through the message store (UID + modSeq), its columns
 *     parsed from the octets (Bcc can be given separately — it is not in the header);
 *  3. every MIME attachment becomes an attachment row with its own object;
 *  4. the folder counters follow.
 *
 * The realtime announcement (mailbox:changes) goes out once all of it is
 * written (deferMailboxChanges). Also the writer of the Shared Mailbox Sent
 * copy (shared-sent-copy.ts storeRawInSentFolder).
 */
import type { Message } from '@prisma/client';
import { prisma } from './prisma/index.js';
import { parseRawMessage } from './mime/index.js';
import { storeRawMessage } from './raw-message-default.js';
import { truncateBodyColumn } from './raw-message.js';
import { createMessage } from './message-store.js';
import { deferMailboxChanges } from './realtime/change-scope.js';
import { attachmentKey, uploadBuffer } from './minio/index.js';

export interface StoreRawOptions {
  mailboxId: string;
  folderId: string;
  raw: Buffer;
  flags: string[];
  /** Bcc recipients for the row (drafts and Sent copies; never part of the header). */
  bccAddrs?: string[];
}

export function storeRawInFolder(opts: StoreRawOptions): Promise<Message> {
  return deferMailboxChanges(() => store(opts));
}

async function store(opts: StoreRawOptions): Promise<Message> {
  const parsed = await parseRawMessage(opts.raw);
  const { storagePath } = await storeRawMessage(opts.raw);
  const msg = await prisma.$transaction((tx) => createMessage(tx, opts.mailboxId, opts.folderId, {
    flags: opts.flags,
    subject: parsed.subject,
    fromAddr: parsed.fromAddr,
    fromName: parsed.fromName,
    toAddrs: parsed.toAddrs,
    ccAddrs: parsed.ccAddrs,
    bccAddrs: opts.bccAddrs ?? parsed.bccAddrs,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    ...(parsed.importance ? { importance: parsed.importance } : {}),
    ...(parsed.sensitivity ? { sensitivity: parsed.sensitivity } : {}),
    date: parsed.date,
    bodyText: truncateBodyColumn(parsed.bodyText),
    bodyHtml: truncateBodyColumn(parsed.bodyHtml),
    rawSize: opts.raw.length,
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
  const unread = !opts.flags.includes('\\Seen');
  await prisma.folder.update({
    where: { id: opts.folderId },
    data: { totalCount: { increment: 1 }, ...(unread ? { unreadCount: { increment: 1 } } : {}), changeKey: msg.modSeq.toString() },
  });
  return msg;
}
