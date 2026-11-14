import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { prisma, createMessage, touchMessages } from '@coremail/storage';
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

  const rl = createInterface({ input: createReadStream(mboxPath), crlfDelay: Infinity });

  let currentLines: string[] = [];
  let imported = 0;
  let errors = 0;

  const flush = async () => {
    if (!currentLines.length) return;
    try {
      const raw = currentLines.join('\r\n');
      const fromLine = currentLines[0] ?? '';
      const fromMatch = fromLine.match(/^From\s+(\S+)\s+(.+)$/);
      const fromAddr = fromMatch?.[1] ?? 'unknown@localhost';
      const dateStr = fromMatch?.[2] ?? new Date().toUTCString();

      let subject = '';
      let bodyStart = 0;
      for (let i = 1; i < currentLines.length; i++) {
        const line = currentLines[i] ?? '';
        if (line === '') { bodyStart = i + 1; break; }
        const subjectMatch = line.match(/^Subject:\s*(.+)/i);
        if (subjectMatch) subject = subjectMatch[1] ?? '';
      }
      const bodyText = currentLines.slice(bodyStart).join('\r\n').replace(/^>From /gm, 'From ');

      // UID + modSeq are allocated atomically by the message store (the old code
      // reused the uidNext read once before the loop for every message).
      await prisma.$transaction((tx) => createMessage(tx, folder.mailboxId, folderId, {
          flags: ['\\Seen'],
          subject,
          fromAddr,
          toAddrs: [],
          date: new Date(dateStr),
          bodyText,
          bodyHtml: '',
          rawSize: raw.length,
          storagePath: '',
      }));

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
