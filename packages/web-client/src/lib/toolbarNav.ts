/**
 * Keyboard + layout logic of toolbars (command bar, app rail) and their menus. No imports —
 * unit-tested with `node --test`.
 *
 * Roving focus follows the WAI-ARIA APG toolbar pattern: one tab stop, the arrow
 * keys move between the controls (wrapping), Home/End jump to the first/last one.
 * Disabled controls stay focusable (aria-disabled) so their reason can be read.
 */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

const PREV: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowLeft'],
  vertical: ['ArrowUp'],
  both: ['ArrowLeft', 'ArrowUp'],
};
const NEXT: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowRight'],
  vertical: ['ArrowDown'],
  both: ['ArrowRight', 'ArrowDown'],
};

/**
 * Index that receives focus after `key`, or null when the key is not a roving key
 * (the caller then leaves the event alone). `current` < 0 = nothing focused yet.
 */
export function nextRovingIndex(current: number, key: string, count: number, orientation: RovingOrientation): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (PREV[orientation].includes(key)) return current <= 0 ? count - 1 : current - 1;
  if (NEXT[orientation].includes(key)) return current < 0 || current >= count - 1 ? 0 : current + 1;
  return null;
}

export type CommandPlacement = 'auto' | 'pinned' | 'overflow';

export interface OverflowInput {
  /** Rendered width of every command (px), in toolbar order. */
  widths: readonly number[];
  /** pinned = always visible, overflow = always in the "…" menu, auto = visible while it fits */
  placements: readonly CommandPlacement[];
  /** Width the toolbar may use (px). */
  available: number;
  /** Width of the "…" button (px). */
  overflowButtonWidth: number;
}

/**
 * Which commands are shown in the bar (true) and which go to the "…" menu (false).
 * Commands keep their order: once an auto command does not fit, every later auto
 * command overflows too, so the menu always holds a contiguous tail. Pinned
 * commands stay visible even when the bar is too narrow.
 */
export function computeOverflow({ widths, placements, available, overflowButtonWidth }: OverflowInput): boolean[] {
  const n = widths.length;
  const placement = (i: number): CommandPlacement => placements[i] ?? 'auto';
  const inBar = (i: number) => placement(i) !== 'overflow';
  const forced = widths.some((_, i) => placement(i) === 'overflow');
  const barTotal = widths.reduce((sum, w, i) => sum + (inBar(i) ? w : 0), 0);
  if (!forced && barTotal <= available) return widths.map(() => true);

  let budget = available - overflowButtonWidth;
  for (let i = 0; i < n; i++) if (placement(i) === 'pinned') budget -= widths[i]!;
  let cut = false;
  return widths.map((w, i) => {
    const p = placement(i);
    if (p === 'pinned') return true;
    if (p === 'overflow' || cut) return false;
    if (w <= budget) { budget -= w; return true; }
    cut = true;
    return false;
  });
}

/** What a key does inside a menu (ContextMenu, the command bar's dropdowns). */
export type MenuKeyIntent =
  | { kind: 'move'; index: number }
  /** ArrowRight on an entry with a submenu: open it and focus its first entry */
  | { kind: 'open' }
  /** Submenu: ArrowLeft / Escape close only the submenu, focus goes back to its parent entry */
  | { kind: 'back' }
  /** Escape (top level) or Tab (any level): close the whole menu, focus returns to its button */
  | { kind: 'close' };

export interface MenuKeyContext {
  /** Index of the focused entry (−1 = none) and the number of entries. */
  current: number;
  count: number;
  /** The focused entry opens a submenu (and is not disabled). */
  canOpen: boolean;
  /** This menu is a submenu. */
  isSubmenu: boolean;
}

/**
 * Menu keyboard model (WAI-ARIA APG menu): ↑/↓ wrap, Home/End jump, → opens a
 * submenu, ← and Escape leave a submenu, Escape closes the top-level menu, Tab closes
 * every level. null = the key is not a menu key (it must not reach the page's
 * shortcuts either — the menu swallows it).
 */
export function menuKeyIntent(key: string, ctx: MenuKeyContext): MenuKeyIntent | null {
  const next = nextRovingIndex(ctx.current, key, ctx.count, 'vertical');
  if (next !== null) return { kind: 'move', index: next };
  if (key === 'ArrowRight') return ctx.canOpen ? { kind: 'open' } : null;
  if (key === 'ArrowLeft') return ctx.isSubmenu ? { kind: 'back' } : null;
  if (key === 'Escape') return ctx.isSubmenu ? { kind: 'back' } : { kind: 'close' };
  if (key === 'Tab') return { kind: 'close' };
  return null;
}
