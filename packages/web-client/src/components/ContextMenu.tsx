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
      className="fixed z-[100] min-w-[220px] bg-surface border border-line rounded-md shadow-lg py-1 text-sm select-none animate-fly-in"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === 'divider') {
          return <div key={`d-${i}`} className="my-1 border-t border-line" />;
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
              <div className="my-1 border-t border-line" />
            )}
            <button
              type="button"
              disabled={item.disabled}
              {...(item.title ? { title: item.title } : {})}
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
                  ? 'text-fg-disabled cursor-not-allowed'
                  : item.danger
                    ? 'text-danger-fg hover:bg-danger-bg'
                    : 'text-fg-muted hover:bg-surface-2'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-fg-subtle">{item.icon}</span>
              <span className="flex-1 truncate">{item.label}</span>
              {hasChildren && <span className="text-fg-subtle">›</span>}
            </button>
            {item.separator === 'after' && (
              <div className="my-1 border-t border-line" />
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
