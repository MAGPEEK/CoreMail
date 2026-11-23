/**
 * Spacing / density tokens shared by the app pages (Mail, Kalender, Kontakte,
 * Aufgaben, Notizen) through components/PageShell.tsx: every page gets the same
 * header row height, gutters and content padding. 10.1: the page floats on the
 * canvas (lib/paneLayout.ts) — the header is a card, the body is a card (or,
 * for the mail view, the row of its pane cards). Imports only paneLayout —
 * unit-tested with `node --test`.
 */
import { PANE_CANVAS_CLASS, PANE_CARD_BASE } from './paneLayout.ts';

/** Page root inside the horizontal <main>: fills the row and may shrink (see mailLayout.ts). */
export const PAGE_SHELL_CLASS = `flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden ${PANE_CANVAS_CLASS}`;

/** Header row: page title + page actions (or the command bar); gutter: px-4, with a command bar px-2. */
export const PAGE_HEADER_CLASS = `shrink-0 flex items-center gap-3 min-h-12 py-1.5 max-md:border-b bg-surface ${PANE_CARD_BASE}`;

export const PAGE_TITLE_CLASS = 'text-base font-semibold text-fg truncate';

/** Area below the header: side panes + content side by side. */
export const PAGE_BODY_CLASS = 'flex flex-1 min-w-0 min-h-0 overflow-hidden';

/** The body as one card (calendar, contacts, tasks, notes); its own tint, else the surface. */
export function pageBodyCardClass(bodyClassName: string): string {
  return `${PAGE_BODY_CLASS} ${PANE_CARD_BASE} ${/(^|\s)bg-/.test(bodyClassName) ? bodyClassName : `bg-surface ${bodyClassName}`}`.trim();
}

/** Padding of scrolling page content (lists, grids, the calendar). */
export const PAGE_CONTENT_PAD = 'p-4';
