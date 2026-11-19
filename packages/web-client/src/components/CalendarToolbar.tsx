import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { CommandBar } from './CommandBar.js';
import { ribbonToCommandGroups } from './calendar/ribbonAdapter.js';
import type { CalendarAction, CalendarViewId } from '../lib/calendarRibbon.js';

export type CalendarView = CalendarViewId;

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
  // v3.18.21: controlled filter state — held in CalendarPage and applied to fcEvents
  filters: Record<FilterKey, boolean>;
  onFiltersChange: (next: Record<FilterKey, boolean>) => void;
  hasOwnCalendar: boolean;
  slotMinutes: number;
  agendaOpen: boolean;
  /** Every ribbon command except the filter popover (owned here) goes through the page. */
  onAction: (action: CalendarAction) => void;
}

/** Calendar ribbon: the pure ribbon data (lib/calendarRibbon.ts) on the shared command bar. */
export function CalendarToolbar({ view, filters, onFiltersChange, hasOwnCalendar, slotMinutes, agendaOpen, onAction }: Props) {
  const [filterOpen, setFilterOpen] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterIsOpen = filterOpen !== null;

  // The filter popover takes focus when it opens and gives it back to its button
  useEffect(() => {
    if (filterIsOpen) filterRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [filterIsOpen]);
  const closeFilter = () => {
    const trigger = filterOpen?.trigger;
    setFilterOpen(null);
    if (trigger?.isConnected) trigger.focus();
  };

  const filterCount = (Object.keys(FILTER_DEFAULT) as FilterKey[])
    .filter((k) => filters[k] !== FILTER_DEFAULT[k]).length;

  const toggleFilter = (k: FilterKey) =>
    onFiltersChange({ ...filters, [k]: !filters[k] });

  const resetFilters = () => onFiltersChange({ ...FILTER_DEFAULT });

  const groups = ribbonToCommandGroups(
    { view, activeFilters: filterCount, hasOwnCalendar, slotMinutes, agendaOpen, aboutAvailable: false },
    (action, anchor) => {
      if (action === 'filter' && anchor) {
        const r = anchor.getBoundingClientRect();
        setFilterOpen({ x: Math.max(8, r.right - 340), y: r.bottom + 4, trigger: anchor });
      } else onAction(action);
    },
    { action: 'filter', open: filterIsOpen },
  );

  return (
    <>
      <CommandBar label="Kalender-Befehle" variant="ribbon" groups={groups} className="flex-1" />

      {/* 10.1: in <body> — the floating header card may blur a background picture (traps fixed children) */}
      {filterOpen && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onClick={closeFilter} />
          <div
            ref={filterRef}
            role="dialog"
            aria-label="Filter"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFilter(); } }}
            className="fixed z-[95] w-[340px] bg-surface border border-line rounded-md shadow-xl py-1 animate-fly-in"
            style={{ left: filterOpen.x, top: filterOpen.y }}
            data-coremail-contextmenu
          >
            <button
              onClick={() => { resetFilters(); closeFilter(); }}
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
        </>,
        document.body,
      )}
    </>
  );
}
