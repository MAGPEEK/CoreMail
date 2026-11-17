import { prisma, touchMessages } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { emptyCounts, mboxItems, restoreItems, DEFAULT_MAX_MESSAGE_BYTES } from './engine.js';

const log = createLogger('backup:restore');

/**
 * Imports an MBOX file into a target folder (9.3: through the restore engine —
 * byte-exact mboxrd reader, raw originals, idempotent: messages already in the
 * folder are skipped and counted as `duplicates`).
 */
export async function importMbox(
  userId: string,
  folderId: string,
  mboxPath: string
): Promise<{ imported: number; errors: number; duplicates: number }> {
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailbox: { userId } },
  });
  if (!folder) throw new Error('Folder not found or access denied');

  const counts = await restoreItems(
    mboxItems(mboxPath, { maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES }),
    { mailboxId: folder.mailboxId, mode: 'folder', folderId, rootName: '' },
    emptyCounts(),
  );
  log.info({ userId, folderId, ...counts }, 'MBOX import complete');
  return { imported: counts.imported, errors: counts.failed, duplicates: counts.duplicates };
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
