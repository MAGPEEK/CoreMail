/**
 * 9.4: open drafts of the webmail (inline compose + tab strip). One draft is
 * active (shown in the reading pane) or none (the reader is shown); every open
 * draft has a tab. Pure state transitions — unit-tested with `node --test`.
 *
 *   open ──▶ active ──minimise / open a mail / open another draft──▶ in the strip
 *     ▲                                                                  │
 *     └──────────────────────── activate (tab click) ◀───────────────────┘
 *   active / in the strip ──close (✕, Esc, send, discard, pop out)──▶ gone
 */

export interface ComposeTab<C> {
  key: string;
  ctx: C;
  /** Current server draft id (changes with every save), null = not saved yet. */
  draftId: string | null;
  /** Subject as typed (the strip shows a fallback when empty). */
  subject: string;
}

export interface ComposeTabsState<C> {
  tabs: ComposeTab<C>[];
  activeKey: string | null;
}

export const NO_COMPOSE: ComposeTabsState<never> = Object.freeze({ tabs: [], activeKey: null }) as ComposeTabsState<never>;

export interface OpenOptions {
  /** Open without showing it (a draft reopened while another one is being written). */
  background?: boolean;
}

/**
 * Opens a draft. A server draft that already has a tab is not opened twice —
 * its tab is shown instead (two editors on one draft would supersede each other).
 */
export function openTab<C extends { draftId?: string }>(
  s: ComposeTabsState<C>, key: string, ctx: C, subject: string, opts: OpenOptions = {},
): ComposeTabsState<C> {
  const existing = ctx.draftId ? s.tabs.find((t) => t.draftId === ctx.draftId) : undefined;
  if (existing) return opts.background ? s : { ...s, activeKey: existing.key };
  const tab: ComposeTab<C> = { key, ctx, draftId: ctx.draftId ?? null, subject };
  return { tabs: [...s.tabs, tab], activeKey: opts.background ? s.activeKey : key };
}

export function activateTab<C>(s: ComposeTabsState<C>, key: string): ComposeTabsState<C> {
  if (s.activeKey === key || !s.tabs.some((t) => t.key === key)) return s;
  return { ...s, activeKey: key };
}

/** The active draft goes to the strip; the reader is shown again. */
export function minimiseTabs<C>(s: ComposeTabsState<C>): ComposeTabsState<C> {
  return s.activeKey === null ? s : { ...s, activeKey: null };
}

export function closeTab<C>(s: ComposeTabsState<C>, key: string): ComposeTabsState<C> {
  if (!s.tabs.some((t) => t.key === key)) return s;
  return { tabs: s.tabs.filter((t) => t.key !== key), activeKey: s.activeKey === key ? null : s.activeKey };
}

export type TabPatch<C> = Partial<Pick<ComposeTab<C>, 'ctx' | 'draftId' | 'subject'>>;

export function updateTab<C>(s: ComposeTabsState<C>, key: string, patch: TabPatch<C>): ComposeTabsState<C> {
  if (!s.tabs.some((t) => t.key === key)) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) };
}

export function activeTab<C>(s: ComposeTabsState<C>): ComposeTab<C> | undefined {
  return s.activeKey === null ? undefined : s.tabs.find((t) => t.key === s.activeKey);
}

/** Selecting another message in the list while a draft is shown minimises the draft. */
export function onMessageSelected<C>(s: ComposeTabsState<C>, previousId: string | null, nextId: string | null): ComposeTabsState<C> {
  return nextId !== null && nextId !== previousId ? minimiseTabs(s) : s;
}

/** Text of a tab: the subject, else the fallback ("(Kein Betreff)"). */
export function tabTitle(subject: string, fallback: string): string {
  return subject.trim() || fallback;
}
