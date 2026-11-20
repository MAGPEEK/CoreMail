/**
 * 10.2: the shared ribbon of the app pages (mail, calendar, contacts): a tab row
 * (ARIA tablist, automatic activation, ←/→ Home/End; contextual tabs after a
 * divider), right of it the collapse chevron (`ribbon.collapsed`
 * — choosing a tab opens a collapsed ribbon again). The panel is the shared
 * command bar (toolbar, roving focus, overflow "…"): one row of buttons.
 * 10.2: there is only this simplified layout. The page owns the
 * selected tab and the command groups of it; tab logic: lib/ribbon.ts.
 */
import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { CommandBar, type CommandGroup } from './CommandBar.js';
import { usePreferences } from '../store/preferences.js';
import { tabKeyTarget } from '../lib/ribbon.js';
import { useT } from '../i18n/useT.js';

export interface RibbonTab<Id extends string> {
  id: Id;
  label: string;
  /** Shown after a divider (the compose tabs of the mail view). */
  contextual?: boolean;
}

interface Props<Id extends string> {
  /** Accessible name of the command panel, e.g. "Menüband" (the tab label follows). */
  label: string;
  tabs: readonly RibbonTab<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Command groups of the active tab. */
  groups: CommandGroup[];
  /** Content at the end of the command panel (outside its roving focus). */
  end?: ReactNode;
  /** Dialogs, popovers and live regions that belong to the ribbon. */
  children?: ReactNode;
}

export function Ribbon<Id extends string>({ label, tabs, active, onSelect, groups, end, children }: Props<Id>) {
  const t = useT();
  const baseId = useId();
  const ribbonPrefs = usePreferences((s) => s.prefs.ribbon);
  const update = usePreferences((s) => s.update);

  const collapsed = ribbonPrefs.collapsed;
  const ids = tabs.map((tab) => tab.id);
  const tabId = (id: Id) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;
  const activeLabel = tabs.find((tab) => tab.id === active)?.label ?? '';

  const select = (id: Id) => {
    onSelect(id);
    // a collapsed ribbon opens again when a tab is chosen
    if (collapsed) update({ ribbon: { collapsed: false } });
  };
  const onTabKey = (e: KeyboardEvent) => {
    const next = tabKeyTarget(e.key, ids, active);
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    document.getElementById(tabId(next))?.focus();
  };

  const tabButton = ({ id, label: tabLabel }: RibbonTab<Id>): ReactNode => {
    const selected = id === active;
    return (
      <button
        key={id}
        id={tabId(id)}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        tabIndex={selected ? 0 : -1}
        onClick={() => select(id)}
        className={`relative h-8 px-3 text-sm whitespace-nowrap rounded-t transition-colors ${
          selected ? 'text-accent-fg font-semibold' : 'text-fg-muted hover:text-fg hover:bg-surface-2'
        }`}
      >
        {tabLabel}
        {selected && <span aria-hidden="true" className="absolute left-3 right-3 bottom-0 h-[3px] rounded-full bg-accent" />}
      </button>
    );
  };
  const contextual = tabs.filter((tab) => tab.contextual);

  return (
    <div className="flex flex-col min-w-0" data-ribbon>
      <div className="flex items-end gap-1 px-2 pt-1 min-w-0">
        <div role="tablist" aria-label={t('ribbon_tabs_label')} onKeyDown={onTabKey} className="flex items-end min-w-0 overflow-x-auto">
          {tabs.filter((tab) => !tab.contextual).map(tabButton)}
          {contextual.length > 0 && <span aria-hidden="true" className="self-center mx-1 h-5 w-px bg-line-strong" />}
          {contextual.map(tabButton)}
        </div>
        <div className="ml-auto flex items-center gap-1 pb-0.5 shrink-0">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={panelId}
            aria-label={t(collapsed ? 'ribbon_expand' : 'ribbon_collapse')}
            title={t(collapsed ? 'ribbon_expand' : 'ribbon_collapse')}
            onClick={() => update({ ribbon: { collapsed: !collapsed } })}
            className="inline-flex items-center justify-center w-8 h-8 rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            {collapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(active)}
        hidden={collapsed}
        className="border-t border-line px-1 py-1"
      >
        {!collapsed && (
          <CommandBar
            key={active}
            label={`${label}: ${activeLabel}`}
            groups={groups}
            className="flex-1"
            end={end ?? null}
          />
        )}
      </div>
      {children}
    </div>
  );
}
