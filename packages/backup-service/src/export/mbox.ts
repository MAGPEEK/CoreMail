import { createWriteStream, type WriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { getPrisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:mbox');

/**
 * Streams all messages from a user's mailbox as RFC 4155 MBOX format.
 * Each message is prefixed with a "From " line (mbox separator).
 */
export async function exportMbox(
  userId: string,
  folderIds: string[] | null,
  outPath: string
): Promise<{ messageCount: number; sizeBytes: number }> {
  const prisma = getPrisma();
  const ws: WriteStream = createWriteStream(outPath, { encoding: 'utf8' });

  let messageCount = 0;
  let sizeBytes = 0;

  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  if (!mailbox) {
    ws.end();
    return { messageCount: 0, sizeBytes: 0 };
  }

  const allFolderIds = folderIds ??
    (await prisma.folder.findMany({ where: { mailboxId: mailbox.id }, select: { id: true } })).map((f) => f.id);

  for (const folderId of allFolderIds) {
    // Process in pages to avoid loading all messages into memory
    let offset = 0;
    const PAGE = 100;

    while (true) {
      const messages = await prisma.message.findMany({
        where: { folderId, deletedAt: null },
        orderBy: { date: 'asc' },
        take: PAGE,
        skip: offset,
        select: { id: true, fromAddr: true, date: true, bodyText: true, bodyHtml: true, subject: true, flags: true },
      });

      if (!messages.length) break;

      for (const msg of messages) {
        const from = msg.fromAddr || 'unknown@localhost';
        const date = new Date(msg.date).toUTCString();
        const body = msg.bodyText || msg.bodyHtml?.replace(/<[^>]+>/g, '') || '';

        // Escape lines starting with "From " per RFC 4155
        const escapedBody = body.replace(/^From /gm, '>From ');

        const mboxMsg = `From ${from} ${date}\r\n` +
          `From: ${msg.fromAddr}\r\n` +
          `Subject: ${msg.subject}\r\n` +
          `Date: ${date}\r\n` +
          `Status: ${msg.flags.includes('\\Seen') ? 'R' : ''}\r\n` +
          `\r\n` +
          `${escapedBody}\r\n\r\n`;

        const chunk = Buffer.from(mboxMsg, 'utf8');
        sizeBytes += chunk.byteLength;
        messageCount++;

        if (!ws.write(mboxMsg)) {
          // Backpressure: wait for drain
          await new Promise<void>((resolve) => ws.once('drain', resolve));
        }
      }

      offset += PAGE;
      if (messages.length < PAGE) break;
    }
  }

  await new Promise<void>((resolve, reject) => {
    ws.end((err) => (err ? reject(err) : resolve()));
  });

  log.info({ userId, messageCount, sizeBytes }, 'MBOX export complete');
  return { messageCount, sizeBytes };
}

/**
 * Export individual messages as .eml files, yielding each one.
 */
export async function* exportEmlStream(
  userId: string,
  folderIds: string[] | null
): AsyncGenerator<{ filename: string; content: string }> {
  const prisma = getPrisma();
  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  if (!mailbox) return;

  const allFolderIds = folderIds ??
    (await prisma.folder.findMany({ where: { mailboxId: mailbox.id }, select: { id: true } })).map((f) => f.id);

  for (const folderId of allFolderIds) {
    const folder = await prisma.folder.findUnique({ where: { id: folderId }, select: { name: true } });
    let offset = 0;

    while (true) {
      const messages = await prisma.message.findMany({
        where: { folderId, deletedAt: null },
        orderBy: { date: 'asc' },
        take: 50,
        skip: offset,
        select: { id: true, uid: true, fromAddr: true, toAddrs: true, subject: true, date: true, bodyText: true, bodyHtml: true },
      });

      if (!messages.length) break;

      for (const msg of messages) {
        const eml = buildEml(msg);
        yield {
          filename: `${folder?.name ?? 'mail'}/${msg.uid}.eml`,
          content: eml,
        };
      }

      offset += 50;
      if (messages.length < 50) break;
    }
  }
}

function buildEml(msg: {
  fromAddr: string; toAddrs: string[]; subject: string; date: Date;
  bodyText: string; bodyHtml: string;
}): string {
  const lines = [
    `From: ${msg.fromAddr}`,
    `To: ${msg.toAddrs.join(', ')}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(msg.date).toUTCString()}`,
    `MIME-Version: 1.0`,
  ];

  if (msg.bodyHtml) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="coremail-boundary"`,
      ``,
      `--coremail-boundary`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      msg.bodyText || msg.bodyHtml.replace(/<[^>]+>/g, ''),
      ``,
      `--coremail-boundary`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      msg.bodyHtml,
      ``,
      `--coremail-boundary--`,
    );
  } else {
    lines.push(
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      msg.bodyText,
    );
  }

  return lines.join('\r\n');
}
