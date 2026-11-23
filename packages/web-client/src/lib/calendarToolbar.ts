/**
 * 10.7: the calendar commands as pure data. There is no ribbon any more: the
 * calendar card has one toolbar row (Heute, ‹ ›, period label on the left —
 * components/calendar/CalendarNavBar.tsx — and these commands on the right:
 * Tag / Arbeitswoche / Woche / Monat, Zeitskala, Filter, Tagesagenda, Freigeben,
 * Drucken, "…" with Kalender-Einstellungen); "Neuer Termin" is the button at the
 * top of the calendar list card. Keyboard help and "Über CoreMail" are in the
 * avatar menu of the rail. Every command maps to an EXISTING calendar action.
 * No imports: unit-tested with `node --test`.
 */

export type CalendarViewId = 'timeGridDay' | 'timeGridWeek' | 'workWeek' | 'dayGridMonth';

export const SLOT_MINUTES = [5, 10, 15, 30, 60] as const;
export type SlotMinutes = typeof SLOT_MINUTES[number];

/** Everything a command may do; interpreted by the page's dispatcher. */
export type CalendarAction =
  | 'new-event' | 'today'
  | `view:${CalendarViewId}`
  | 'filter' | 'share' | 'print' | 'agenda'
  | `slot:${SlotMinutes}`
  | 'settings';

/** Page state the enabled / pressed / visible logic depends on. */
export interface ToolbarState {
  view: CalendarViewId;
  /** Number of filters that differ from the default. */
  activeFilters: number;
  /** The user owns at least one calendar (needed for sharing). */
  hasOwnCalendar: boolean;
  /** Current time scale in minutes (Settings → Kalender). */
  slotMinutes: number;
  /** The day agenda panel is open. */
  agendaOpen: boolean;
  /** Phone layout: the calendar list is a sheet, "Neuer Termin" joins the toolbar. */
  compact: boolean;
}

export interface ToolbarOption {
  id: string;
  label: string;
  icon: string;
  action: CalendarAction;
}

/** auto = in the row while it fits, overflow = always in "…", pinned = never in "…". */
export type ToolbarPlacement = 'auto' | 'overflow' | 'pinned';

export interface ToolbarCommandDef {
  id: string;
  label: string;
  /** lucide icon name (resolved by the render layer). */
  icon: string;
  /** Group of the toolbar row (dividers between groups). */
  group: 'new' | 'view' | 'scale' | 'tools' | 'more';
  /** Main action; null = dropdown only. */
  action: CalendarAction | null;
  enabled: (s: ToolbarState) => boolean;
  /** Hidden entirely (not just disabled) when this returns false. */
  visible?: (s: ToolbarState) => boolean;
  pressed?: (s: ToolbarState) => boolean;
  /** Dropdown entries: with a main action → split button, without → plain dropdown. */
  options?: (s: ToolbarState) => ToolbarOption[];
  /** Label that depends on the state (e.g. "Filter angewendet"). */
  labelFor?: (s: ToolbarState) => string;
  tooltip?: string;
  placement?: ToolbarPlacement;
  /** Icon only (the label is the accessible name and the tooltip). */
  iconOnly?: boolean;
}

const always = () => true;

const viewCommand = (id: CalendarViewId, label: string, icon: string): ToolbarCommandDef => ({
  id: `view-${id}`, label, icon, group: 'view', action: `view:${id}`, enabled: always, pressed: (s) => s.view === id,
});

/** Commands of the toolbar row, in order (the navigation part — Heute, ‹ ›, period — precedes them). */
export const CALENDAR_TOOLBAR: readonly ToolbarCommandDef[] = [
  {
    id: 'new', label: 'Neuer Termin', icon: 'Plus', group: 'new', action: 'new-event', enabled: always,
    // on wide screens the button sits at the top of the calendar list card
    visible: (s) => s.compact, placement: 'pinned',
    tooltip: 'Neuen Termin im Kalender anlegen',
  },
  viewCommand('timeGridDay', 'Tag', 'Calendar'),
  viewCommand('workWeek', 'Arbeitswoche', 'Briefcase'),
  viewCommand('timeGridWeek', 'Woche', 'Columns3'),
  viewCommand('dayGridMonth', 'Monat', 'LayoutGrid'),
  {
    id: 'time-scale', label: 'Zeitskala', icon: 'Clock', group: 'scale', action: null,
    // the scale exists only in the time-grid views
    enabled: (s) => s.view !== 'dayGridMonth',
    tooltip: 'Zeitraster der Tages- und Wochenansichten',
    options: (s) => SLOT_MINUTES.map((m) => ({
      id: `slot-${m}`,
      label: m === s.slotMinutes ? `${m} Minuten (aktuell)` : `${m} Minuten`,
      icon: 'Clock',
      action: `slot:${m}` as const,
    })),
  },
  {
    id: 'filter', label: 'Filter', icon: 'Filter', group: 'tools', action: 'filter', enabled: always,
    pressed: (s) => s.activeFilters > 0,
    labelFor: (s) => (s.activeFilters > 0 ? 'Filter angewendet' : 'Filter'),
  },
  {
    id: 'agenda', label: 'Tagesagenda', icon: 'ListTodo', group: 'tools', action: 'agenda', enabled: always,
    pressed: (s) => s.agendaOpen,
  },
  {
    id: 'share', label: 'Freigeben', icon: 'Share2', group: 'tools', action: 'share',
    enabled: (s) => s.hasOwnCalendar,
    tooltip: 'Eigenen Kalender freigeben',
  },
  { id: 'print', label: 'Drucken', icon: 'Printer', group: 'tools', action: 'print', enabled: always },
  {
    id: 'calendar-settings', label: 'Kalender-Einstellungen', icon: 'Settings', group: 'more', action: 'settings',
    enabled: always, placement: 'overflow',
  },
];

/** The navigation part of the toolbar row (components/calendar/CalendarNavBar.tsx). */
export const CALENDAR_NAV = ['today', 'prev', 'next', 'period'] as const;

/** The button at the top of the calendar list card (wide screens). */
export const CALENDAR_SIDEBAR = ['new'] as const;

export interface ResolvedCommand {
  id: string;
  label: string;
  icon: string;
  group: ToolbarCommandDef['group'];
  action: CalendarAction | null;
  enabled: boolean;
  pressed: boolean | undefined;
  options: ToolbarOption[] | undefined;
  tooltip: string | undefined;
  placement: ToolbarPlacement;
}

/** Evaluate the toolbar for the current page state: hidden commands dropped, state functions applied. */
export function resolveToolbar(state: ToolbarState, defs: readonly ToolbarCommandDef[] = CALENDAR_TOOLBAR): ResolvedCommand[] {
  return defs
    .filter((c) => (c.visible ? c.visible(state) : true))
    .map((c) => ({
      id: c.id,
      label: c.labelFor ? c.labelFor(state) : c.label,
      icon: c.icon,
      group: c.group,
      action: c.action,
      enabled: c.enabled(state),
      pressed: c.pressed?.(state),
      options: c.options?.(state),
      tooltip: c.tooltip,
      placement: c.placement ?? 'auto',
    }));
}

/** Resolved commands grouped (first-appearance order of the groups). */
export function groupToolbar(commands: readonly ResolvedCommand[]): Array<{ group: ResolvedCommand['group']; commands: ResolvedCommand[] }> {
  const groups: Array<{ group: ResolvedCommand['group']; commands: ResolvedCommand[] }> = [];
  for (const c of commands) {
    let g = groups.find((x) => x.group === c.group);
    if (!g) { g = { group: c.group, commands: [] }; groups.push(g); }
    g.commands.push(c);
  }
  return groups;
}

export type ParsedAction =
  | { kind: 'view'; view: CalendarViewId }
  | { kind: 'slot'; minutes: SlotMinutes }
  | { kind: 'plain'; action: CalendarAction };

/** Split the parameterised `view:…` / `slot:…` actions from the plain ones. */
export function parseAction(a: CalendarAction): ParsedAction {
  if (a.startsWith('view:')) return { kind: 'view', view: a.slice(5) as CalendarViewId };
  if (a.startsWith('slot:')) return { kind: 'slot', minutes: Number(a.slice(5)) as SlotMinutes };
  return { kind: 'plain', action: a };
}
