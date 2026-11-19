/**
 * 10.1: short folder lists of the folder pane and the ribbon.
 *
 * Favourites ("Favoriten" at the top of the folder pane) are the roaming
 * preference `folders.favorites`: an entry is a folder id, or the name of a
 * default folder (INBOX, Sent, Drafts, Trash, …) so the default list
 * (Posteingang, Gesendete Elemente, Entwürfe, Gelöschte Elemente) works before
 * the folders are known. Folders flagged as favourite before 10.1
 * (`Folder.isFavorite`) are shown after the list until they are removed.
 *
 * Recent folders ("Verschieben in" of the ribbon) are the last move targets of
 * this session, newest first.
 * No imports — unit-tested with `node --test`.
 */

/** What these helpers need of a folder. */
export interface FolderRef {
  id: string;
  name: string;
  isSystem?: boolean;
  isFavorite?: boolean;
}

/** Default folders that are referred to by name. */
export const DEFAULT_FOLDER_NAMES: ReadonlySet<string> = new Set(['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']);
export const MAX_FAVORITES = 50;
export const MAX_RECENT_FOLDERS = 5;

/** The preference entry of a folder: its name for a default folder, else its id. */
export function favoriteEntryOf(f: FolderRef): string {
  return DEFAULT_FOLDER_NAMES.has(f.name) && f.isSystem !== false ? f.name : f.id;
}

function matches(entry: string, f: FolderRef): boolean {
  return f.id === entry || (DEFAULT_FOLDER_NAMES.has(entry) && f.name === entry && f.isSystem !== false);
}

/** Favourite folders in order: the preference list (entries without a folder skipped), then legacy flags. */
export function favoriteFolders<F extends FolderRef>(entries: readonly string[], folders: readonly F[]): F[] {
  const out: F[] = [];
  const seen = new Set<string>();
  const add = (f: F | undefined) => { if (f && !seen.has(f.id)) { seen.add(f.id); out.push(f); } };
  for (const entry of entries) add(folders.find((f) => matches(entry, f)));
  for (const f of folders) if (f.isFavorite) add(f);
  return out;
}

export function isFavorite(entries: readonly string[], folder: FolderRef): boolean {
  return entries.some((e) => matches(e, folder)) || !!folder.isFavorite;
}

/** Preference list with the folder added at the end (no duplicates, bounded). */
export function addFavorite(entries: readonly string[], folder: FolderRef): string[] {
  if (entries.some((e) => matches(e, folder))) return [...entries];
  return [...entries, favoriteEntryOf(folder)].slice(0, MAX_FAVORITES);
}

/** Preference list without the folder (by id or default-folder name). */
export function removeFavorite(entries: readonly string[], folder: FolderRef): string[] {
  return entries.filter((e) => !matches(e, folder));
}

/** Drops entries whose folder is gone (deleted) — keeps default-folder names. */
export function pruneFavorites(entries: readonly string[], folders: readonly FolderRef[]): string[] {
  return entries.filter((e) => DEFAULT_FOLDER_NAMES.has(e) || folders.some((f) => f.id === e));
}

/** Recent move targets, newest first, without duplicates. */
export function pushRecentFolder(recent: readonly string[], folderId: string, max = MAX_RECENT_FOLDERS): string[] {
  return [folderId, ...recent.filter((id) => id !== folderId)].slice(0, max);
}
