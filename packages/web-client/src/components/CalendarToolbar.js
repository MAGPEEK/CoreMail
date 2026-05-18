import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Plus, ChevronDown, Calendar as CalDay, Briefcase, CalendarRange, LayoutGrid, Columns3, Filter, Share2, Printer, } from 'lucide-react';
import { ContextMenu } from './ContextMenu.js';
export function CalendarToolbar({ view, onChangeView, onNewEvent, filterCount = 0, onClearFilter, onPrint, onShare, }) {
    const [menu, setMenu] = useState(null);
    const Section = ({ title, children }) => (_jsxs("div", { className: "flex flex-col items-center px-2", children: [_jsx("div", { className: "flex items-end gap-1", children: children }), _jsx("div", { className: "text-[10px] text-gray-500 dark:text-gray-400 mt-1", children: title })] }));
    /** Großer Toolbar-Button (Icon oben, Label unten) — Office-Ribbon-Stil */
    const RibbonBtn = ({ icon, label, active, onClick, disabled, hasArrow, }) => (_jsxs("button", { onClick: onClick, disabled: disabled, className: `flex flex-col items-center gap-1 min-w-[64px] px-2 py-1.5 rounded transition-all duration-150 active:scale-95 ${active
            ? 'bg-accent/10 text-accent ring-1 ring-accent/30'
            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'} disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100`, children: [_jsx("div", { className: "h-7 flex items-center justify-center", children: icon }), _jsxs("span", { className: "text-[11px] leading-tight text-center max-w-[80px] flex items-center gap-0.5", children: [label, hasArrow && _jsx(ChevronDown, { size: 10, className: "opacity-60" })] })] }));
    const handleNewEventMenu = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({
            x: r.left,
            y: r.bottom,
            items: [
                { label: 'Neuer Termin', icon: _jsx(Plus, { size: 14 }), onClick: onNewEvent },
                { label: 'Neue Besprechung', icon: _jsx(Plus, { size: 14 }), onClick: onNewEvent },
                { label: 'Ganztägiges Ereignis', icon: _jsx(Plus, { size: 14 }), onClick: onNewEvent },
            ],
        });
    };
    const handleFilterMenu = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({
            x: Math.max(8, r.right - 200),
            y: r.bottom,
            items: [
                { label: 'Alle Ereignisse', icon: _jsx(Filter, { size: 14 }), onClick: onClearFilter ?? (() => { }) },
                { label: 'Nur unbeantwortet', icon: _jsx(Filter, { size: 14 }), disabled: true, onClick: () => { } },
                { label: 'Hochpriorisiert', icon: _jsx(Filter, { size: 14 }), disabled: true, onClick: () => { } },
            ],
        });
    };
    return (_jsxs("div", { className: "border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 shrink-0", children: [_jsxs("div", { className: "flex items-stretch gap-2 divide-x divide-gray-200 dark:divide-gray-700", children: [_jsx(Section, { title: "Neu", children: _jsx(RibbonBtn, { icon: _jsx(Plus, { size: 20, className: "text-accent" }), label: "Neues Ereignis", hasArrow: true, onClick: handleNewEventMenu }) }), _jsxs(Section, { title: "Anordnen", children: [_jsx(RibbonBtn, { icon: _jsx(CalDay, { size: 20 }), label: "Tag", active: view === 'timeGridDay', hasArrow: true, onClick: () => onChangeView('timeGridDay') }), _jsx(RibbonBtn, { icon: _jsx(Briefcase, { size: 20 }), label: "Arbeitswoche", active: view === 'workWeek', onClick: () => onChangeView('workWeek') }), _jsx(RibbonBtn, { icon: _jsx(Columns3, { size: 20 }), label: "Woche", active: view === 'timeGridWeek', onClick: () => onChangeView('timeGridWeek') }), _jsx(RibbonBtn, { icon: _jsx(LayoutGrid, { size: 20 }), label: "Monat", active: view === 'dayGridMonth', onClick: () => onChangeView('dayGridMonth') }), _jsx(RibbonBtn, { icon: _jsx(CalendarRange, { size: 20 }), label: "Geteilte Ansicht", disabled: true })] }), _jsx(Section, { title: "Filter", children: _jsx(RibbonBtn, { icon: _jsx(Filter, { size: 20, className: filterCount > 0 ? 'text-accent' : '' }), label: filterCount > 0 ? 'Filter angewendet' : 'Filter', active: filterCount > 0, hasArrow: true, onClick: handleFilterMenu }) }), _jsxs(Section, { title: "Teilen", children: [_jsx(RibbonBtn, { icon: _jsx(Share2, { size: 20 }), label: "Kalender teilen", onClick: onShare }), _jsx(RibbonBtn, { icon: _jsx(Printer, { size: 20 }), label: "Drucken", onClick: onPrint })] })] }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) })] }));
}
