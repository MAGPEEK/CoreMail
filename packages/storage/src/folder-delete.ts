/**
 * Deleting a mail folder without losing mail — shared by the REST routes
 * (api-gateway lib/folder-delete.ts) and IMAP DELETE.
 *
 * `Message.folder` is `onDelete: Cascade`: a plain `folder.delete()` on a folder
 * that still holds messages removes them for good — no tombstone, no modSeq,
 * invisible to IMAP CONDSTORE/QRESYNC, JMAP /changes and ActiveSync, and not
 * recoverable. And the FolderTree relation sets the parentId of remaining
 * subfolders to null, so they would jump to the top level. So before any folder
 * row goes, every message in it (live ones AND tombstones of recoverable items)
 * is moved into the mailbox's Trash through the message store (new UIDs + modSeq):
 *  - folder outside Trash: live messages become live messages in Trash;
 *  - folder inside Trash (isInsideTrash: below it via parentId OR by name, e.g. an
 *    IMAP-created `Trash.Old` without a parent link): live messages are expunged
 *    first (tombstone, recoverable for DELETED_ITEM_RETENTION_DAYS), then moved;
 *  - tombstones keep `deletedAt`, so they stay recoverable.
 *
 * Two modes for the subfolders (parentId links):
 *  - `reparent`: only the folder itself is deleted; its direct subfolders move up
 *    to the folder's parent (top level when it had none). This is the pre-9.4 REST
 *    default and the IMAP rule (deleting a name never removes its inferiors);
 *  - `recursive`: the folder and all its subfolders are deleted, deepest first.
 *
 * Everything runs in one transaction; without a Trash folder (or when Trash itself
 * would be deleted) a folder that still holds messages is left unchanged.
 * The module only uses the client it is given (fake-friendly: findFirst/findMany/
 * updateMany/delete on folder, findMany/updateMany/update on message).
 */
import { moveMessages, expunge, type MessageStoreTx } from './message-store.js';
import { announceFolderListChange } from './realtime/change-scope.js';

export interface FolderDeleteTarget { id: string; mailboxId: string }
export interface FolderNode { id: string; name: string; parentId: string | null; depth: number }
export type FolderDeleteMode = 'reparent' | 'recursive';

/** The part of the Prisma client the delete needs (prisma itself satisfies it). */
export interface FolderDeleteDb {
  $transaction<T>(fn: (tx: MessageStoreTx) => Promise<T>): Promise<T>;
}

export interface FolderDeleteResult {
  ok: boolean;
  /** Why nothing was changed (`ok: false`). */
  reason: 'not-found' | 'no-trash' | null;
  /** Messages moved into Trash (live + tombstones). */
  moved: number;
  /** Live messages expunged (tombstoned) first because the folder was inside Trash. */
  expunged: number;
  /** Live messages in the deleted folder(s) (what the user saw). */
  live: number;
  /** Folders deleted. */
  folders: number;
  /** Direct subfolders moved up to the deleted folder's parent (`reparent` mode). */
  reparented: number;
}

type FolderReader = Pick<MessageStoreTx, 'folder'>;
const NODE_SELECT = { id: true, name: true, parentId: true } as const;

async function findRoot(db: FolderReader, target: FolderDeleteTarget): Promise<FolderNode | null> {
  const row: { id: string; name: string; parentId: string | null } | null = await db.folder.findFirst({
    where: { id: target.id, mailboxId: target.mailboxId }, select: NODE_SELECT,
  });
  return row ? { id: row.id, name: row.name, parentId: row.parentId ?? null, depth: 0 } : null;
}

/** The folder and all its descendants in the same mailbox, parents before children. */
export async function folderSubtree(db: FolderReader, target: FolderDeleteTarget): Promise<FolderNode[]> {
  const root = await findRoot(db, target);
  if (!root) return [];
  const out: FolderNode[] = [root];
  const seen = new Set<string>([root.id]);
  let frontier = [root.id];
  for (let depth = 1; frontier.length > 0; depth++) {
    const children: Array<{ id: string; name: string; parentId: string | null }> = await db.folder.findMany({
      where: { mailboxId: target.mailboxId, parentId: { in: frontier } }, select: NODE_SELECT,
    });
    frontier = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, parentId: c.parentId ?? null, depth });
      frontier.push(c.id);
    }
  }
  return out;
}

/** Hierarchy delimiter of stored folder names (IMAP personal namespace): `Trash.Old` is below `Trash`. */
export const FOLDER_NAME_DELIMITER = '.';

/** Pure: is `name` below `ancestorName` in the name hierarchy? */
export function isBelowByName(name: string, ancestorName: string): boolean {
  return name.startsWith(ancestorName + FOLDER_NAME_DELIMITER);
}

/**
 * Is the folder inside Trash? One rule for both ways folders nest: a parentId
 * chain that reaches Trash (webmail), or a name below `Trash` — the folder's own
 * or an ancestor's on the chain (IMAP CREATE `Trash.Old` sets no parentId).
 */
export async function isInsideTrash(
  tx: FolderReader, mailboxId: string, folder: Pick<FolderNode, 'name' | 'parentId'>, trash: { id: string; name: string },
): Promise<boolean> {
  if (isBelowByName(folder.name, trash.name)) return true;
  const seen = new Set<string>();
  let cursor = folder.parentId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === trash.id) return true;
    seen.add(cursor);
    const next: { name: string; parentId: string | null } | null = await tx.folder.findFirst({
      where: { id: cursor, mailboxId }, select: { name: true, parentId: true },
    });
    if (!next) return false;
    if (isBelowByName(next.name, trash.name)) return true;
    cursor = next.parentId ?? null;
  }
  return false;
}

function unchanged(reason: 'not-found' | 'no-trash', live = 0): FolderDeleteResult {
  return { ok: false, reason, moved: 0, expunged: 0, live, folders: 0, reparented: 0 };
}

interface MailMoved { moved: number; expunged: number; live: number }

/** Moves the messages of `ids` into Trash (`noTrash`: no usable Trash, nothing changed). */
async function moveMailToTrash(
  tx: MessageStoreTx, mailboxId: string, root: FolderNode, ids: string[],
): Promise<MailMoved | { noTrash: true; live: number }> {
  const rows: Array<{ id: string; deletedAt: Date | null }> = await tx.message.findMany({
    where: { folderId: { in: ids } }, select: { id: true, deletedAt: true },
  });
  const liveIds = rows.filter((m) => m.deletedAt === null).map((m) => m.id);
  if (rows.length === 0) return { moved: 0, expunged: 0, live: 0 };
  const trash: { id: string; name: string } | null = await tx.folder.findFirst({ where: { mailboxId, name: 'Trash' }, select: { id: true, name: true } });
  if (!trash || ids.includes(trash.id)) return { noTrash: true, live: liveIds.length };
  const insideTrash = await isInsideTrash(tx, mailboxId, root, trash);
  if (insideTrash && liveIds.length > 0) {
    await expunge(tx, liveIds, { mailboxId, where: { folderId: { in: ids }, deletedAt: null } });
  }
  await moveMessages(tx, rows.map((m) => m.id), trash.id, { targetMailboxId: mailboxId, sourceMailboxId: mailboxId });
  return { moved: rows.length, expunged: insideTrash ? liveIds.length : 0, live: liveIds.length };
}

/**
 * Deletes a folder (see the module comment for the modes). The folder is looked
 * up inside the transaction and must belong to `target.mailboxId`.
 */
export async function deleteFolderMovingMail(
  db: FolderDeleteDb, target: FolderDeleteTarget, mode: FolderDeleteMode,
): Promise<FolderDeleteResult> {
  return db.$transaction(async (tx) => {
    const doomed = mode === 'recursive' ? await folderSubtree(tx, target) : [await findRoot(tx, target)].filter((f): f is FolderNode => f !== null);
    const root = doomed[0];
    if (!root) return unchanged('not-found');
    const ids = doomed.map((f) => f.id);
    const mail = await moveMailToTrash(tx, target.mailboxId, root, ids);
    if ('noTrash' in mail) return unchanged('no-trash', mail.live);
    const reparented = mode === 'reparent'
      ? (await tx.folder.updateMany({ where: { mailboxId: target.mailboxId, parentId: root.id }, data: { parentId: root.parentId } })).count
      : 0;
    const deepestFirst = [...doomed].sort((a, b) => b.depth - a.depth);
    for (const f of deepestFirst) await tx.folder.delete({ where: { id: f.id } });
    announceFolderListChange(target.mailboxId);
    return { ok: true, reason: null, ...mail, folders: doomed.length, reparented };
  });
}
