/**
 * 10.7: the commands of the calendar card's toolbar row (right of Heute, ‹ ›
 * and the period label): Tag / Arbeitswoche / Woche / Monat, Zeitskala, Filter,
 * Tagesagenda, Freigeben, Drucken, "…" (Kalender-Einstellungen) — pure data in
 * lib/calendarToolbar.ts on the shared command bar (roving focus, overflow "…").
 * Every command goes through the page's dispatcher except the filter popover,
 * which lives here. There is no calendar ribbon any more.
 */
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Calendar as CalDay, Briefcase, Columns3, LayoutGrid, Filter, Share2, Printer, Clock, Settings, ListTodo, X,
} from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from './CommandBar.js';
import {
  groupToolbar, resolveToolbar, type CalendarAction, type CalendarViewId, type ResolvedCommand,
} from '../lib/calendarToolbar.js';
import { useT } from '../i18n/useT.js';

const ICONS: Record<string, ElementType> = {
  Plus, Calendar: CalDay, Briefcase, Columns3, LayoutGrid, Filter, Share2, Printer, Clock, Settings, ListTodo,
};

type ToolbarDispatch = (action: CalendarAction, anchor?: HTMLElement) => void;

const icon = (name: string, size: number, className?: string): ReactNode => {
  const Icon = ICONS[name];
  return Icon ? <Icon size={size} {...(className ? { className } : {})} aria-hidden="true" /> : null;
};

/** The view buttons show their label; the tool buttons are icons with a tooltip. */
const ICON_ONLY_GROUPS = new Set<ResolvedCommand['group']>(['scale', 'tools']);

/** One resolved command as a command-bar item; `popoverOpen` marks the filter button's popover. */
function toItem(c: ResolvedCommand, dispatch: ToolbarDispatch, popoverOpen: boolean): CommandItem {
  const { action, options } = c;
  const isNew = c.id === 'new';
  return {
    id: c.id,
    label: c.label,
    icon: icon(c.icon, 16, c.id === 'filter' && c.pressed ? 'text-accent-fg' : undefined),
    disabled: !c.enabled,
    placement: c.placement,
    ...(ICON_ONLY_GROUPS.has(c.group) ? { iconOnly: true } : {}),
    ...(isNew ? { tone: 'primary' as const } : {}),
    ...(action === 'filter' ? { dialogOpen: popoverOpen } : {}),
    ...(c.tooltip ? { tooltip: c.tooltip } : {}),
    ...(c.pressed !== undefined ? { pressed: c.pressed } : {}),
    ...(action ? { onClick: (anchor: HTMLElement) => dispatch(action, anchor) } : {}),
    ...(options ? {
      menu: () => options.map((o) => ({ label: o.label, icon: icon(o.icon, 14), onClick: () => dispatch(o.action) })),
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
  /** Phone layout: "Neuer Termin" joins the row (the calendar list is a sheet there). */
  compact: boolean;
  /** Every command except the filter popover (owned here) goes through the page. */
  onAction: (action: CalendarAction) => void;
}

export function CalendarToolbar({ view, filters, onFiltersChange, hasOwnCalendar, slotMinutes, agendaOpen, compact, onAction }: Props) {
  const t = useT();
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

  const dispatch: ToolbarDispatch = (action, anchor) => {
    if (action === 'filter' && anchor) {
      const r = anchor.getBoundingClientRect();
      setFilterOpen({ x: Math.max(8, Math.min(r.right - 340, window.innerWidth - 348)), y: r.bottom + 4, trigger: anchor });
    } else onAction(action);
  };
  const commands = resolveToolbar({ view, activeFilters: filterCount, hasOwnCalendar, slotMinutes, agendaOpen, compact });
  // right-aligned in the row (the first group carries the push)
  const groups: CommandGroup[] = groupToolbar(commands).map(({ group, commands: list }, i) => ({
    id: group,
    ...(i === 0 ? { align: 'end' as const } : {}),
    items: list.map((c) => toItem(c, dispatch, filterIsOpen)),
  }));

  return (
    <>
      <CommandBar label={t('cal_toolbar_label')} groups={groups} className="flex-1 min-w-0" />

      {/* in <body> — the card may blur a background picture (traps fixed children) */}
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
