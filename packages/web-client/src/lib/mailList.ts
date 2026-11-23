/**
 * 10.7: the list card of the mail view (three columns). Its header row holds the
 * folder name (+ unread count), Sync and the Ansicht menu; below it the only
 * search field of the webmail, then the filter row — replaced by the selection
 * bar (lib/mailCommands.ts SELECTION_BAR) while messages are checked — and a
 * status line at the bottom (count, selected, sort toggle).
 * Pure — unit-tested with `node --test`.
 */
import type { TranslationKey } from '../i18n/translations.ts';
import type { SortDir, SortField } from './preferences.ts';

/** Commands of the list header, in order ("folders" = the folder drawer, two-column mode only). */
export const LIST_HEADER = ['folders', 'sync', 'view'] as const;
export type ListHeaderId = typeof LIST_HEADER[number];

/** Entries of the Ansicht menu, in order (Drucken is not here — it acts on the open message). */
export const VIEW_MENU = ['conversations', 'sort', 'readingPane', 'density', 'markAllRead', 'viewSettings'] as const;
export type ViewMenuId = typeof VIEW_MENU[number];

/** What the search field of the list card offers. */
export const LIST_SEARCH = ['search', 'searchScope', 'searchSuggestions', 'searchOperators', 'searchChips'] as const;

/** The status line at the bottom of the list card. */
export const LIST_STATUS = ['count', 'selected', 'sort'] as const;

/** Quick filters of the filter row (shown while nothing is checked). */
export const LIST_FILTERS = ['all', 'unread', 'flagged', 'attachments'] as const;

export const SORT_FIELD_LABEL: Record<SortField, TranslationKey> = {
  date: 'view_sort_date',
  from: 'view_sort_from',
  subject: 'view_sort_subject',
  size: 'view_sort_size',
};

/** The sort toggle of the status line flips the direction of the current field. */
export function toggledSortDir(dir: SortDir): SortDir {
  return dir === 'asc' ? 'desc' : 'asc';
}

/**
 * Count of the status line: the server total for the plain list, the loaded
 * rows otherwise (a quick filter or a search narrows what is loaded).
 */
export function statusCount(filter: string, total: number, shown: number): number {
  return filter === 'all' ? total : shown;
}

/** Name of the shown folder in the list header (the search scope "Alle" names the mailbox). */
export function listHeading(folderName: string | null | undefined, searchingAll: boolean, allLabel: string): string {
  if (searchingAll) return allLabel;
  return folderName ?? '';
}
