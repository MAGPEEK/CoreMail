import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  prisma, createMessage, touchMessages, parseRawMessage, storeRawMessage, truncateBodyColumn,
  attachmentKey, uploadBuffer,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:restore');

/**
 * Imports an MBOX file into a target folder.
 * Each "From " line starts a new message.
 */
export async function importMbox(
  userId: string,
  folderId: string,
  mboxPath: string
): Promise<{ imported: number; errors: number }> {
  

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailbox: { userId } },
  });
  if (!folder) throw new Error('Folder not found or access denied');

  const rl = createInterface({ input: createReadStream(mboxPath, { encoding: 'latin1' }), crlfDelay: Infinity });

  let currentLines: string[] = [];
  let imported = 0;
  let errors = 0;

  const flush = async () => {
    if (!currentLines.length) return;
    try {
      // mboxrd: drop the "From " separator line, un-quote ">From " lines and the
      // empty line that terminates the entry; the rest is the original message.
      const lines = currentLines.slice(1);
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const raw = Buffer.from(
        `${lines.map((l) => l.replace(/^>(>*From )/, '$1')).join('\r\n')}\r\n`,
        'latin1',
      );
      const parsed = await parseRawMessage(raw);
      const { storagePath } = await storeRawMessage(raw);

      // UID + modSeq are allocated atomically by the message store (the old code
      // reused the uidNext read once before the loop for every message).
      const created = await prisma.$transaction((tx) => createMessage(tx, folder.mailboxId, folderId, {
          flags: ['\\Seen'],
          subject:   parsed.subject,
          fromAddr:  parsed.fromAddr,
          fromName:  parsed.fromName,
          toAddrs:   parsed.toAddrs,
          ccAddrs:   parsed.ccAddrs,
          bccAddrs:  parsed.bccAddrs,
          replyTo:   parsed.replyTo,
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          date:      parsed.date,
          bodyText:  truncateBodyColumn(parsed.bodyText),
          bodyHtml:  truncateBodyColumn(parsed.bodyHtml),
          rawSize:   raw.length,
          storagePath,
      }));
      for (const [index, att] of parsed.attachments.entries()) {
        const key = attachmentKey(created.id, `${index}-${att.sha256.slice(0, 16)}`);
        await uploadBuffer(key, att.buffer, att.mimeType);
        await prisma.attachment.create({
          data: {
            messageId: created.id, contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
            size: att.size, sha256: att.sha256, storagePath: key, inline: att.inline,
          },
        });
      }

      await prisma.folder.update({
        where: { id: folderId },
        data: { totalCount: { increment: 1 } },
      });

      imported++;
    } catch (err) {
      log.warn({ err }, 'Failed to import message');
      errors++;
    }
    currentLines = [];
  };

  for await (const line of rl) {
    if (line.startsWith('From ') && currentLines.length > 0) {
      await flush();
    }
    currentLines.push(line);
  }
  await flush();

  log.info({ userId, folderId, imported, errors }, 'MBOX import complete');
  return { imported, errors };
}

/**
 * Restore a single message by ID from soft-delete (unset deletedAt).
 */
export async function restoreMessage(userId: string, messageId: string): Promise<void> {
  
  const msg = await prisma.message.findFirst({
    where: { id: messageId, deletedAt: { not: null }, folder: { mailbox: { userId } } },
  });
  if (!msg) throw new Error('Message not found or already active');

  // Un-expunge = the message reappears → new modSeq (visible to CONDSTORE/JMAP/EAS).
  await prisma.$transaction((tx) => touchMessages(tx, [messageId], { deletedAt: null }));

  await prisma.folder.update({
    where: { id: msg.folderId },
    data: { totalCount: { increment: 1 } },
  });
}

/**
 * List soft-deleted messages eligible for self-service restore (within 30 days).
 */
export async function listRestorableMessages(userId: string) {
  
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return prisma.message.findMany({
    where: {
      folder: { mailbox: { userId } },
      deletedAt: { gte: since },
    },
    orderBy: { deletedAt: 'desc' },
    select: { id: true, subject: true, fromAddr: true, date: true, deletedAt: true, folderId: true },
    take: 200,
  });
}
