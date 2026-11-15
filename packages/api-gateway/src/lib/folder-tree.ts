/**
 * Folder re-parenting check (8.0.x): the new parent must exist in the SAME
 * mailbox and must not be the folder itself or one of its descendants
 * (cycle). Mirrors the check in routes/user.ts (PATCH /user/folders/:id).
 */
export interface FolderLookup {
  folder: {
    findUnique(args: { where: { id: string }; select: { parentId: true; mailboxId: true } }):
      Promise<{ parentId: string | null; mailboxId: string } | null>;
  };
}

export type ParentCheck = { ok: true } | { ok: false; status: 400 | 404; error: string };

/** Max. depth walked before the hierarchy is treated as corrupt. */
const MAX_DEPTH = 256;

export async function checkFolderParent(
  db: FolderLookup,
  folderId: string,
  parentId: string,
  mailboxId: string,
): Promise<ParentCheck> {
  if (parentId === folderId) return { ok: false, status: 400, error: 'A folder cannot be its own parent' };
  const visited = new Set<string>([folderId]);
  let cursor: string | null = parentId;
  for (let depth = 0; cursor; depth++) {
    if (visited.has(cursor) || depth > MAX_DEPTH) {
      return { ok: false, status: 400, error: 'Cycle in folder hierarchy' };
    }
    visited.add(cursor);
    const row: { parentId: string | null; mailboxId: string } | null =
      await db.folder.findUnique({ where: { id: cursor }, select: { parentId: true, mailboxId: true } });
    if (!row) {
      // the requested parent itself must exist; a dangling ancestor ends the walk
      if (cursor === parentId) return { ok: false, status: 404, error: 'Parent folder not found' };
      break;
    }
    if (row.mailboxId !== mailboxId) {
      return cursor === parentId
        ? { ok: false, status: 404, error: 'Parent folder not found' }
        : { ok: false, status: 400, error: 'Parent folder belongs to another mailbox' };
    }
    cursor = row.parentId;
  }
  return { ok: true };
}
