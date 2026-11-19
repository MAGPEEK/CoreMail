/**
 * 10.2: the calendar ribbon as pure data — tabs Start / Ansicht / Hilfe with commands
 * that map to EXISTING calendar actions only. No imports: unit-tested with `node --test`.
 *
 * Rendering is a separate, thin layer (components/CalendarToolbar.tsx on the shared
 * components/Ribbon.tsx): `resolveRibbon(state)` and an action dispatcher.
 */

export type CalendarViewId = 'timeGridDay' | 'timeGridWeek' | 'workWeek' | 'dayGridMonth';
export type RibbonTabId = 'start' | 'view' | 'help';

export const SLOT_MINUTES = [5, 10, 15, 30, 60] as const;
export type SlotMinutes = typeof SLOT_MINUTES[number];

/** Everything a command may do; interpreted by the page's dispatcher. */
export type CalendarAction =
  | 'new-event' | 'new-meeting' | 'new-allday' | 'new-mail' | 'today'
  | `view:${CalendarViewId}`
  | 'filter' | 'share' | 'print' | 'agenda'
  | `slot:${SlotMinutes}`
  | 'settings' | 'shortcuts' | 'about';

/** Page state the enabled / pressed / visible logic depends on. */
export interface RibbonState {
  view: CalendarViewId;
  /** Number of filters that differ from the default. */
  activeFilters: number;
  /** The user owns at least one calendar (needed for sharing). */
  hasOwnCalendar: boolean;
  /** Current time scale in minutes (Settings → Kalender). */
  slotMinutes: number;
  /** The day agenda panel is open. */
  agendaOpen: boolean;
  /** An "about" dialog exists in this build. */
  aboutAvailable: boolean;
}

export interface RibbonOption {
  id: string;
  label: string;
  icon: string;
  action: CalendarAction;
  /** A separator is drawn above this entry. */
  separatorBefore?: boolean;
}

export interface RibbonCommandDef {
  id: string;
  label: string;
  /** lucide icon name (resolved by the render layer). */
  icon: string;
  /** Group caption inside the tab. */
  group: string;
  /** Main action; null = dropdown only. */
  action: CalendarAction | null;
  enabled: (s: RibbonState) => boolean;
  /** Hidden entirely (not just disabled) when this returns false. */
  visible?: (s: RibbonState) => boolean;
  pressed?: (s: RibbonState) => boolean;
  /** Dropdown entries: with a main action → split button, without → plain dropdown. */
  options?: (s: RibbonState) => RibbonOption[];
  /** Label that depends on the state (e.g. "Filter angewendet"). */
  labelFor?: (s: RibbonState) => string;
  tooltip?: string;
}

export interface RibbonTabDef {
  id: RibbonTabId;
  label: string;
  commands: RibbonCommandDef[];
}

const always = () => true;

const viewCommand = (id: CalendarViewId, label: string, icon: string): RibbonCommandDef => ({
  id: `view-${id}`, label, icon, group: 'Anordnen', action: `view:${id}`, enabled: always, pressed: (s) => s.view === id,
});

const VIEW_COMMANDS = (): RibbonCommandDef[] => [
  viewCommand('timeGridDay', 'Tag', 'Calendar'),
  viewCommand('workWeek', 'Arbeitswoche', 'Briefcase'),
  viewCommand('timeGridWeek', 'Woche', 'Columns3'),
  viewCommand('dayGridMonth', 'Monat', 'LayoutGrid'),
];

export const CALENDAR_RIBBON: readonly RibbonTabDef[] = [
  {
    id: 'start',
    label: 'Start',
    commands: [
      {
        id: 'new', label: 'Neues Ereignis', icon: 'Plus', group: 'Neu', action: 'new-event',
        enabled: always,
        tooltip: 'Neues Ereignis im Kalender anlegen',
        options: () => [
          { id: 'event', label: 'Ereignis', icon: 'CalendarPlus', action: 'new-event' },
          { id: 'meeting', label: 'Besprechung', icon: 'Users', action: 'new-meeting' },
          { id: 'allday', label: 'Ganztägiges Ereignis', icon: 'Sun', action: 'new-allday' },
          { id: 'mail', label: 'E-Mail', icon: 'Mail', action: 'new-mail', separatorBefore: true },
        ],
      },
      { id: 'today', label: 'Heute', icon: 'CalendarCheck', group: 'Gehe zu', action: 'today', enabled: always },
      ...VIEW_COMMANDS(),
      {
        id: 'filter', label: 'Filter', icon: 'Filter', group: 'Filter', action: 'filter', enabled: always,
        pressed: (s) => s.activeFilters > 0,
        labelFor: (s) => (s.activeFilters > 0 ? 'Filter angewendet' : 'Filter'),
      },
      {
        id: 'share', label: 'Teilen', icon: 'Share2', group: 'Teilen', action: 'share',
        enabled: (s) => s.hasOwnCalendar,
        tooltip: 'Eigenen Kalender teilen',
      },
      { id: 'print', label: 'Drucken', icon: 'Printer', group: 'Teilen', action: 'print', enabled: always },
    ],
  },
  {
    id: 'view',
    label: 'Ansicht',
    commands: [
      ...VIEW_COMMANDS(),
      {
        id: 'time-scale', label: 'Zeitskala', icon: 'Clock', group: 'Zeitraster', action: null,
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
        id: 'agenda', label: 'Tagesagenda', icon: 'ListTodo', group: 'Anordnen', action: 'agenda', enabled: always,
        pressed: (s) => s.agendaOpen,
      },
      { id: 'calendar-settings', label: 'Kalendereinstellungen', icon: 'Settings', group: 'Einstellungen', action: 'settings', enabled: always },
    ],
  },
  {
    id: 'help',
    label: 'Hilfe',
    commands: [
      { id: 'shortcuts', label: 'Tastenkürzel', icon: 'Keyboard', group: 'Hilfe', action: 'shortcuts', enabled: always },
      {
        id: 'about', label: 'Über CoreMail', icon: 'Info', group: 'Hilfe', action: 'about',
        enabled: always, visible: (s) => s.aboutAvailable,
      },
    ],
  },
];

export interface ResolvedCommand {
  id: string;
  label: string;
  icon: string;
  group: string;
  action: CalendarAction | null;
  enabled: boolean;
  pressed: boolean | undefined;
  options: RibbonOption[] | undefined;
  tooltip: string | undefined;
}

export interface ResolvedTab {
  id: RibbonTabId;
  label: string;
  commands: ResolvedCommand[];
}

/** Evaluate the ribbon for the current page state: hidden commands dropped, state functions applied. */
export function resolveRibbon(state: RibbonState, tabs: readonly RibbonTabDef[] = CALENDAR_RIBBON): ResolvedTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    commands: tab.commands
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
      })),
  }));
}

/**
 * Commands of the given tabs grouped by their caption, each command once (the view
 * buttons sit on Start and on Ansicht). Groups keep their first-appearance order.
 * The ribbon passes the one selected tab.
 */
export function flattenRibbon(tabs: readonly ResolvedTab[]): Array<{ group: string; commands: ResolvedCommand[] }> {
  const seen = new Set<string>();
  const groups: Array<{ group: string; commands: ResolvedCommand[] }> = [];
  for (const tab of tabs) {
    for (const c of tab.commands) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      let g = groups.find((x) => x.group === c.group);
      if (!g) { g = { group: c.group, commands: [] }; groups.push(g); }
      g.commands.push(c);
    }
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
