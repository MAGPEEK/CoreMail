import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  /** Untermenü-Items */
  children?: ContextMenuItem[];
  /** Trennlinie über/unter Item */
  separator?: 'before' | 'after';
  /** Visuell als zerstörerische Aktion (rot) */
  danger?: boolean;
  disabled?: boolean;
  /** Komplette Trennzeile */
  type?: 'divider';
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

  // Auto-Reposition wenn aus Viewport ragt
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
      // Klicks INNERHALB eines ContextMenus (auch in Submenus, die als
      // eigenes Portal gerendert werden) NICHT als outside-Klick werten.
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
