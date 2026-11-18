/**
 * DOM glue for an ARIA tree with roving tabindex (the folder tree): exactly one
 * `[role="treeitem"]` below the container is in the tab order, the arrow keys
 * move focus (lib/rovingFocus.ts decides where). Opening/closing a node stays
 * with the item's own key handler — a key it handled is `defaultPrevented`.
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type FocusEvent, type RefObject } from 'react';
import { tabStopIndex, treeTarget, type TreeItemInfo } from '../lib/rovingFocus.js';

const ITEM_SELECTOR = '[role="treeitem"]';

function itemsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

function infoOf(el: HTMLElement): TreeItemInfo {
  const expanded = el.getAttribute('aria-expanded');
  return {
    level: Number(el.getAttribute('aria-level') ?? '1'),
    expandable: expanded !== null,
    expanded: expanded === 'true',
  };
}

export function useRovingFocus(containerRef: RefObject<HTMLElement | null>) {
  const lastFocused = useRef<HTMLElement | null>(null);

  // After every render: one tab stop, even when items came or went
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = itemsOf(container);
    const focused = lastFocused.current ? items.indexOf(lastFocused.current) : -1;
    const selected = items.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    const stop = tabStopIndex(items.length, focused, selected);
    items.forEach((el, i) => { el.tabIndex = i === stop ? 0 : -1; });
  });

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem') return;
    lastFocused.current = target;
    const container = containerRef.current;
    if (container) itemsOf(container).forEach((el) => { el.tabIndex = el === target ? 0 : -1; });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const container = containerRef.current;
    if (e.defaultPrevented || !container || target.getAttribute('role') !== 'treeitem') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const items = itemsOf(container);
    const move = treeTarget(e.key, items.map(infoOf), items.indexOf(target));
    if (move?.kind !== 'focus') return;
    e.preventDefault();
    items[move.index]?.focus();
  };

  return { onFocus, onKeyDown };
}
