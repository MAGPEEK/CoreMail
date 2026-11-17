/**
 * Item model of the app rail (left icon bar; a bottom bar below 768 px, the
 * Tailwind `md` breakpoint). Icons are mapped by id in components/AppRail.tsx. No imports —
 * unit-tested with `node --test`.
 */
export type AppId = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes' | 'settings';

export interface RailItem {
  id: AppId;
  /** Visible label (tooltip on wide screens, caption on the bottom bar) and accessible name. */
  label: string;
  path: string;
  /** main = top group, end = pinned to the end of the rail (Einstellungen) */
  group: 'main' | 'end';
}

export const RAIL_ITEMS: readonly RailItem[] = Object.freeze([
  { id: 'mail', label: 'Mail', path: '/mail', group: 'main' },
  { id: 'calendar', label: 'Kalender', path: '/calendar', group: 'main' },
  { id: 'contacts', label: 'Kontakte', path: '/contacts', group: 'main' },
  { id: 'tasks', label: 'Aufgaben', path: '/tasks', group: 'main' },
  { id: 'notes', label: 'Notizen', path: '/notes', group: 'main' },
  { id: 'settings', label: 'Einstellungen', path: '/settings', group: 'end' },
] as const);

export function railItemsIn(group: RailItem['group']): RailItem[] {
  return RAIL_ITEMS.filter((i) => i.group === group);
}

/** App of a route path (`aria-current="page"`); unknown paths (and `/`) belong to mail. */
export function activeAppForPath(pathname: string): AppId {
  const first = `/${pathname.split('/').filter(Boolean)[0] ?? ''}`;
  if (first === '/shared-mailbox') return 'mail';
  return RAIL_ITEMS.find((i) => i.path === first)?.id ?? 'mail';
}
