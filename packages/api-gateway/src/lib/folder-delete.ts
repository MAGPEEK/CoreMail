/**
 * REST folder delete rules (9.3 review A1; subfolders: 9.4). The delete itself —
 * mail of the deleted folder(s) to Trash through the message store, no orphaned
 * subfolders — is `deleteFolderMovingMail()` in @coremail/storage (also used by
 * IMAP DELETE).
 *
 * The routes decide first (`folderDeleteRefusal()`):
 *  - without `?recursive=true` only the folder itself is deleted. Its direct
 *    subfolders move up to its parent (`subfolders: 'reparent'`: own mailbox and
 *    the pre-9.3 compat route, as in 9.3 where they stayed, but no longer at the
 *    top level) or the delete is refused with 409 FOLDER_HAS_SUBFOLDERS
 *    (`subfolders: 'refuse'`: the 9.3 shared/delegated routes);
 *  - with `?recursive=true` the folder and all its subfolders are deleted; a
 *    system folder inside the subtree is never deleted (409 PROTECTED_SUBFOLDER);
 *  - live mail in what is deleted needs `?force=true` (409 FOLDER_NOT_EMPTY;
 *    the compat route implies it, as before).
 */
import { prisma, folderSubtree, deleteFolderMovingMail, type FolderDeleteResult } from '@coremail/storage';

export interface FolderRef { id: string; mailboxId: string }

export interface FolderTreeSummary {
  /** Number of subfolders at any depth. */
  subfolders: number;
  /** Live messages in the folder and all its subfolders. */
  count: number;
  /** Live messages in the folder itself. */
  ownCount: number;
  /** Name of a protected folder inside the subtree (excluding the folder itself), if any. */
  protectedInside: string | null;
}

export interface FolderDeleteOptions {
  /** Delete subfolders too (`?recursive=true`). */
  recursive: boolean;
  /** Delete although live mail would move to Trash (`?force=true`). */
  force: boolean;
}

/** What a route does with subfolders when `recursive` is not set. */
export type SubfolderPolicy = 'reparent' | 'refuse';

export type FolderDeleteRefusalCode = 'FOLDER_HAS_SUBFOLDERS' | 'PROTECTED_SUBFOLDER' | 'FOLDER_NOT_EMPTY';
export interface FolderDeleteRefusal {
  error: string;
  code: FolderDeleteRefusalCode;
  subfolders: number;
  count: number;
}

/** Counts shown to the user before a delete (and in the 409 answers). */
export async function summarizeFolderTree(folder: FolderRef, protectedNames: ReadonlySet<string>): Promise<FolderTreeSummary> {
  const tree = await folderSubtree(prisma, folder);
  if (tree.length === 0) return { subfolders: 0, count: 0, ownCount: 0, protectedInside: null };
  const ownCount = await prisma.message.count({ where: { folderId: folder.id, deletedAt: null } });
  const count = tree.length === 1 ? ownCount : await prisma.message.count({
    where: { folderId: { in: tree.map((f) => f.id) }, deletedAt: null },
  });
  const protectedNode = tree.find((f) => f.depth > 0 && protectedNames.has(f.name));
  return { subfolders: tree.length - 1, count, ownCount, protectedInside: protectedNode?.name ?? null };
}

/** Pure decision: why a delete must not run yet (null = go ahead). */
export function decideFolderDelete(
  summary: FolderTreeSummary, opts: FolderDeleteOptions, subfolders: SubfolderPolicy,
): FolderDeleteRefusal | null {
  const counts = { subfolders: summary.subfolders, count: summary.count };
  if (opts.recursive) {
    if (summary.protectedInside) {
      return { error: `Unterordner „${summary.protectedInside}" ist ein Systemordner und kann nicht gelöscht werden`, code: 'PROTECTED_SUBFOLDER', ...counts };
    }
    if (summary.count > 0 && !opts.force) return { error: 'Ordner nicht leer', code: 'FOLDER_NOT_EMPTY', ...counts };
    return null;
  }
  if (summary.subfolders > 0 && subfolders === 'refuse') {
    return { error: 'Ordner hat Unterordner', code: 'FOLDER_HAS_SUBFOLDERS', ...counts };
  }
  if (summary.ownCount > 0 && !opts.force) {
    return { error: 'Ordner nicht leer', code: 'FOLDER_NOT_EMPTY', subfolders: summary.subfolders, count: summary.ownCount };
  }
  return null;
}

/** Reads `?recursive=true` / `?force=true` from a request query. */
export function folderDeleteOptions(query: Record<string, unknown>): FolderDeleteOptions {
  return { recursive: query['recursive'] === 'true', force: query['force'] === 'true' };
}

export async function folderDeleteRefusal(
  folder: FolderRef, opts: FolderDeleteOptions, protectedNames: ReadonlySet<string>, subfolders: SubfolderPolicy,
): Promise<FolderDeleteRefusal | null> {
  return decideFolderDelete(await summarizeFolderTree(folder, protectedNames), opts, subfolders);
}

/** Runs the delete the routes decided on (see @coremail/storage folder-delete.ts). */
export function deleteFolder(folder: FolderRef, opts: FolderDeleteOptions): Promise<FolderDeleteResult> {
  return deleteFolderMovingMail(prisma, folder, opts.recursive ? 'recursive' : 'reparent');
}

/** HTTP answer for a delete that changed nothing (`ok: false`). */
export function folderDeleteFailure(done: FolderDeleteResult): { status: number; error: string } {
  return done.reason === 'not-found'
    ? { status: 404, error: 'Ordner nicht gefunden' }
    : { status: 409, error: 'Papierkorb nicht gefunden' };
}
