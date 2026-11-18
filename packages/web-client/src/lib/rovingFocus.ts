/**
 * Roving-focus helpers for the folder tree (ARIA tree) and the message list
 * (ARIA grid): one element of the widget is in the tab order, the arrow keys
 * move between the rest. Pure functions — the DOM glue is hooks/useRovingFocus.ts.
 * No imports — unit-tested with `node --test`.
 */

/** Index the key moves to in a vertical list, or null when the key is not a list key. */
export function listTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case 'ArrowDown': return Math.min(index + 1, last);
    case 'ArrowUp': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    case 'PageDown': return Math.min(index + 10, last);
    case 'PageUp': return Math.max(index - 10, 0);
    default: return null;
  }
}

/** What a tree item exposes about itself. */
export interface TreeItemInfo {
  level: number;
  expandable: boolean;
  expanded: boolean;
}

export type TreeMove =
  | { kind: 'focus'; index: number }
  | { kind: 'expand' }
  | { kind: 'collapse' };

/**
 * Key handling of an ARIA tree over the flat list of visible items:
 * Up/Down/Home/End move, Right opens a closed node or steps into its first
 * child, Left closes an open node or steps to the parent.
 */
export function treeTarget(key: string, items: readonly TreeItemInfo[], index: number): TreeMove | null {
  const current = items[index];
  if (!current) return null;
  if (key === 'ArrowRight') {
    if (!current.expandable) return null;
    if (!current.expanded) return { kind: 'expand' };
    const child = items[index + 1];
    return child && child.level > current.level ? { kind: 'focus', index: index + 1 } : null;
  }
  if (key === 'ArrowLeft') {
    if (current.expandable && current.expanded) return { kind: 'collapse' };
    for (let i = index - 1; i >= 0; i--) {
      if (items[i]!.level < current.level) return { kind: 'focus', index: i };
    }
    return null;
  }
  const to = listTarget(key, index, items.length);
  return to === null || to === index ? null : { kind: 'focus', index: to };
}

/**
 * Which item is the tab stop: the one that last had focus, else the selected
 * one, else the first. Indices refer to the current item list (-1 = none).
 */
export function tabStopIndex(count: number, focusedIndex: number, selectedIndex: number): number {
  if (count <= 0) return -1;
  if (focusedIndex >= 0 && focusedIndex < count) return focusedIndex;
  if (selectedIndex >= 0 && selectedIndex < count) return selectedIndex;
  return 0;
}
