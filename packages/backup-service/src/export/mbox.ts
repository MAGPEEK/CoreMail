import { createWriteStream, type WriteStream } from 'node:fs';
import { prisma, loadRawMessage, type RawSourceMessage } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:mbox');

/**
 * Backups export the ORIGINAL messages: the raw RFC 5322 octets from object
 * storage, with every header field and every attachment. Legacy rows without a
 * raw object are reconstructed (deterministically, with their attachments) but
 * not persisted — a backup never writes to the mail store.
 */
const MESSAGE_SELECT = {
  id: true, uid: true, storagePath: true, subject: true, fromAddr: true, fromName: true,
  toAddrs: true, ccAddrs: true, replyTo: true, messageId: true, inReplyTo: true, date: true,
  bodyText: true, bodyHtml: true, flags: true,
  attachments: { select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true } },
} as const;

const PAGE = 100;

/** All raw messages of the given folders (paged; deleted messages excluded). */
async function* folderMessages(folderId: string) {
  let offset = 0;
  for (;;) {
    const messages = await prisma.message.findMany({
      where: { folderId, deletedAt: null },
      orderBy: [{ date: 'asc' }, { uid: 'asc' }],
      take: PAGE,
      skip: offset,
      select: MESSAGE_SELECT,
    });
    if (!messages.length) return;
    for (const msg of messages) yield msg;
    offset += PAGE;
    if (messages.length < PAGE) return;
  }
}

async function folderIdsOf(userId: string, folderIds: string[] | null): Promise<string[] | null> {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  if (!mailbox) return null;
  return folderIds ??
    (await prisma.folder.findMany({ where: { mailboxId: mailbox.id }, select: { id: true } })).map((f: { id: string }) => f.id);
}

/** asctime() date of the mbox "From " separator line: "Tue Feb  3 10:20:30 2026". */
export function mboxDate(d: Date): string {
  const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${days[t.getUTCDay()]} ${months[t.getUTCMonth()]} ${String(t.getUTCDate()).padStart(2, ' ')} `
    + `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())} ${t.getUTCFullYear()}`;
}

/**
 * One mboxrd entry: "From " separator line, the raw message with every line that
 * matches /^>*From / quoted with one more ">", a line break and an empty line.
 */
export function mboxEntry(raw: Buffer, envelopeFrom: string, date: Date): Buffer {
  const sender = (envelopeFrom || 'MAILER-DAEMON').replace(/[\s<>]/g, '') || 'MAILER-DAEMON';
  const quoted = Buffer.from(raw.toString('latin1').replace(/^(>*From )/gm, '>$1'), 'latin1');
  const parts = [Buffer.from(`From ${sender} ${mboxDate(date)}\r\n`, 'latin1'), quoted];
  if (quoted.length > 0 && quoted[quoted.length - 1] !== 0x0a) parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('\r\n'));
  return Buffer.concat(parts);
}

/**
 * Streams all messages of a user's mailbox as mboxrd (RFC 4155): the original
 * messages with all headers and attachments.
 */
export async function exportMbox(
  userId: string,
  folderIds: string[] | null,
  outPath: string
): Promise<{ messageCount: number; sizeBytes: number }> {
  const ws: WriteStream = createWriteStream(outPath);
  let messageCount = 0;
  let sizeBytes = 0;
  let skipped = 0;

  const ids = await folderIdsOf(userId, folderIds);
  for (const folderId of ids ?? []) {
    for await (const msg of folderMessages(folderId)) {
      let raw: Buffer;
      try {
        raw = await loadRawMessage(msg as unknown as RawSourceMessage, { persist: false });
      } catch (err) {
        skipped++;
        log.error({ err, messageId: msg.id }, 'MBOX export: raw message unavailable — skipped');
        continue;
      }
      const chunk = mboxEntry(raw, msg.fromAddr, new Date(msg.date));
      sizeBytes += chunk.length;
      messageCount++;
      if (!ws.write(chunk)) await new Promise<void>((resolve) => ws.once('drain', resolve));
    }
  }

  await new Promise<void>((resolve, reject) => {
    ws.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });

  log.info({ userId, messageCount, sizeBytes, skipped }, 'MBOX export complete');
  return { messageCount, sizeBytes };
}

/**
 * Export individual messages as .eml files (the original raw octets), yielding each one.
 */
export async function* exportEmlStream(
  userId: string,
  folderIds: string[] | null
): AsyncGenerator<{ filename: string; content: Buffer }> {
  const ids = await folderIdsOf(userId, folderIds);
  for (const folderId of ids ?? []) {
    const folder = await prisma.folder.findUnique({ where: { id: folderId }, select: { name: true } });
    const folderName = (folder?.name ?? 'mail').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'mail';
    for await (const msg of folderMessages(folderId)) {
      let content: Buffer;
      try {
        content = await loadRawMessage(msg as unknown as RawSourceMessage, { persist: false });
      } catch (err) {
        log.error({ err, messageId: msg.id }, 'EML export: raw message unavailable — skipped');
        continue;
      }
      yield { filename: `${folderName}/${msg.uid}.eml`, content };
    }
  }
}
