/**
 * Responsive layout of the webmail (9.5): below 768 px a single pane at a time,
 * 768–1100 px two panes, above the full three-pane layout. The mail view is a
 * small state machine over the layout mode and what is selected.
 * No imports — unit-tested with `node --test`.
 */

export type LayoutMode = 'single' | 'two' | 'three';
export type MailPane = 'folders' | 'list' | 'reader' | 'compose';
export type ReadingPanePref = 'right' | 'bottom' | 'off';

/** Widest viewport (px) of the single-pane layout — Tailwind's `md` (768) minus one. */
export const SINGLE_PANE_MAX = 767;
/** Widest viewport (px) of the two-pane layout. */
export const TWO_PANE_MAX = 1099;

export function layoutModeForWidth(width: number): LayoutMode {
  if (width <= SINGLE_PANE_MAX) return 'single';
  if (width <= TWO_PANE_MAX) return 'two';
  return 'three';
}

export interface MailPaneState {
  mode: LayoutMode;
  hasFolder: boolean;
  hasMessage: boolean;
  composeOpen: boolean;
  /** Single pane: the folder list is shown (the user stepped back from the list). */
  foldersShown: boolean;
  readingPane: ReadingPanePref;
}

/** Panes on screen next to each other (in the two-pane layout the folders are a drawer, not listed). */
export function visibleMailPanes(s: MailPaneState): MailPane[] {
  if (s.mode === 'three') return ['folders', ...contentPanes(s)];
  if (s.mode === 'two') {
    const panes = contentPanes(s);
    return panes.length > 0 ? panes : ['folders'];
  }
  if (s.composeOpen) return ['compose'];
  if (s.hasMessage) return ['reader'];
  return [s.foldersShown || !s.hasFolder ? 'folders' : 'list'];
}

function contentPanes(s: MailPaneState): MailPane[] {
  if (!s.hasFolder) return s.composeOpen ? ['compose'] : [];
  if (s.readingPane === 'off') return s.composeOpen ? ['compose'] : ['list'];
  return ['list', s.composeOpen ? 'compose' : 'reader'];
}

/** Single pane: the pane the back button leads to, or null on the first level. */
export function backTarget(pane: MailPane): MailPane | null {
  if (pane === 'reader') return 'list';
  if (pane === 'list') return 'folders';
  return null;
}
