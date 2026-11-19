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
  bodyText: true, bodyHtml: true, flags: true, createdAt: true,
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

/** Internal date of an exported row (`createdAt`; the Date header for a row without one). */
function internalDateOf(msg: { createdAt?: Date | null; date: Date }): Date {
  return new Date(msg.createdAt ?? msg.date);
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
 * Separator-line marker (after the date) of a message whose original octets do
 * NOT end with a line break: the exporter has to add one, the reader
 * (restore/mbox-reader.ts) removes exactly that one again — so the round trip
 * is byte-exact (9.3 review). Other mbox readers ignore text after the date.
 */
export const MBOX_NO_EOL_MARKER = 'cm-noeol';

/**
 * One mboxrd entry: "From " separator line, the raw message with every line that
 * matches /^>*From / quoted with one more ">", a line break and an empty line.
 * "Line" starts are the start of the message and every position after LF or a
 * lone CR (the reader unquotes at the same positions).
 */
export function mboxEntry(raw: Buffer, envelopeFrom: string, date: Date): Buffer {
  const sender = (envelopeFrom || 'MAILER-DAEMON').replace(/[\s<>]/g, '') || 'MAILER-DAEMON';
  const quoted = Buffer.from(raw.toString('latin1').replace(/^(>*From )/gm, '>$1'), 'latin1');
  const noEol = quoted.length > 0 && quoted[quoted.length - 1] !== 0x0a;
  const parts = [Buffer.from(`From ${sender} ${mboxDate(date)}${noEol ? ` ${MBOX_NO_EOL_MARKER}` : ''}\r\n`, 'latin1'), quoted];
  if (noEol) parts.push(Buffer.from('\r\n'));
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
      // 9.5: the separator line carries the internal date (arrival in the mailbox),
      // the restore takes it from there (restore/mbox-reader.ts).
      const chunk = mboxEntry(raw, msg.fromAddr, internalDateOf(msg));
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

/** File-system safe path segment of a folder name (9.3: the exact name goes into the manifest). */
export function folderPathSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'mail';
}

export interface EmlEntry {
  filename: string;
  content: Buffer;
  /** Exact folder name (9.3: manifest + restore). */
  folder: string;
  flags: string[];
  date: Date;
  /** 9.5: internal date (arrival in the mailbox) — manifest + restore. */
  internalDate: Date;
}

/**
 * Export individual messages as .eml files (the original raw octets), yielding each one.
 * 9.3: two folders whose names sanitize to the same path segment get distinct
 * segments (`name~2`), so no two archive entries share a name.
 */
export async function* exportEmlStream(
  userId: string,
  folderIds: string[] | null
): AsyncGenerator<EmlEntry> {
  const ids = await folderIdsOf(userId, folderIds);
  const usedSegments = new Set<string>();
  for (const folderId of ids ?? []) {
    const folder = await prisma.folder.findUnique({ where: { id: folderId }, select: { name: true } });
    const exactName = folder?.name ?? 'INBOX';
    const base = folderPathSegment(exactName);
    let folderName = base;
    for (let n = 2; usedSegments.has(folderName.toLowerCase()); n++) folderName = `${base}~${n}`;
    usedSegments.add(folderName.toLowerCase());
    for await (const msg of folderMessages(folderId)) {
      let content: Buffer;
      try {
        content = await loadRawMessage(msg as unknown as RawSourceMessage, { persist: false });
      } catch (err) {
        log.error({ err, messageId: msg.id }, 'EML export: raw message unavailable — skipped');
        continue;
      }
      yield {
        filename: `${folderName}/${msg.uid}.eml`, content, folder: exactName,
        flags: Array.isArray(msg.flags) ? msg.flags : [], date: new Date(msg.date), internalDate: internalDateOf(msg),
      };
    }
  }
}
