import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { exportEmlStream } from './mbox.js';
import { ManifestBuilder, MANIFEST_NAME } from './manifest.js';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:zip');

/**
 * Creates a ZIP archive containing all messages as .eml files (original raw
 * octets), plus contacts as .vcf and calendars as .ics. 9.3: the archive also
 * holds `coremail-manifest.json` (exact folder names + flags of every message),
 * which the restore uses to put messages back into their folders with their flags.
 * `fileCount` counts every file except the manifest; `messageCount` only the mails.
 */
export async function exportZip(
  userId: string,
  folderIds: string[] | null,
  outPath: string
): Promise<{ fileCount: number; messageCount: number; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    let fileCount = 0;
    let messageCount = 0;

    output.on('close', () => {
      log.info({ userId, fileCount, messageCount, sizeBytes: archive.pointer() }, 'ZIP export complete');
      resolve({ fileCount, messageCount, sizeBytes: archive.pointer() });
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    // Run async generator and append entries
    (async () => {
      const manifest = new ManifestBuilder(userId);
      for await (const entry of exportEmlStream(userId, folderIds)) {
        const name = `mail/${entry.filename}`;
        archive.append(entry.content, { name });
        manifest.add(name, entry.folder, entry.flags, entry.date, entry.content.length);
        fileCount++;
        messageCount++;
      }

      // Add contacts as vCard
      const contacts = await prisma.contact.findMany({ where: { userId } });
      for (const c of contacts) {
        if (c.vcardData) {
          archive.append(c.vcardData, { name: `contacts/${c.id}.vcf` });
          fileCount++;
        }
      }

      // Add calendar events as iCal
      const calendars = await prisma.calendar.findMany({
        where: { userId },
        include: { events: { select: { id: true, icalData: true, summary: true } } },
      });
      for (const cal of calendars) {
        const calName = cal.name.replace(/[^a-z0-9]/gi, '_');
        for (const ev of cal.events) {
          if (ev.icalData) {
            archive.append(ev.icalData, { name: `calendar/${calName}/${ev.id}.ics` });
            fileCount++;
          }
        }
      }

      archive.append(JSON.stringify(manifest.build()), { name: MANIFEST_NAME });
      await archive.finalize();
    })().catch(reject);
  });
}
