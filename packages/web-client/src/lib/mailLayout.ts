/**
 * 9.3: layout contract of the mail view. `<main>` (App.tsx Layout) is a horizontal
 * flex container — a page root must claim the remaining width (`flex-1`) and be
 * allowed to shrink (`min-w-0`), otherwise it renders only as wide as its content
 * (the pre-9.3 shared-mailbox page was 637 px wide on a 1440 px screen).
 * No imports — unit-tested with `node --test`.
 */
export const MAIL_VIEW_ROOT_CLASS = 'flex flex-1 min-w-0 overflow-hidden relative';

/** 9.4: the mail view above the draft tab strip (column inside the page body row). */
export const MAIL_VIEW_COLUMN_CLASS = 'flex flex-col flex-1 min-w-0 min-h-0';

/** True when a className fills a horizontal flex parent and may shrink below its content width. */
export function fillsFlexRow(className: string): boolean {
  const cls = new Set(className.split(/\s+/).filter(Boolean));
  return cls.has('flex-1') && (cls.has('min-w-0') || cls.has('w-full'));
}
