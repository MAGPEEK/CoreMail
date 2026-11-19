/**
 * The ONE render layer between the pure calendar ribbon (lib/calendarRibbon.ts) and the UI.
 *
 * Today it feeds the existing CommandBar (a single flat ribbon, no tabs). To move the page to
 * the shared tabbed ribbon, replace the `<CommandBar groups={ribbonToCommandGroups(...)} />`
 * call in components/CalendarToolbar.tsx with the shared component and hand it
 * `resolveRibbon(state)` (tabs Start / Ansicht / Hilfe) plus the same `onAction` dispatcher;
 * `ICONS` below resolves the icon names for either target.
 */
import type { ReactNode } from 'react';
import {
  Plus, CalendarPlus, Mail, CalendarCheck, Calendar as CalDay, Briefcase, Columns3, LayoutGrid,
  Filter, Share2, Printer, Clock, Settings, Keyboard, Info, ListTodo, Users, Sun,
} from 'lucide-react';
import type { CommandGroup, CommandItem } from '../CommandBar.js';
import {
  flattenRibbon, resolveRibbon, type CalendarAction, type ResolvedCommand, type RibbonState,
} from '../../lib/calendarRibbon.js';

export const ICONS: Record<string, React.ElementType> = {
  Plus, CalendarPlus, Mail, CalendarCheck, Calendar: CalDay, Briefcase, Columns3, LayoutGrid,
  Filter, Share2, Printer, Clock, Settings, Keyboard, Info, ListTodo, Users, Sun,
};

export type RibbonDispatch = (action: CalendarAction, anchor?: HTMLElement) => void;

const icon = (name: string, size: number, className?: string): ReactNode => {
  const Icon = ICONS[name];
  return Icon ? <Icon size={size} {...(className ? { className } : {})} aria-hidden="true" /> : null;
};

/** A command whose action opens a popover of its own (aria-haspopup + aria-expanded). */
export interface RibbonPopover { action: CalendarAction; open: boolean }

function toItem(c: ResolvedCommand, dispatch: RibbonDispatch, popover?: RibbonPopover): CommandItem {
  const { action, options } = c;
  const isNew = c.id === 'new';
  return {
    id: c.id,
    label: c.label,
    icon: icon(c.icon, 20, isNew || (c.id === 'filter' && c.pressed) ? 'text-accent-fg' : undefined),
    disabled: !c.enabled,
    ...(popover && action === popover.action ? { dialogOpen: popover.open } : {}),
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

/** Pure data → CommandBar groups (all tabs flattened, each command once). */
export function ribbonToCommandGroups(state: RibbonState, dispatch: RibbonDispatch, popover?: RibbonPopover): CommandGroup[] {
  return flattenRibbon(resolveRibbon(state)).map(({ group, commands }) => ({
    id: group,
    title: group,
    items: commands.map((c) => toItem(c, dispatch, popover)),
  }));
}
