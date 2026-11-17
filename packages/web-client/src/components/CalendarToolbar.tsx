import { useState } from 'react';
import {
  Plus, Calendar as CalDay, Briefcase, CalendarRange, LayoutGrid,
  Columns3, Filter, Share2, Printer, X,
} from 'lucide-react';
import { CommandBar, type CommandGroup } from './CommandBar.js';

export type CalendarView = 'timeGridDay' | 'timeGridWeek' | 'workWeek' | 'dayGridMonth' | 'split';

/** v3.18.21: Realistic filters that actually map to CalendarEvent fields. */
export const FILTER_OPTIONS = [
  'Wiederholende Termine',  // rrule != null
  'Aufgaben',                // tasks with dueDate (separate data source)
  'Private Termine',         // classification = PRIVATE
  'Vertrauliche Termine',    // classification = CONFIDENTIAL (owner sees them)
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
  // v3.18.21: controlled filter state — held in CalendarPage
  // and applied to fcEvents
  filters: Record<FilterKey, boolean>;
  onFiltersChange: (next: Record<FilterKey, boolean>) => void;
}

/** Calendar ribbon on the shared command bar (components/CommandBar.tsx). */
export function CalendarToolbar({
  view, onChangeView, onNewEvent, onPrint, onShare, filters, onFiltersChange,
}: Props) {
  const [filterOpen, setFilterOpen] = useState<{ x: number; y: number } | null>(null);

  const filterCount = (Object.keys(FILTER_DEFAULT) as FilterKey[])
    .filter((k) => filters[k] !== FILTER_DEFAULT[k]).length;

  const toggleFilter = (k: FilterKey) =>
    onFiltersChange({ ...filters, [k]: !filters[k] });

  const resetFilters = () => onFiltersChange({ ...FILTER_DEFAULT });

  const viewItem = (id: CalendarView, label: string, icon: React.ReactNode) => ({
    id, label, icon, pressed: view === id, onClick: () => onChangeView(id),
  });

  const groups: CommandGroup[] = [
    { id: 'new', title: 'Neu', items: [{
      id: 'new-event',
      label: 'Neues Ereignis',
      icon: <Plus size={20} className="text-accent-fg" />,
      placement: 'pinned',
      menu: () => [
        { label: 'Neuer Termin',         icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Neue Besprechung',     icon: <Plus size={14} />, onClick: onNewEvent },
        { label: 'Ganztägiges Ereignis', icon: <Plus size={14} />, onClick: onNewEvent },
      ],
    }] },
    { id: 'arrange', title: 'Anordnen', items: [
      viewItem('timeGridDay', 'Tag', <CalDay size={20} />),
      viewItem('workWeek', 'Arbeitswoche', <Briefcase size={20} />),
      viewItem('timeGridWeek', 'Woche', <Columns3 size={20} />),
      viewItem('dayGridMonth', 'Monat', <LayoutGrid size={20} />),
      { id: 'split', label: 'Geteilte Ansicht', icon: <CalendarRange size={20} />, disabled: true, tooltip: 'Noch nicht verfügbar' },
    ] },
    { id: 'filter', title: 'Filter', items: [{
      id: 'filter',
      label: filterCount > 0 ? 'Filter angewendet' : 'Filter',
      icon: <Filter size={20} className={filterCount > 0 ? 'text-accent-fg' : ''} />,
      pressed: filterCount > 0,
      onClick: (r) => setFilterOpen({ x: Math.max(8, r.right - 340), y: r.bottom + 4 }),
    }] },
    { id: 'share', title: 'Teilen', items: [
      { id: 'share', label: 'Kalender teilen', icon: <Share2 size={20} />, ...(onShare ? { onClick: onShare } : { disabled: true }) },
      { id: 'print', label: 'Drucken', icon: <Printer size={20} />, ...(onPrint ? { onClick: onPrint } : { disabled: true }) },
    ] },
  ];

  return (
    <>
      <CommandBar label="Kalender-Befehle" variant="ribbon" groups={groups} className="flex-1" />

      {filterOpen && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setFilterOpen(null)} />
          <div
            className="fixed z-[95] w-[340px] bg-surface border border-line rounded-md shadow-xl py-1 animate-fly-in"
            style={{ left: filterOpen.x, top: filterOpen.y }}
            data-coremail-contextmenu
          >
            <button
              onClick={() => { resetFilters(); setFilterOpen(null); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 transition-colors"
            >
              <X size={14} className="text-fg-subtle" />
              <span>Filter löschen</span>
            </button>
            <div className="my-1 border-t border-line" />
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt}
                onClick={() => toggleFilter(opt)}
                aria-pressed={filters[opt]}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 transition-colors"
              >
                <span className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${
                  filters[opt]
                    ? 'bg-accent border-accent-fg text-white'
                    : 'border-line-strong'
                }`}>
                  {filters[opt] && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <span className="flex-1 text-left">{opt}</span>
              </button>
            ))}
            <div className="my-1 border-t border-line" />
            <div className="px-3 py-1.5 text-[10px] text-fg-subtle">
              {filterCount === 0 ? 'Keine Filter aktiv' : `${filterCount} Filter aktiv`}
            </div>
          </div>
        </>
      )}
    </>
  );
}
