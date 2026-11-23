/**
 * 9.3: layout contract of the mail view. `<main>` (App.tsx Layout) is a horizontal
 * flex container — a page root must claim the remaining width (`flex-1`) and be
 * allowed to shrink (`min-w-0`), otherwise it renders only as wide as its content
 * (the pre-9.3 shared-mailbox page was 637 px wide on a 1440 px screen).
 * No imports — unit-tested with `node --test`.
 */
export const MAIL_VIEW_ROOT_CLASS = 'flex flex-1 min-w-0 overflow-hidden relative';

/** 9.4: the mail view as a column inside the page body row (10.7: the draft tabs moved into the content card). */
export const MAIL_VIEW_COLUMN_CLASS = 'flex flex-col flex-1 min-w-0 min-h-0 md:gap-2';

/** 10.7: the draft tab strip — a tab row at the top of the content card. */
export const DRAFT_STRIP_CLASS = 'shrink-0 border-b border-line bg-surface-2 px-2 pt-1.5 pb-1 coremail-no-print';

/**
 * 10.7: where the draft tab strip goes. At the top of the content card (the
 * shown draft or the reading pane); when no content card is on screen (reading
 * pane off, or the phone shows the list), above the list card; nowhere without
 * open drafts.
 */
export function draftStripPlace(openDrafts: number, panes: readonly string[]): 'content' | 'list' | 'none' {
  if (openDrafts === 0) return 'none';
  if (panes.includes('compose') || panes.includes('reader')) return 'content';
  return 'list';
}

/** True when a className fills a horizontal flex parent and may shrink below its content width. */
export function fillsFlexRow(className: string): boolean {
  const cls = new Set(className.split(/\s+/).filter(Boolean));
  return cls.has('flex-1') && (cls.has('min-w-0') || cls.has('w-full'));
}
