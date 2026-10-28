import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [submenuFor, setSubmenuFor] = useState<{ index: number; rect: DOMRect } | null>(null);

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

  useEffect(() => {
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
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-coremail-contextmenu
      className="fixed z-[100] min-w-[220px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg py-1 text-sm select-none animate-fly-in"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === 'divider') {
          return <div key={`d-${i}`} className="my-1 border-t border-gray-100 dark:border-gray-700" />;
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
                        isActive ? 'ring-2 ring-offset-1 ring-gray-700 dark:ring-gray-200' : 'ring-1 ring-inset ring-black/10'
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
              <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
            )}
            <button
              type="button"
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (hasChildren) {
                  setSubmenuFor({ index: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
                } else {
                  setSubmenuFor(null);
                }
              }}
              onClick={() => {
                if (item.disabled) return;
                if (hasChildren) return;
                item.onClick?.();
                onClose();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                item.disabled
                  ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                  : item.danger
                    ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30'
                    : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-gray-400">{item.icon}</span>
              <span className="flex-1 truncate">{item.label}</span>
              {hasChildren && <span className="text-gray-400">›</span>}
            </button>
            {item.separator === 'after' && (
              <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
            )}
            {hasChildren && isOpen && submenuFor && (
              <ContextMenu
                x={submenuFor.rect.right - 4}
                y={submenuFor.rect.top}
                items={item.children!}
                onClose={onClose}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
