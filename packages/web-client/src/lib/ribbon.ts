/**
 * 10.1: the ribbon above the mail view — tab row "Start | Ansicht | Hilfe", plus
 * the contextual tabs "Nachricht | Einfügen | Text formatieren | Optionen" while
 * a draft is shown in the reading pane. One row of buttons (overflow "…"),
 * roaming preference `ribbon.collapsed`. Below 768 px there is no ribbon
 * (the mail command bar of the narrow layout takes its place).
 * 10.2: the tab row and collapse are the shared components/Ribbon.tsx (mail,
 * calendar, contacts; the collapse preference applies to all three). Only the
 * simplified layout exists — the classic one was removed in 10.2.
 * No imports — unit-tested with `node --test`.
 */

export type RibbonTabId = 'start' | 'view' | 'help' | 'message' | 'insert' | 'format' | 'options';

export const BASE_TABS: readonly RibbonTabId[] = ['start', 'view', 'help'];
export const COMPOSE_TABS: readonly RibbonTabId[] = ['message', 'insert', 'format', 'options'];

export const RIBBON_TAB_LABELS: Record<RibbonTabId, string> = {
  start: 'Start',
  view: 'Ansicht',
  help: 'Hilfe',
  message: 'Nachricht',
  insert: 'Einfügen',
  format: 'Text formatieren',
  options: 'Optionen',
};

/** Screen-reader note when the contextual tabs appear. */
export const COMPOSE_TABS_ANNOUNCEMENT = 'Registerkarten für Nachricht verfügbar';

/** Tabs of the tab row; the contextual ones only while a draft is shown. */
export function ribbonTabs(composeShown: boolean): RibbonTabId[] {
  return composeShown ? [...BASE_TABS, ...COMPOSE_TABS] : [...BASE_TABS];
}

export function isComposeTab(tab: RibbonTabId): boolean {
  return COMPOSE_TABS.includes(tab);
}

/**
 * Selected tab after the shown draft changed: a draft that appears (or another
 * draft taking its place) selects "Nachricht"; when no draft is shown any more
 * (the last tab closed, a mail was selected) a contextual tab falls back to
 * "Start". Otherwise the selection stays.
 */
export function tabAfterComposeChange(current: RibbonTabId, prevComposeKey: string | null, nextComposeKey: string | null): RibbonTabId {
  if (nextComposeKey && nextComposeKey !== prevComposeKey) return 'message';
  if (!nextComposeKey && isComposeTab(current)) return 'start';
  return current;
}

/** A tab id from the tab row is only selectable while it is shown. */
export function selectableTab(wanted: RibbonTabId, composeShown: boolean): RibbonTabId {
  return ribbonTabs(composeShown).includes(wanted) ? wanted : 'start';
}

/**
 * Keyboard of the tab row (WAI-ARIA tabs, automatic activation): ←/→ wrap,
 * Home/End jump. Returns the tab to select, or null for other keys.
 */
export function tabKeyTarget<Id extends string>(key: string, tabs: readonly Id[], current: Id): Id | null {
  const i = Math.max(0, tabs.indexOf(current));
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length] ?? null;
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length] ?? null;
  if (key === 'Home') return tabs[0] ?? null;
  if (key === 'End') return tabs[tabs.length - 1] ?? null;
  return null;
}

/** "Über CoreMail": the newest released version of GET /changelog (not "Unreleased"), or null. */
export function latestReleasedVersion(versions: readonly { version: string }[] | null | undefined): string | null {
  return versions?.find((v) => /^\d+\.\d+\.\d+/.test(v.version))?.version ?? null;
}

/**
 * Items of the "Neue E-Mail" split menu, in order: E-Mail, E-Mail aus Vorlage (only when a
 * template source exists), Ereignis — and, only while a shared / delegated mailbox is open,
 * "E-Mail aus dem eigenen Postfach" as the last entry.
 */
export type NewItemId = 'mail' | 'template' | 'event' | 'ownMail';
export function newMenuItems(hasTemplates: boolean, foreignMailbox = false): NewItemId[] {
  const items: NewItemId[] = hasTemplates ? ['mail', 'template', 'event'] : ['mail', 'event'];
  return foreignMailbox ? [...items, 'ownMail'] : items;
}
