/**
 * Empties one folder of a mailbox: every live message becomes a tombstone
 * (recoverable for the retention period) through the message store, counters reset.
 * Used by DELETE /user/folders/:id/empty and (9.4) "empty Deleted Items on logout".
 */
import { prisma, expunge, deferMailboxChanges } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { loadPreferences } from './preferences-store.js';

const log = createLogger('api:empty-folder');
export const TRASH_FOLDER = 'Trash';

/**
 * Returns the number of messages moved to the recoverable items. The live event
 * (9.4 realtime) goes out once the folder counters are reset as well.
 */
export function emptyFolder(mailboxId: string, folderId: string): Promise<number> {
  return deferMailboxChanges(async () => {
    const live = await prisma.message.findMany({ where: { folderId, deletedAt: null }, select: { id: true } });
    if (live.length > 0) {
      await prisma.$transaction((tx) => expunge(tx, live.map((m) => m.id), { mailboxId }));
    }
    await prisma.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
    return live.length;
  });
}

/**
 * 9.4: after a web logout — empties the own Deleted Items folder when the user
 * enabled it (Settings → Lesen). Never throws: logout must not fail on it.
 */
export async function emptyTrashAfterLogout(userId: string): Promise<void> {
  try {
    if (!(await loadPreferences(userId)).reading.emptyTrashOnLogout) return;
    const trash = await prisma.folder.findFirst({
      where: { name: TRASH_FOLDER, mailbox: { userId } },
      select: { id: true, mailboxId: true },
    });
    if (!trash) return;
    const n = await emptyFolder(trash.mailboxId, trash.id);
    log.info({ userId, messages: n }, 'Deleted Items emptied on logout');
  } catch (err) {
    log.warn({ err, userId }, 'Emptying Deleted Items on logout failed');
  }
}
