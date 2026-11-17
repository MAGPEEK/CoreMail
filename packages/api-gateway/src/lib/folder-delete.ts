/**
 * Deleting a folder (and its subfolders) without losing mail (9.3 review A1; subfolders: recursive delete).
 *
 * `Message.folder` is `onDelete: Cascade`: a plain `prisma.folder.delete()` on a
 * folder that still holds messages removes them for good — no tombstone, no
 * modSeq, invisible to IMAP CONDSTORE/QRESYNC, JMAP /changes and ActiveSync, and
 * not recoverable. And the FolderTree relation sets the parentId of remaining
 * subfolders to null, so they would jump to the top level.
 *
 * So a delete always covers the whole subtree, and only on request:
 *  - `folderDeleteRefusal()` decides first: subfolders without `recursive` → 409
 *    with the counts, a protected (system) folder inside the subtree → 409, live
 *    mail without `force` → 409 with the count;
 *  - `deleteFolderTree()` then moves every message of every folder in the subtree
 *    (live ones AND tombstones of recoverable items) into the mailbox's Trash
 *    through the message store (new UIDs + modSeq, so IMAP/JMAP/ActiveSync see
 *    the change), and deletes the now empty folders bottom-up:
 *      - subtree outside Trash: live messages become live messages in Trash;
 *      - subtree inside Trash: live messages are expunged first (tombstone,
 *        recoverable for DELETED_ITEM_RETENTION_DAYS), then moved;
 *      - tombstones keep `deletedAt`, so they stay recoverable.
 * Everything runs in one transaction; without a Trash folder nothing is changed.
 */
import { prisma, moveMessages, expunge, type MessageStoreTx } from '@coremail/storage';

export interface FolderRef { id: string; mailboxId: string; parentId: string | null }
interface FolderNode { id: string; name: string; parentId: string | null }

export interface FolderDeleteResult {
  ok: boolean;
  /** Messages moved into Trash (live + tombstones). */
  moved: number;
  /** Live messages expunged (tombstoned) first because the subtree was inside Trash. */
  expunged: number;
  /** Live messages that were in the subtree (what the user saw). */
  live: number;
  /** Folders deleted (the folder itself + its subfolders). */
  folders: number;
}

export interface FolderTreeSummary {
  /** Number of subfolders at any depth. */
  subfolders: number;
  /** Live messages in the folder and all its subfolders. */
  count: number;
  /** Name of a protected folder inside the subtree (excluding the folder itself), if any. */
  protectedInside: string | null;
}

export interface FolderDeleteOptions {
  /** Delete subfolders too (`?recursive=true`). */
  recursive: boolean;
  /** Delete although live mail would move to Trash (`?force=true`). */
  force: boolean;
}

export type FolderDeleteRefusalCode = 'FOLDER_HAS_SUBFOLDERS' | 'PROTECTED_SUBFOLDER' | 'FOLDER_NOT_EMPTY';
export interface FolderDeleteRefusal {
  error: string;
  code: FolderDeleteRefusalCode;
  subfolders: number;
  count: number;
}

type FolderReader = Pick<MessageStoreTx, 'folder'>;

/** The folder and all its descendants in the same mailbox, parents before children. */
export async function folderSubtree(db: FolderReader, root: FolderRef): Promise<Array<FolderNode & { depth: number }>> {
  const rootRow = await db.folder.findUnique({ where: { id: root.id }, select: { id: true, name: true, parentId: true } });
  if (!rootRow) return [];
  const out: Array<FolderNode & { depth: number }> = [{ ...rootRow, depth: 0 }];
  const seen = new Set<string>([root.id]);
  let frontier = [root.id];
  for (let depth = 1; frontier.length > 0; depth++) {
    const children: FolderNode[] = await db.folder.findMany({
      where: { mailboxId: root.mailboxId, parentId: { in: frontier } },
      select: { id: true, name: true, parentId: true },
    });
    frontier = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, depth });
      frontier.push(c.id);
    }
  }
  return out;
}

/** Counts shown to the user before a delete (and in the 409 answers). */
export async function summarizeFolderTree(folder: FolderRef, protectedNames: ReadonlySet<string>): Promise<FolderTreeSummary> {
  const tree = await folderSubtree(prisma, folder);
  const count = tree.length === 0 ? 0 : await prisma.message.count({
    where: { folderId: { in: tree.map((f) => f.id) }, deletedAt: null },
  });
  const protectedNode = tree.find((f) => f.depth > 0 && protectedNames.has(f.name));
  return { subfolders: Math.max(tree.length - 1, 0), count, protectedInside: protectedNode?.name ?? null };
}

/** Pure decision: why a delete must not run yet (null = go ahead). */
export function decideFolderDelete(summary: FolderTreeSummary, opts: FolderDeleteOptions): FolderDeleteRefusal | null {
  const counts = { subfolders: summary.subfolders, count: summary.count };
  if (summary.protectedInside) {
    return { error: `Unterordner „${summary.protectedInside}" ist ein Systemordner und kann nicht gelöscht werden`, code: 'PROTECTED_SUBFOLDER', ...counts };
  }
  if (summary.subfolders > 0 && !opts.recursive) {
    return { error: 'Ordner hat Unterordner', code: 'FOLDER_HAS_SUBFOLDERS', ...counts };
  }
  if (summary.count > 0 && !opts.force) {
    return { error: 'Ordner nicht leer', code: 'FOLDER_NOT_EMPTY', ...counts };
  }
  return null;
}

/** Reads `?recursive=true` / `?force=true` from a request query. */
export function folderDeleteOptions(query: Record<string, unknown>): FolderDeleteOptions {
  return { recursive: query['recursive'] === 'true', force: query['force'] === 'true' };
}

export async function folderDeleteRefusal(
  folder: FolderRef, opts: FolderDeleteOptions, protectedNames: ReadonlySet<string>,
): Promise<FolderDeleteRefusal | null> {
  return decideFolderDelete(await summarizeFolderTree(folder, protectedNames), opts);
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

async function deleteBottomUp(tx: MessageStoreTx, tree: Array<{ id: string; depth: number }>): Promise<void> {
  const deepestFirst = [...tree].sort((a, b) => b.depth - a.depth);
  for (const f of deepestFirst) await tx.folder.delete({ where: { id: f.id } });
}

/**
 * Moves the messages of the folder and all its subfolders to the mailbox Trash
 * (message store), then deletes the now empty folders, deepest first.
 * `ok: false` (nothing changed) when the subtree still holds messages and the
 * mailbox has no Trash folder outside the subtree.
 */
export async function deleteFolderTree(folder: FolderRef): Promise<FolderDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const tree = await folderSubtree(tx, folder);
    const ids = tree.map((f) => f.id);
    const rows = ids.length === 0 ? [] : await tx.message.findMany({
      where: { folderId: { in: ids } }, select: { id: true, deletedAt: true },
    });
    const liveIds = rows.filter((m) => m.deletedAt === null).map((m) => m.id);
    if (rows.length === 0) {
      await deleteBottomUp(tx, tree);
      return { ok: true, moved: 0, expunged: 0, live: 0, folders: tree.length };
    }
    const trash = await tx.folder.findFirst({ where: { mailboxId: folder.mailboxId, name: 'Trash' }, select: { id: true } });
    if (!trash || ids.includes(trash.id)) return { ok: false, moved: 0, expunged: 0, live: liveIds.length, folders: 0 };

    const insideTrash = await isInsideFolder(tx, folder.parentId, trash.id);
    if (insideTrash && liveIds.length > 0) {
      await expunge(tx, liveIds, { mailboxId: folder.mailboxId, where: { folderId: { in: ids }, deletedAt: null } });
    }
    await moveMessages(tx, rows.map((m) => m.id), trash.id, {
      targetMailboxId: folder.mailboxId, sourceMailboxId: folder.mailboxId,
    });
    await deleteBottomUp(tx, tree);
    return { ok: true, moved: rows.length, expunged: insideTrash ? liveIds.length : 0, live: liveIds.length, folders: tree.length };
  });
}
