/**
 * Calendar ribbon: the pure ribbon data (lib/calendarRibbon.ts — tabs Start /
 * Ansicht / Hilfe) on the shared ribbon (components/Ribbon.tsx). Every command
 * goes through the page's dispatcher except the filter popover, which lives here.
 */
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, CalendarPlus, Mail, CalendarCheck, Calendar as CalDay, Briefcase, Columns3, LayoutGrid,
  Filter, Share2, Printer, Clock, Settings, Keyboard, Info, ListTodo, Users, Sun, X,
} from 'lucide-react';
import type { CommandGroup, CommandItem } from './CommandBar.js';
import { Ribbon } from './Ribbon.js';
import {
  flattenRibbon, resolveRibbon, type CalendarAction, type CalendarViewId, type ResolvedCommand, type RibbonTabId,
} from '../lib/calendarRibbon.js';
import { useT } from '../i18n/useT.js';

const ICONS: Record<string, ElementType> = {
  Plus, CalendarPlus, Mail, CalendarCheck, Calendar: CalDay, Briefcase, Columns3, LayoutGrid,
  Filter, Share2, Printer, Clock, Settings, Keyboard, Info, ListTodo, Users, Sun,
};

type RibbonDispatch = (action: CalendarAction, anchor?: HTMLElement) => void;

const icon = (name: string, size: number, className?: string): ReactNode => {
  const Icon = ICONS[name];
  return Icon ? <Icon size={size} {...(className ? { className } : {})} aria-hidden="true" /> : null;
};

/** One resolved ribbon command as a command-bar item; `popoverOpen` marks the filter button's popover. */
function toItem(c: ResolvedCommand, dispatch: RibbonDispatch, popoverOpen: boolean): CommandItem {
  const { action, options } = c;
  const isNew = c.id === 'new';
  return {
    id: c.id,
    label: c.label,
    icon: icon(c.icon, 20, isNew || (c.id === 'filter' && c.pressed) ? 'text-accent-fg' : undefined),
    disabled: !c.enabled,
    ...(action === 'filter' ? { dialogOpen: popoverOpen } : {}),
    ...(c.tooltip ? { tooltip: c.tooltip } : {}),
    ...(c.pressed !== undefined ? { pressed: c.pressed } : {}),
    ...(isNew ? { placement: 'pinned' as const } : {}),
    ...(action ? { onClick: (anchor: HTMLElement) => dispatch(action, anchor) } : {}),
    ...(options ? {
      menu: () => options.flatMap((o) => [
        ...(o.separatorBefore ? [{ type: 'divider' as const }] : []),
        { label: o.label, icon: icon(o.icon, 14), onClick: () => dispatch(o.action) },
      ]),
    } : {}),
  };
}

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

export function CalendarToolbar({ view, filters, onFiltersChange, hasOwnCalendar, slotMinutes, agendaOpen, onAction }: Props) {
  const t = useT();
  const [tab, setTab] = useState<RibbonTabId>('start');
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

  const dispatch: RibbonDispatch = (action, anchor) => {
    if (action === 'filter' && anchor) {
      const r = anchor.getBoundingClientRect();
      setFilterOpen({ x: Math.max(8, r.right - 340), y: r.bottom + 4, trigger: anchor });
    } else onAction(action);
  };
  const tabs = resolveRibbon({ view, activeFilters: filterCount, hasOwnCalendar, slotMinutes, agendaOpen, aboutAvailable: true });
  const activeTab = tabs.find((x) => x.id === tab) ?? tabs[0]!;
  const groups: CommandGroup[] = flattenRibbon([activeTab]).map(({ group, commands }) => ({
    id: group,
    title: group,
    items: commands.map((c) => toItem(c, dispatch, filterIsOpen)),
  }));

  return (
    <Ribbon label={t('ribbon_label')} tabs={tabs} active={activeTab.id} onSelect={setTab} groups={groups}>

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
    </Ribbon>
  );
}
