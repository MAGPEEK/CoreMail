import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Plus, ChevronDown, Calendar as CalDay, Briefcase, CalendarRange, LayoutGrid, Columns3, Filter, Share2, Printer, X, } from 'lucide-react';
import { ContextMenu } from './ContextMenu.js';
const FILTER_OPTIONS = [
    'Termine',
    'Besprechungen',
    'Kalendereinträge für Abstimmungen',
    'Reservierungen',
    'Kategorien',
    'Anzeigen als',
    'Wiederholung',
    'Persönlich',
];
const FILTER_DEFAULT = {
    'Termine': true,
    'Besprechungen': true,
    'Kalendereinträge für Abstimmungen': true,
    'Reservierungen': false,
    'Kategorien': true,
    'Anzeigen als': true,
    'Wiederholung': true,
    'Persönlich': true,
};
export function CalendarToolbar({ view, onChangeView, onNewEvent, onPrint, onShare, }) {
    const [menu, setMenu] = useState(null);
    const [filterOpen, setFilterOpen] = useState(null);
    const [filters, setFilters] = useState(FILTER_DEFAULT);
    const filterCount = Object.keys(FILTER_DEFAULT)
        .filter((k) => filters[k] !== FILTER_DEFAULT[k]).length;
    const Section = ({ title, children }) => (_jsxs("div", { className: "flex flex-col items-center px-3 py-1", children: [_jsx("div", { className: "flex items-stretch gap-1 mb-1", children: children }), _jsx("div", { className: "text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide", children: title })] }));
    /** Großer Toolbar-Button (Icon oben, Label unten) — Office-Ribbon-Stil
     *  Feste Größe damit alle Buttons gleich aussehen. */
    const RibbonBtn = ({ icon, label, active, onClick, disabled, hasArrow, }) => (_jsxs("button", { onClick: onClick, disabled: disabled, className: `flex flex-col items-center justify-between w-[80px] h-[62px] px-1 py-1.5 rounded transition-all duration-150 active:scale-95 ${active
            ? 'bg-accent/10 text-accent ring-1 ring-accent/30'
            : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'} disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100`, children: [_jsx("div", { className: "h-6 flex items-center justify-center mt-0.5", children: icon }), _jsxs("span", { className: "text-[11px] leading-tight text-center w-full flex items-center justify-center gap-0.5 line-clamp-2", children: [label, hasArrow && _jsx(ChevronDown, { size: 10, className: "opacity-60 shrink-0" })] })] }));
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
        setFilterOpen({
            x: Math.max(8, r.right - 340),
            y: r.bottom + 4,
        });
    };
    const toggleFilter = (k) => setFilters((s) => ({ ...s, [k]: !s[k] }));
    const resetFilters = () => setFilters({ ...FILTER_DEFAULT });
    return (_jsxs("div", { className: "border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 shrink-0", children: [_jsxs("div", { className: "flex items-stretch gap-2 divide-x divide-gray-200 dark:divide-gray-700", children: [_jsx(Section, { title: "Neu", children: _jsx(RibbonBtn, { icon: _jsx(Plus, { size: 20, className: "text-accent" }), label: "Neues Ereignis", hasArrow: true, onClick: handleNewEventMenu }) }), _jsxs(Section, { title: "Anordnen", children: [_jsx(RibbonBtn, { icon: _jsx(CalDay, { size: 20 }), label: "Tag", active: view === 'timeGridDay', hasArrow: true, onClick: () => onChangeView('timeGridDay') }), _jsx(RibbonBtn, { icon: _jsx(Briefcase, { size: 20 }), label: "Arbeitswoche", active: view === 'workWeek', onClick: () => onChangeView('workWeek') }), _jsx(RibbonBtn, { icon: _jsx(Columns3, { size: 20 }), label: "Woche", active: view === 'timeGridWeek', onClick: () => onChangeView('timeGridWeek') }), _jsx(RibbonBtn, { icon: _jsx(LayoutGrid, { size: 20 }), label: "Monat", active: view === 'dayGridMonth', onClick: () => onChangeView('dayGridMonth') }), _jsx(RibbonBtn, { icon: _jsx(CalendarRange, { size: 20 }), label: "Geteilte Ansicht", disabled: true })] }), _jsx(Section, { title: "Filter", children: _jsx(RibbonBtn, { icon: _jsx(Filter, { size: 20, className: filterCount > 0 ? 'text-accent' : '' }), label: filterCount > 0 ? 'Filter angewendet' : 'Filter', active: filterCount > 0, hasArrow: true, onClick: handleFilterMenu }) }), _jsxs(Section, { title: "Teilen", children: [_jsx(RibbonBtn, { icon: _jsx(Share2, { size: 20 }), label: "Kalender teilen", onClick: onShare }), _jsx(RibbonBtn, { icon: _jsx(Printer, { size: 20 }), label: "Drucken", onClick: onPrint })] })] }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) }), filterOpen && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-[90]", onClick: () => setFilterOpen(null) }), _jsxs("div", { className: "fixed z-[95] w-[340px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl py-1 animate-fly-in", style: { left: filterOpen.x, top: filterOpen.y }, "data-coremail-contextmenu": true, children: [_jsxs("button", { onClick: () => { resetFilters(); setFilterOpen(null); }, className: "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors", children: [_jsx(X, { size: 14, className: "text-gray-400" }), _jsx("span", { children: "Filter l\u00F6schen" })] }), _jsx("div", { className: "my-1 border-t border-gray-100 dark:border-gray-700" }), FILTER_OPTIONS.map((opt) => {
                                const isReservation = opt === 'Reservierungen';
                                const hasSubmenu = !['Termine', 'Persönlich', 'Reservierungen'].includes(opt);
                                return (_jsxs("button", { onClick: () => toggleFilter(opt), className: "w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors", children: [_jsx("span", { className: `w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${filters[opt]
                                                ? 'bg-accent border-accent text-white'
                                                : 'border-gray-300 dark:border-gray-600'}`, children: filters[opt] && _jsx("span", { className: "text-[10px] leading-none", children: "\u2713" }) }), _jsx("span", { className: "flex-1 text-left", children: opt }), hasSubmenu && _jsx(ChevronDown, { size: 12, className: "-rotate-90 text-gray-400" }), isReservation && null] }, opt));
                            })] })] }))] }));
}
