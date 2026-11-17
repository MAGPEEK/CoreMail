/**
 * Spacing / density tokens shared by the app pages (Mail, Kalender, Kontakte,
 * Aufgaben, Notizen) through components/PageShell.tsx: every page gets the same
 * header row height, gutters and content padding. No imports — unit-tested with
 * `node --test`.
 */

/** Page root inside the horizontal <main>: fills the row and may shrink (see mailLayout.ts). */
export const PAGE_SHELL_CLASS = 'flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden bg-canvas';

/** Header row: page title + page actions (or the command bar); gutter: px-4, with a command bar px-2. */
export const PAGE_HEADER_CLASS = 'shrink-0 flex items-center gap-3 min-h-12 py-1.5 border-b border-line bg-surface';

export const PAGE_TITLE_CLASS = 'text-base font-semibold text-fg truncate';

/** Area below the header: side panes + content side by side. */
export const PAGE_BODY_CLASS = 'flex flex-1 min-w-0 min-h-0 overflow-hidden';

/** Padding of scrolling page content (lists, grids, the calendar). */
export const PAGE_CONTENT_PAD = 'p-4';
