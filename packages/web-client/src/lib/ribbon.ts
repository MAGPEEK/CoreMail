/**
 * 10.1: the ribbon above the mail view — tab row "Start | Ansicht | Hilfe", plus
 * the contextual tabs "Nachricht | Einfügen | Text formatieren | Optionen" while
 * a draft is shown in the reading pane. Layout "Vereinfacht" (one row of
 * buttons, overflow "…") or "Klassisch" (taller groups with labels under the
 * icons), roaming preferences `ribbon.layout` / `ribbon.collapsed`.
 * Below 1100 px the simplified layout is forced; below 768 px there is no ribbon
 * (the mail command bar of the narrow layout takes its place).
 * No imports — unit-tested with `node --test`.
 */

export type RibbonTabId = 'start' | 'view' | 'help' | 'message' | 'insert' | 'format' | 'options';
export type RibbonLayoutPref = 'simplified' | 'classic';
/** What is drawn: no ribbon (narrow), or one of the layouts. */
export type RibbonMode = 'none' | RibbonLayoutPref;

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

/** Narrowest viewport (px) with a ribbon, and with the classic layout. */
export const RIBBON_MIN_WIDTH = 768;
export const CLASSIC_MIN_WIDTH = 1100;

export function ribbonMode(viewportWidth: number, pref: RibbonLayoutPref): RibbonMode {
  if (viewportWidth < RIBBON_MIN_WIDTH) return 'none';
  if (viewportWidth < CLASSIC_MIN_WIDTH) return 'simplified';
  return pref === 'classic' ? 'classic' : 'simplified';
}

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
export function tabKeyTarget(key: string, tabs: readonly RibbonTabId[], current: RibbonTabId): RibbonTabId | null {
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

/** Items of the "Neue E-Mail" split menu, in order ("E-Mail aus Vorlage" only when a template source exists). */
export type NewItemId = 'mail' | 'template' | 'event';
export function newMenuItems(hasTemplates: boolean): NewItemId[] {
  return hasTemplates ? ['mail', 'template', 'event'] : ['mail', 'event'];
}
