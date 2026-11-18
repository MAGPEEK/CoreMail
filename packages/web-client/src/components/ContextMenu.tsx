import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { menuKeyIntent } from '../lib/toolbarNav.js';

export interface ContextMenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  /** Submenu items */
  children?: ContextMenuItem[];
  /** Divider above/below item */
  separator?: 'before' | 'after';
  /** Visually a destructive action (red) */
  danger?: boolean;
  disabled?: boolean;
  /** Checkable entry (role menuitemcheckbox + aria-checked); a check mark shows when on. */
  checked?: boolean;
  /** Tooltip (e.g. why the item is disabled) */
  title?: string;
  /** Full divider row or special render */
  type?: 'divider' | 'color-grid';
  /** Only for type='color-grid': colors array + pick handler + optionally the current selection */
  colors?: string[];
  current?: string;
  onPick?: (color: string) => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Focus the first item when the menu opens (menus opened from a button or by keyboard). */
  autoFocus?: boolean;
  /** Submenu only: ArrowLeft / Escape close it and return focus to its parent item. */
  onBack?: () => void;
}

const ITEM_SELECTOR = '[data-menuitem]';

export function ContextMenu({ x, y, items, onClose, autoFocus = false, onBack }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [submenuFor, setSubmenuFor] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null);
  const isSubmenu = !!onBack;

  // Auto-reposition when overflowing the viewport
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (rect.right > window.innerWidth)  nx = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) ny = window.innerHeight - rect.height - 8;
    if (nx !== x || ny !== y) setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y]);

  // Outside click / Escape while focus is outside the menu (mouse use). Only the
  // top-level menu listens — a submenu shares its onClose, and keys inside a menu
  // are handled by onMenuKeyDown.
  useEffect(() => {
    if (isSubmenu) return;
    const onDown = (e: MouseEvent) => {
      // Do NOT treat clicks INSIDE a ContextMenu (including submenus rendered
      // as their own portal) as outside clicks.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-coremail-contextmenu]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, isSubmenu]);

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [autoFocus]);

  /** Keyboard model: lib/toolbarNav.ts menuKeyIntent. */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Submenus are portals: their key events also bubble through this menu's React tree
    const menu = ref.current;
    if (!menu || !menu.contains(e.target as Node)) return;
    // Keys pressed in a menu never reach the page's shortcuts (e.g. "e" = archive)
    e.stopPropagation();
    const els = Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    const focused = document.activeElement as HTMLElement | null;
    const index = Number(focused?.dataset.menuindex ?? -1);
    const item = items[index];
    const intent = menuKeyIntent(e.key, {
      current: focused ? els.indexOf(focused) : -1,
      count: els.length,
      canOpen: !!(item?.children?.length && !item.disabled),
      isSubmenu,
    });
    if (!intent) return;
    e.preventDefault();
    if (intent.kind === 'move') {
      setSubmenuFor(null);
      els[intent.index]?.focus();
    } else if (intent.kind === 'open' && focused) {
      setSubmenuFor({ index, rect: focused.getBoundingClientRect(), focus: true });
    } else if (intent.kind === 'back') {
      onBack?.();
    } else if (intent.kind === 'close') {
      onClose();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-coremail-contextmenu
      className="fixed z-[100] min-w-[220px] bg-surface border border-line rounded-md shadow-lg py-1 text-sm select-none animate-fly-in"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onMenuKeyDown}
    >
      {items.map((item, i) => {
        if (item.type === 'divider') {
          return <div key={`d-${i}`} role="separator" className="my-1 border-t border-line" />;
        }
        if (item.type === 'color-grid' && item.colors) {
          return (
            <div key={`cg-${i}`} className="px-3 py-2.5">
              <div className="grid grid-cols-8 gap-1.5">
                {item.colors.map((c) => {
                  const isActive = item.current?.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => { item.onPick?.(c); onClose(); }}
                      className={`w-5 h-5 rounded-full transition-all duration-150 hover:scale-125 active:scale-90 ${
                        isActive ? 'ring-2 ring-offset-1 ring-line-strong' : 'ring-1 ring-inset ring-line'
                      }`}
                      style={{ backgroundColor: c }}
                      aria-label={c}
                      title={c}
                    />
                  );
                })}
              </div>
            </div>
          );
        }
        const hasChildren = !!(item.children && item.children.length);
        const isOpen = submenuFor?.index === i;
        return (
          <div key={i}>
            {item.separator === 'before' && (
              <div role="separator" className="my-1 border-t border-line" />
            )}
            {/* aria-disabled (not disabled): stays reachable by keyboard and its reason is read out */}
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              {...(item.checked === undefined ? {} : { 'aria-checked': item.checked })}
              tabIndex={-1}
              data-menuitem
              data-menuindex={i}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={hasChildren ? 'menu' : undefined}
              aria-expanded={hasChildren ? isOpen : undefined}
              {...(item.title ? { title: item.title } : {})}
              onMouseEnter={(e) => {
                if (hasChildren && !item.disabled) {
                  setSubmenuFor({ index: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect(), focus: false });
                } else {
                  setSubmenuFor(null);
                }
              }}
              onClick={(e) => {
                if (item.disabled) return;
                if (hasChildren) {
                  setSubmenuFor({ index: i, rect: e.currentTarget.getBoundingClientRect(), focus: e.detail === 0 });
                  return;
                }
                // Close first: a menu opened from a button gives focus back to it before the
                // command runs, so a dialog the command opens returns focus there too
                onClose();
                item.onClick?.();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors focus-visible:outline-offset-[-2px] ${
                item.disabled
                  ? 'text-fg-disabled cursor-not-allowed'
                  : item.danger
                    ? 'text-danger-fg hover:bg-danger-bg focus:bg-danger-bg'
                    : 'text-fg-muted hover:bg-surface-2 focus:bg-surface-2'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-fg-subtle" aria-hidden="true">
                {item.checked ? <Check size={14} /> : item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.disabled && item.title && <span className="sr-only">{`, ${item.title}`}</span>}
              {hasChildren && <span className="text-fg-subtle" aria-hidden="true">›</span>}
            </button>
            {item.separator === 'after' && (
              <div role="separator" className="my-1 border-t border-line" />
            )}
            {hasChildren && isOpen && submenuFor && (
              <ContextMenu
                x={submenuFor.rect.right - 4}
                y={submenuFor.rect.top}
                items={item.children!}
                onClose={onClose}
                autoFocus={submenuFor.focus}
                onBack={() => {
                  setSubmenuFor(null);
                  ref.current?.querySelector<HTMLElement>(`[data-menuindex="${i}"]`)?.focus();
                }}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
