import { fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import {
  summarizeFolderSubtree, folderDeleteConfirmKey, folderDeleteQuery, type FolderNodeLike,
} from '../lib/folderDelete.js';

/**
 * Asks before a folder delete, with the number of subfolders and messages that go
 * (lib/folderDelete.ts). Returns the query string for the DELETE request, or null
 * when the user cancelled.
 */
export function confirmFolderDelete(
  t: (key: TranslationKey) => string,
  name: string,
  folderId: string,
  all: readonly FolderNodeLike[],
): string | null {
  const summary = summarizeFolderSubtree(folderId, all);
  const text = fmt(t(folderDeleteConfirmKey(summary)), { name, count: summary.count, subfolders: summary.subfolders });
  return window.confirm(text) ? folderDeleteQuery(summary) : null;
}
