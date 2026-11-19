/**
 * Pure logic of the BCP folder-permission list: which folders carry explicit
 * grants and the type-ahead search of the "Ordner freigeben…" picker.
 */
import {
  ANONYMOUS_KEY, DEFAULT_KEY, folderDisplayName,
  type FolderPermissionsOverview, type PermissionEntry,
} from './folderPermissions.ts';

/** Most hits the picker lists; a longer query narrows them down. */
export const MAX_FOLDER_HITS = 50;

export interface FolderChoice {
  id: string;
  /** Display name of the folder itself. */
  label: string;
  /** Full path, e.g. "Posteingang / Projekte / 2026". */
  path: string;
}

/** True when the folder has a grant beyond the always-present Anonymous entry and a "Keine" Default. */
export function hasExplicitGrants(entries: readonly PermissionEntry[]): boolean {
  return entries.some((e) => {
    if (e.granteeKey === ANONYMOUS_KEY) return false;
    return e.granteeKey !== DEFAULT_KEY || e.rights !== 0;
  });
}

export function foldersWithGrants(folders: readonly FolderPermissionsOverview[]): FolderPermissionsOverview[] {
  return folders.filter((f) => hasExplicitGrants(f.entries));
}

/** Path of every folder through its parents; a parent cycle or missing parent ends the path. */
export function folderChoices(folders: readonly FolderPermissionsOverview[]): FolderChoice[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return folders.map((f) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur: FolderPermissionsOverview | undefined = f;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(folderDisplayName(cur.name));
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return { id: f.id, label: folderDisplayName(f.name), path: names.join(' / ') };
  });
}

/** Case-insensitive match of every query word against the path; at most MAX_FOLDER_HITS, path-sorted. */
export function searchFolders(choices: readonly FolderChoice[], query: string): FolderChoice[] {
  const words = query.toLocaleLowerCase('de').split(/\s+/).filter(Boolean);
  return choices
    .filter((c) => {
      const path = c.path.toLocaleLowerCase('de');
      return words.every((w) => path.includes(w));
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'de'))
    .slice(0, MAX_FOLDER_HITS);
}

/** Next highlighted index of a listbox for ArrowDown/ArrowUp, wrapping; -1 when the list is empty. */
export function moveHighlight(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
