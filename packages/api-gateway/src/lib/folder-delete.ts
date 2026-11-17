/**
 * Deleting a folder without losing mail (9.3 review A1).
 *
 * `Message.folder` is `onDelete: Cascade`: a plain `prisma.folder.delete()` on a
 * folder that still holds messages removes them for good — no tombstone, no
 * modSeq, invisible to IMAP CONDSTORE/QRESYNC, JMAP /changes and ActiveSync, and
 * not recoverable. Before the folder row goes, every message in it (live ones
 * AND tombstones of recoverable items) is moved into the mailbox's Trash through
 * the message store, so the cascade has nothing left to delete:
 *  - folder outside Trash: live messages become live messages in Trash;
 *  - folder inside Trash (a subfolder of it): live messages are expunged first
 *    (tombstone, recoverable for DELETED_ITEM_RETENTION_DAYS), then moved;
 *  - tombstones keep `deletedAt`, so they stay recoverable.
 * Subfolders are not deleted by the callers (the foreign router answers 409, the
 * own-mailbox route keeps them: the FolderTree relation sets their parentId to
 * null), so only the folder's own messages are affected.
 * Everything runs in one transaction; without a Trash folder nothing is changed.
 */
import { prisma, moveMessages, expunge, type MessageStoreTx } from '@coremail/storage';

export interface FolderDeleteResult {
  ok: boolean;
  /** Messages moved into Trash (live + tombstones). */
  moved: number;
  /** Live messages expunged (tombstoned) first because the folder was inside Trash. */
  expunged: number;
  /** Live messages that were in the folder (what the user saw). */
  live: number;
}

async function isInsideFolder(tx: MessageStoreTx, folderParentId: string | null, ancestorId: string): Promise<boolean> {
  const seen = new Set<string>();
  let cursor = folderParentId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    const next: { parentId: string | null } | null = await tx.folder.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
  return false;
}

/**
 * Moves the folder's messages to the mailbox Trash (message store), then deletes
 * the now empty folder. `ok: false` (nothing changed) when the folder still holds
 * messages and the mailbox has no Trash folder.
 */
export async function deleteFolderKeepingMail(folder: { id: string; mailboxId: string; parentId: string | null }): Promise<FolderDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.message.findMany({ where: { folderId: folder.id }, select: { id: true, deletedAt: true } });
    const liveIds = rows.filter((m) => m.deletedAt === null).map((m) => m.id);
    if (rows.length === 0) {
      await tx.folder.delete({ where: { id: folder.id } });
      return { ok: true, moved: 0, expunged: 0, live: 0 };
    }
    const trash = await tx.folder.findFirst({ where: { mailboxId: folder.mailboxId, name: 'Trash' }, select: { id: true } });
    if (!trash || trash.id === folder.id) return { ok: false, moved: 0, expunged: 0, live: liveIds.length };

    const insideTrash = await isInsideFolder(tx, folder.parentId, trash.id);
    if (insideTrash && liveIds.length > 0) {
      await expunge(tx, liveIds, { mailboxId: folder.mailboxId, where: { folderId: folder.id, deletedAt: null } });
    }
    await moveMessages(tx, rows.map((m) => m.id), trash.id, {
      targetMailboxId: folder.mailboxId, sourceMailboxId: folder.mailboxId,
    });
    await tx.folder.delete({ where: { id: folder.id } });
    return { ok: true, moved: rows.length, expunged: insideTrash ? liveIds.length : 0, live: liveIds.length };
  });
}
