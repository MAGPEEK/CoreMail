/**
 * Folder delete in the webmail (own, shared and delegated mailboxes).
 *
 * The server deletes subfolders only with `?recursive=true` and moves the mail of
 * the whole subtree to Trash (`?force=true` for live mail). The confirmation shows
 * what goes: number of subfolders (any depth) and messages of the subtree, taken
 * from the folder list the webmail already holds (real parentId links only — the
 * folder pane's virtual "below INBOX" placement does not count).
 * `recursive` is sent only when the user saw subfolders; if one appeared since
 * (another client), the server answers 409 FOLDER_HAS_SUBFOLDERS and the user
 * confirms again with the refreshed list.
 */

export interface FolderNodeLike {
  id: string;
  parentId?: string | null;
  totalCount?: number;
}

export interface FolderDeleteSummary {
  /** Subfolders at any depth. */
  subfolders: number;
  /** Messages in the folder and all its subfolders. */
  count: number;
}

export function summarizeFolderSubtree(folderId: string, all: readonly FolderNodeLike[]): FolderDeleteSummary {
  const byParent = new Map<string, FolderNodeLike[]>();
  for (const f of all) {
    if (!f.parentId) continue;
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const root = all.find((f) => f.id === folderId);
  let count = root?.totalCount ?? 0;
  let subfolders = 0;
  const seen = new Set<string>([folderId]);
  const stack = [...(byParent.get(folderId) ?? [])];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    subfolders++;
    count += f.totalCount ?? 0;
    stack.push(...(byParent.get(f.id) ?? []));
  }
  return { subfolders, count };
}

/** Query string for DELETE …/folders/:id after the user confirmed `summary`. */
export function folderDeleteQuery(summary: FolderDeleteSummary): string {
  return summary.subfolders > 0 ? '?force=true&recursive=true' : '?force=true';
}

export type FolderDeleteConfirmKey = 'folder_delete_confirm' | 'folder_delete_confirm_mail' | 'folder_delete_confirm_tree';

/** Translation key of the confirmation; placeholders {name}, {count}, {subfolders}. */
export function folderDeleteConfirmKey(summary: FolderDeleteSummary): FolderDeleteConfirmKey {
  if (summary.subfolders > 0) return 'folder_delete_confirm_tree';
  return summary.count > 0 ? 'folder_delete_confirm_mail' : 'folder_delete_confirm';
}

/** The server refused because subfolders exist that the user did not see. */
export function isStaleSubfolderRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'FOLDER_HAS_SUBFOLDERS';
}
