/**
 * Item model of the app rail (left icon bar; a bottom bar below 768 px, the
 * Tailwind `md` breakpoint). Icons are mapped by id in components/AppRail.tsx,
 * labels come from the i18n table. Settings are not on the rail — they live behind
 * the gear in the header. Only type imports — unit-tested with `node --test`.
 */
import type { TranslationKey } from '../i18n/translations.ts';

export type AppId = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes';

export interface RailItem {
  id: AppId;
  /** i18n key of the visible label (tooltip on wide screens, caption on the bottom bar) and accessible name. */
  labelKey: TranslationKey;
  path: string;
}

export const RAIL_ITEMS: readonly RailItem[] = Object.freeze([
  { id: 'mail', labelKey: 'rail_mail', path: '/mail' },
  { id: 'calendar', labelKey: 'rail_calendar', path: '/calendar' },
  { id: 'contacts', labelKey: 'rail_contacts', path: '/contacts' },
  { id: 'tasks', labelKey: 'rail_tasks', path: '/tasks' },
  { id: 'notes', labelKey: 'rail_notes', path: '/notes' },
] as const);

/** Pages reached from the header, not from the rail: no rail entry is current there. */
const NOT_ON_RAIL = new Set(['/settings']);

/**
 * App of a route path (`aria-current="page"`); null for header pages (settings),
 * unknown paths (and `/`) belong to mail.
 */
export function activeAppForPath(pathname: string): AppId | null {
  const first = `/${pathname.split('/').filter(Boolean)[0] ?? ''}`;
  if (NOT_ON_RAIL.has(first)) return null;
  if (first === '/shared-mailbox') return 'mail';
  return RAIL_ITEMS.find((i) => i.path === first)?.id ?? 'mail';
}
