import { useState } from 'react';
import {
  Plus, ChevronDown, Calendar as CalDay, Briefcase, CalendarRange, LayoutGrid,
  Columns3, Filter, Share2, Printer, X,
} from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';

export type CalendarView = 'timeGridDay' | 'timeGridWeek' | 'workWeek' | 'dayGridMonth' | 'split';

/** v3.18.21: Realistische Filter, die tatsächlich auf CalendarEvent-Felder mappen. */
export const FILTER_OPTIONS = [
  'Wiederholende Termine',  // rrule != null
  'Aufgaben',                // tasks mit dueDate (separate Datenquelle)
  'Private Termine',         // classification = PRIVATE
  'Vertrauliche Termine',    // classification = CONFIDENTIAL (Owner sieht sie)
  'Geteilte Kalender',       // shared = true
] as const;
export type FilterKey = typeof FILTER_OPTIONS[number];

export const FILTER_DEFAULT: Record<FilterKey, boolean> = {
  'Wiederholende Termine': true,
  'Aufgaben':              true,
  'Private Termine':       true,
  'Vertrauliche Termine':  true,
  'Geteilte Kalender':     true,
};

interface Props {
  view: CalendarView;
  onChangeView: (v: CalendarView) => void;
  onNewEvent: () => void;
  onPrint?: () => void;
  onShare?: () => void;
  // v3.18.21: kontrollierter Filter-State — wird in CalendarPage gehalten
  // und auf fcEvents angewendet
  filters: Record<FilterKey, boolean>;
  onFiltersChange: (next: Record<FilterKey, boolean>) => void;
}

interface MenuState { x: number; y: number; items: ContextMenuItem[] }

export function CalendarToolbar({
  view, onChangeView, onNewEvent, onPrint, onShare, filters, onFiltersChange,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [filterOpen, setFilterOpen] = useState<{ x: number; y: number } | null>(null);

  const filterCount = (Object.keys(FILTER_DEFAULT) as FilterKey[])
    .filter((k) => filters[k] !== FILTER_DEFAULT[k]).length;

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col items-center px-3 py-1">
      <div className="flex items-stretch gap-1 mb-1">{children}</div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">{title}</div>
    </div>
  );

  /** Großer Toolbar-Button (Icon oben, Label unten) — Office-Ribbon-Stil
   *  Feste Größe damit alle Buttons gleich aussehen. */
  const RibbonBtn = ({
    icon, label, active, onClick, disabled, hasArrow,
  }: {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    hasArrow?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-between w-[80px] h-[62px] px-1 py-1.5 rounded transition-all duration-150 active:scale-95 ${
        active
          ? 'bg-accent/10 text-accent ring-1 ring-accent/30'
          : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
      } disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100`}
    >
      <div className="h-6 flex items-center justify-center mt-0.5">{icon}</div>
      <span className="text-[11px] leading-tight text-center w-full flex items-center justify-center gap-0.5 line-clamp-2">
        {label}
        {hasArrow && <ChevronDown size={10} className="opacity-60 shrink-0" />}
      </span>
    </button>
  );

  const handleNewEventMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom,
      items: [
        { label: 'Neuer Termin',       icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Neue Besprechung',   icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Ganztägiges Ereignis', icon: <Plus size={14} />, onClick: onNewEvent },
      ],
    });
  };

  const handleFilterMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFilterOpen({
      x: Math.max(8, r.right - 340),
      y: r.bottom + 4,
    });
  };

  const toggleFilter = (k: FilterKey) =>
    onFiltersChange({ ...filters, [k]: !filters[k] });

  const resetFilters = () => onFiltersChange({ ...FILTER_DEFAULT });

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 shrink-0">
      <div className="flex items-stretch gap-2 divide-x divide-gray-200 dark:divide-gray-700">

        {/* Section: Neu */}
        <Section title="Neu">
          <RibbonBtn
            icon={<Plus size={20} className="text-accent" />}
            label="Neues Ereignis"
            hasArrow
            onClick={handleNewEventMenu}
          />
        </Section>

        {/* Section: Anordnen */}
        <Section title="Anordnen">
          <RibbonBtn icon={<CalDay size={20} />}        label="Tag"          active={view === 'timeGridDay'}  hasArrow onClick={() => onChangeView('timeGridDay')} />
          <RibbonBtn icon={<Briefcase size={20} />}     label="Arbeitswoche" active={view === 'workWeek'}     onClick={() => onChangeView('workWeek')} />
          <RibbonBtn icon={<Columns3 size={20} />}      label="Woche"        active={view === 'timeGridWeek'} onClick={() => onChangeView('timeGridWeek')} />
          <RibbonBtn icon={<LayoutGrid size={20} />}    label="Monat"        active={view === 'dayGridMonth'} onClick={() => onChangeView('dayGridMonth')} />
          <RibbonBtn icon={<CalendarRange size={20} />} label="Geteilte Ansicht" disabled />
        </Section>

        {/* Section: Filter */}
        <Section title="Filter">
          <RibbonBtn
            icon={<Filter size={20} className={filterCount > 0 ? 'text-accent' : ''} />}
            label={filterCount > 0 ? 'Filter angewendet' : 'Filter'}
            active={filterCount > 0}
            hasArrow
            onClick={handleFilterMenu}
          />
        </Section>

        {/* Section: Teilen */}
        <Section title="Teilen">
          <RibbonBtn icon={<Share2 size={20} />}  label="Kalender teilen" onClick={onShare} />
          <RibbonBtn icon={<Printer size={20} />} label="Drucken"         onClick={onPrint} />
        </Section>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {filterOpen && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setFilterOpen(null)} />
          <div
            className="fixed z-[95] w-[340px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl py-1 animate-fly-in"
            style={{ left: filterOpen.x, top: filterOpen.y }}
            data-coremail-contextmenu
          >
            <button
              onClick={() => { resetFilters(); setFilterOpen(null); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <X size={14} className="text-gray-400" />
              <span>Filter löschen</span>
            </button>
            <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt}
                onClick={() => toggleFilter(opt)}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <span className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${
                  filters[opt]
                    ? 'bg-accent border-accent text-white'
                    : 'border-gray-300 dark:border-gray-600'
                }`}>
                  {filters[opt] && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <span className="flex-1 text-left">{opt}</span>
              </button>
            ))}
            <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
            <div className="px-3 py-1.5 text-[10px] text-gray-400 dark:text-gray-500">
              {filterCount === 0 ? 'Keine Filter aktiv' : `${filterCount} Filter aktiv`}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
