import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { exportEmlStream } from './mbox.js';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('backup:zip');

/**
 * Creates a ZIP archive containing all messages as .eml files,
 * plus contacts as .vcf and calendars as .ics.
 */
export async function exportZip(
  userId: string,
  folderIds: string[] | null,
  outPath: string
): Promise<{ fileCount: number; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    let fileCount = 0;

    output.on('close', () => {
      log.info({ userId, fileCount, sizeBytes: archive.pointer() }, 'ZIP export complete');
      resolve({ fileCount, sizeBytes: archive.pointer() });
    });
    archive.on('error', reject);
    archive.pipe(output);

    // Run async generator and append entries
    (async () => {
      for await (const entry of exportEmlStream(userId, folderIds)) {
        archive.append(entry.content, { name: `mail/${entry.filename}` });
        fileCount++;
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

      await archive.finalize();
    })().catch(reject);
  });
}
