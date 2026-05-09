import { prisma, parseRawMessage, uploadBuffer, rawMessageKey, attachmentKey } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';

const log = createLogger('smtp:message-handler');

const LARGE_MESSAGE_THRESHOLD = 256 * 1024; // 256 KB — store raw in MinIO above this

export interface StoreOptions {
  fromAddr: string;
  rcptTo: string;
  toJunk: boolean;
  spamScore?: number;
}

export async function storeInboundMessage(
  rawBuffer: Buffer,
  opts: StoreOptions,
): Promise<void> {
  const parsed = await parseRawMessage(rawBuffer);

  // Find recipient's mailbox
  const user = await prisma.user.findFirst({
    where: { email: opts.rcptTo.toLowerCase(), active: true },
    include: {
      mailbox: {
        include: { folders: true },
      },
    },
  });

  if (!user?.mailbox) {
    log.warn({ rcptTo: opts.rcptTo }, 'Mailbox not found — dropping message');
    return;
  }

  const mailbox = user.mailbox;

  // Find the target folder (INBOX or Junk)
  const targetFolderName = opts.toJunk ? 'Junk E-Mail' : 'Inbox';
  const folder = mailbox.folders.find(
    (f) => f.name === targetFolderName || f.name === 'INBOX',
  );

  if (!folder) {
    log.error({ rcptTo: opts.rcptTo, folder: targetFolderName }, 'Target folder not found');
    return;
  }

  // Allocate UID and modseq atomically
  const updatedMailbox = await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: {
      uidNext: { increment: 1 },
      highestModSeq: { increment: 1 },
    },
  });

  const uid    = updatedMailbox.uidNext - 1;
  const modSeq = updatedMailbox.highestModSeq;

  // Store raw message in MinIO if large, otherwise inline
  let storagePath: string | null = null;
  if (rawBuffer.length > LARGE_MESSAGE_THRESHOLD) {
    const msgId = crypto.randomUUID();
    storagePath = rawMessageKey(msgId);
    await uploadBuffer(storagePath, rawBuffer, 'message/rfc822');
  }

  // Create message record
  const message = await prisma.message.create({
    data: {
      folderId: folder.id,
      uid,
      modSeq,
      flags: opts.toJunk ? [] : [],
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
      bodyText: storagePath ? '' : parsed.bodyText,
      bodyHtml: storagePath ? '' : parsed.bodyHtml,
      rawSize: rawBuffer.length,
      storagePath,
      changeKey: modSeq.toString(),
    },
  });

  // Store attachments (deduplicated by SHA256)
  for (const att of parsed.attachments) {
    const key = attachmentKey(message.id, att.filename);
    await uploadBuffer(key, att.buffer, att.mimeType);

    await prisma.attachment.create({
      data: {
        messageId: message.id,
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

  // Update folder counters
  await prisma.folder.update({
    where: { id: folder.id },
    data: {
      totalCount: { increment: 1 },
      unreadCount: { increment: 1 },
      changeKey: modSeq.toString(),
    },
  });

  // Update user quota usage
  await prisma.user.update({
    where: { id: user.id },
    data: { usedBytes: { increment: rawBuffer.length } },
  });

  // Publish real-time notification
  const redis = getRedisClient();
  await redis.publish(
    CHANNEL_MAIL_NEW,
    JSON.stringify({
      userId: user.id,
      folderId: folder.id,
      messageId: message.id,
      uid,
      subject: parsed.subject,
      fromAddr: parsed.fromAddr,
      fromName: parsed.fromName,
      date: parsed.date.toISOString(),
      isJunk: opts.toJunk,
    }),
  );

  log.info(
    { rcptTo: opts.rcptTo, folder: folder.name, uid, size: rawBuffer.length },
    'Message stored',
  );
}
