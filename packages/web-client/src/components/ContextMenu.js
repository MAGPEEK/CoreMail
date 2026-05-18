import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
export function ContextMenu({ x, y, items, onClose }) {
    const ref = useRef(null);
    const [pos, setPos] = useState({ x, y });
    const [submenuFor, setSubmenuFor] = useState(null);
    // Auto-Reposition wenn aus Viewport ragt
    useLayoutEffect(() => {
        if (!ref.current)
            return;
        const rect = ref.current.getBoundingClientRect();
        let nx = x;
        let ny = y;
        if (rect.right > window.innerWidth)
            nx = window.innerWidth - rect.width - 8;
        if (rect.bottom > window.innerHeight)
            ny = window.innerHeight - rect.height - 8;
        if (nx !== x || ny !== y)
            setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
    }, [x, y]);
    useEffect(() => {
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target))
                onClose();
        };
        const onKey = (e) => {
            if (e.key === 'Escape')
                onClose();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);
    return createPortal(_jsx("div", { ref: ref, role: "menu", className: "fixed z-[100] min-w-[220px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg py-1 text-sm select-none", style: { left: pos.x, top: pos.y }, onContextMenu: (e) => e.preventDefault(), children: items.map((item, i) => {
            if (item.type === 'divider') {
                return _jsx("div", { className: "my-1 border-t border-gray-100 dark:border-gray-700" }, `d-${i}`);
            }
            const hasChildren = !!(item.children && item.children.length);
            const isOpen = submenuFor?.index === i;
            return (_jsxs("div", { children: [item.separator === 'before' && (_jsx("div", { className: "my-1 border-t border-gray-100 dark:border-gray-700" })), _jsxs("button", { type: "button", disabled: item.disabled, onMouseEnter: (e) => {
                            if (hasChildren) {
                                setSubmenuFor({ index: i, rect: e.currentTarget.getBoundingClientRect() });
                            }
                            else {
                                setSubmenuFor(null);
                            }
                        }, onClick: () => {
                            if (item.disabled)
                                return;
                            if (hasChildren)
                                return;
                            item.onClick?.();
                            onClose();
                        }, className: `w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${item.disabled
                            ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                            : item.danger
                                ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30'
                                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}`, children: [_jsx("span", { className: "w-4 h-4 flex items-center justify-center shrink-0 text-gray-400", children: item.icon }), _jsx("span", { className: "flex-1 truncate", children: item.label }), hasChildren && _jsx("span", { className: "text-gray-400", children: "\u203A" })] }), item.separator === 'after' && (_jsx("div", { className: "my-1 border-t border-gray-100 dark:border-gray-700" })), hasChildren && isOpen && submenuFor && (_jsx(ContextMenu, { x: submenuFor.rect.right - 4, y: submenuFor.rect.top, items: item.children, onClose: onClose }))] }, i));
        }) }), document.body);
}
