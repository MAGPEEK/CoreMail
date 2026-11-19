/**
 * 10.1: the ribbon of the mail view — tab row "Start | Ansicht | Hilfe" (ARIA
 * tablist, automatic activation, ←/→ Home/End), and while a draft is shown in
 * the reading pane the contextual tabs "Nachricht | Einfügen | Text formatieren |
 * Optionen" (announced; selected when a draft opens, back to Start when it goes).
 * Right of the tabs: "Menüband: Vereinfacht / Klassisch" (`ribbon.layout`,
 * simplified forced below 1100 px) and the collapse chevron (`ribbon.collapsed`).
 * The panel is the shared command bar (toolbar, roving focus, overflow "…"):
 * one row of buttons (simplified) or the taller groups with labels (classic).
 * Below 768 px the compact command bar of the narrow layout takes its place.
 * Tab logic: lib/ribbon.ts; Start commands: MailCommandBar useMailCommandGroups;
 * compose tabs: compose/composeRibbonTabs.tsx.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ArrowUpDown, ChevronDown, ChevronUp, Info, Keyboard, LayoutTemplate, MessagesSquare, PanelsTopLeft, RefreshCw, Rows3, SlidersHorizontal,
} from 'lucide-react';
import { api } from '../api/client.js';
import { CommandBar, type CommandGroup } from './CommandBar.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { Modal } from './Modal.js';
import { MailCommandBar, SelectionInfo, useMailCommandGroups, READING_PANE, DENSITY } from './MailCommandBar.js';
import { composeRibbonGroups } from './compose/composeRibbonTabs.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { usePreferences } from '../store/preferences.js';
import { useComposeRibbon } from '../store/composeRibbon.js';
import { useLayoutMode } from '../hooks/useLayoutMode.js';
import { useBranding } from '../hooks/useBranding.js';
import {
  COMPOSE_TABS_ANNOUNCEMENT, RIBBON_TAB_LABELS, isComposeTab, latestReleasedVersion, ribbonTabs, selectableTab,
  tabAfterComposeChange, tabKeyTarget, type RibbonTabId,
} from '../lib/ribbon.js';
import type { SortDir, SortField } from '../lib/preferences.js';
import { fmt, useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

interface Props {
  /** "E-Mail aus Vorlage" (templates module); hidden without it. */
  onNewFromTemplate?: () => void;
  /** "Vorlage einfügen …" in the Einfügen tab (templates module); hidden without it. */
  onInsertTemplate?: () => void;
}

const SORT_FIELDS: { value: SortField; labelKey: TranslationKey }[] = [
  { value: 'date', labelKey: 'view_sort_date' },
  { value: 'from', labelKey: 'view_sort_from' },
  { value: 'subject', labelKey: 'view_sort_subject' },
  { value: 'size', labelKey: 'view_sort_size' },
];
const SORT_DIRS: { value: SortDir; labelKey: TranslationKey }[] = [
  { value: 'desc', labelKey: 'view_sort_desc' },
  { value: 'asc', labelKey: 'view_sort_asc' },
];

/** "Über CoreMail": product name and the released version (GET /changelog). */
function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { productName } = useBranding();
  const { data, isError } = useQuery({
    queryKey: ['changelog-version'],
    queryFn: () => api.get<{ versions: { version: string }[] }>('/changelog'),
    staleTime: 60 * 60_000,
  });
  const version = latestReleasedVersion(data?.versions);
  return (
    <Modal onClose={onClose} labelledBy="about-title" className="bg-surface rounded-xl shadow-2xl w-full max-w-sm p-6">
      <h2 id="about-title" className="text-lg font-semibold text-fg">{fmt(t('help_cmd_about'), { product: productName })}</h2>
      <p className="mt-2 text-sm text-fg-muted">
        {version ? fmt(t('help_about_version'), { version }) : isError ? t('help_about_unknown') : '…'}
      </p>
      <div className="mt-6 flex justify-end">
        <button type="button" autoFocus onClick={onClose} className="btn-secondary text-sm">OK</button>
      </div>
    </Modal>
  );
}

/** Ansicht tab. */
function useViewGroups(): CommandGroup[] {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { readingPane, setReadingPane, density, setDensity, groupByConversation, setGroupByConversation } = useUiPrefs();
  const view = usePreferences((s) => s.prefs.view);
  const update = usePreferences((s) => s.update);
  const folderId = useUiStore((s) => s.selectedFolderId);
  const check = (on: boolean) => ({ checked: on });
  const sync = () => {
    void Promise.all([
      qc.refetchQueries({ queryKey: ['folders'] }),
      folderId ? qc.refetchQueries({ queryKey: ['messages', folderId] }) : Promise.resolve(),
    ]).then(() => toast.success(t('refresh_done'), { duration: 1500 }));
  };
  return [
    { id: 'settings', title: t('view_cmd_settings'), items: [
      { id: 'view-settings', label: t('view_cmd_settings'), tooltip: t('view_cmd_settings_tip'), icon: <SlidersHorizontal size={16} />,
        onClick: () => navigate('/settings#theme') },
    ] },
    { id: 'messages', title: t('ribbon_group_messages'), items: [
      { id: 'conversations', label: t('view_cmd_conversations'), tooltip: t('view_cmd_conversations_tip'), icon: <MessagesSquare size={16} />,
        pressed: groupByConversation, onClick: () => setGroupByConversation(!groupByConversation) },
      { id: 'sort', label: t('view_cmd_sort'), icon: <ArrowUpDown size={16} />, menu: (): ContextMenuItem[] => [
        ...SORT_FIELDS.map(({ value, labelKey }) => ({ label: t(labelKey), ...check(view.sortBy === value), onClick: () => update({ view: { sortBy: value } }) })),
        { type: 'divider' },
        ...SORT_DIRS.map(({ value, labelKey }) => ({ label: t(labelKey), ...check(view.sortDir === value), onClick: () => update({ view: { sortDir: value } }) })),
      ] },
    ] },
    { id: 'layout', title: t('ribbon_group_layout'), items: [
      { id: 'reading-pane', label: t('view_cmd_layout'), icon: <PanelsTopLeft size={16} />, menu: (): ContextMenuItem[] =>
        READING_PANE.map(({ value, labelKey }) => ({ label: t(labelKey), ...check(readingPane === value), onClick: () => setReadingPane(value) })) },
      { id: 'density', label: t('view_cmd_density'), icon: <Rows3 size={16} />, menu: (): ContextMenuItem[] =>
        DENSITY.map(({ value, labelKey }) => ({ label: t(labelKey), ...check(density === value), onClick: () => setDensity(value) })) },
    ] },
    { id: 'sync', title: t('view_cmd_sync'), items: [
      { id: 'sync', label: t('view_cmd_sync'), tooltip: t('view_cmd_sync_tip'), icon: <RefreshCw size={16} />, onClick: sync },
    ] },
  ];
}

/** Hilfe tab. */
function helpGroups(t: (k: TranslationKey) => string, productName: string, openAbout: () => void): CommandGroup[] {
  return [{ id: 'help', title: t('ribbon_group_help'), items: [
    { id: 'shortcuts', label: t('help_cmd_shortcuts'), icon: <Keyboard size={16} />, keyshortcuts: 'Shift+?',
      onClick: () => useUiStore.getState().setShortcutHelpOpen(true) },
    { id: 'about', label: fmt(t('help_cmd_about'), { product: productName }), icon: <Info size={16} />, onClick: openAbout },
  ] }];
}

/** "Menüband: Vereinfacht / Klassisch" (a menu with the two layouts). */
function LayoutSwitch({ classicAllowed }: { classicAllowed: boolean }) {
  const t = useT();
  const layout = usePreferences((s) => s.prefs.ribbon.layout);
  const update = usePreferences((s) => s.update);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = classicAllowed ? layout : 'simplified';
  const label = `${t('ribbon_layout')}: ${t(shown === 'classic' ? 'ribbon_layout_classic' : 'ribbon_layout_simplified')}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={classicAllowed ? label : `${label} — ${t('ribbon_layout_forced')}`}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2 }); }}
        className="inline-flex items-center gap-1 h-8 px-2 rounded text-xs text-fg-muted hover:bg-surface-2 hover:text-fg whitespace-nowrap"
      >
        <LayoutTemplate size={14} aria-hidden="true" />
        <span className="max-xl:sr-only">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} autoFocus onClose={() => { setMenu(null); button.current?.focus(); }} items={[
          { label: t('ribbon_layout_simplified'), checked: shown === 'simplified', onClick: () => update({ ribbon: { layout: 'simplified' } }) },
          {
            label: t('ribbon_layout_classic'), checked: shown === 'classic',
            ...(classicAllowed ? {} : { disabled: true, title: t('ribbon_layout_forced') }),
            onClick: () => update({ ribbon: { layout: 'classic' } }),
          },
        ]} />
      )}
    </>
  );
}

export function MailRibbon({ onNewFromTemplate, onInsertTemplate }: Props) {
  const t = useT();
  const mode = useLayoutMode();
  const baseId = useId();
  const { productName } = useBranding();
  const { selectedIds, clearSelection } = useUiStore();
  const composeKey = useUiStore((s) => s.compose.activeKey);
  const composeApi = useComposeRibbon((s) => s.api);
  const ribbonPrefs = usePreferences((s) => s.prefs.ribbon);
  const update = usePreferences((s) => s.update);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const composeShown = !!composeKey && composeApi?.tabKey === composeKey;
  const [tab, setTab] = useState<RibbonTabId>('start');
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    const next = composeShown ? composeKey : null;
    const prev = shownKey.current; // read now: the updater runs later, after the ref has moved on
    setTab((current) => tabAfterComposeChange(current, prev, next));
    if (next && next !== shownKey.current) setAnnouncement(COMPOSE_TABS_ANNOUNCEMENT);
    shownKey.current = next;
  }, [composeShown, composeKey]);

  const narrow = mode === 'single';
  const classicAllowed = mode === 'three';
  const variant = classicAllowed && ribbonPrefs.layout === 'classic' ? 'ribbon' : 'inline';
  const collapsed = ribbonPrefs.collapsed;
  const activeTab = selectableTab(tab, composeShown);

  // The compose card keeps only Senden while the ribbon offers its commands
  useEffect(() => {
    useComposeRibbon.getState().setShownFor(!narrow && !collapsed && composeShown ? composeKey : null);
    return () => useComposeRibbon.getState().setShownFor(null);
  }, [narrow, collapsed, composeShown, composeKey]);

  const start = useMailCommandGroups({ ribbon: true, onNewFromTemplate });
  const viewGroups = useViewGroups();

  if (narrow) return <MailCommandBar {...(onNewFromTemplate ? { onNewFromTemplate } : {})} />;

  const tabs = ribbonTabs(composeShown);
  const tabId = (id: RibbonTabId) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;
  const groups: CommandGroup[] = activeTab === 'start' ? start.groups
    : activeTab === 'view' ? viewGroups
      : activeTab === 'help' ? helpGroups(t, productName, () => setAboutOpen(true))
        : composeApi ? composeRibbonGroups(activeTab, composeApi, t, { onInsertTemplate }) : [];

  const select = (id: RibbonTabId) => {
    setTab(id);
    // a collapsed ribbon opens again when a tab is chosen
    if (collapsed) update({ ribbon: { collapsed: false } });
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    const next = tabKeyTarget(e.key, tabs, activeTab);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  const tabButton = (id: RibbonTabId): ReactNode => {
    const selected = id === activeTab;
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
        {RIBBON_TAB_LABELS[id]}
        {selected && <span aria-hidden="true" className="absolute left-3 right-3 bottom-0 h-[3px] rounded-full bg-accent" />}
      </button>
    );
  };

  return (
    <div className="flex flex-col min-w-0" data-ribbon>
      <div className="flex items-end gap-1 px-2 pt-1 min-w-0">
        <div role="tablist" aria-label={t('ribbon_tabs_label')} onKeyDown={onTabKey} className="flex items-end min-w-0 overflow-x-auto">
          {tabs.filter((id) => !isComposeTab(id)).map(tabButton)}
          {composeShown && <span aria-hidden="true" className="self-center mx-1 h-5 w-px bg-line-strong" />}
          {tabs.filter(isComposeTab).map(tabButton)}
        </div>
        <div className="ml-auto flex items-center gap-1 pb-0.5 shrink-0">
          <LayoutSwitch classicAllowed={classicAllowed} />
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
        aria-labelledby={tabId(activeTab)}
        hidden={collapsed}
        className={`border-t border-line px-1 ${variant === 'ribbon' ? 'py-0.5' : 'py-1'}`}
      >
        {!collapsed && (
          <CommandBar
            key={`${activeTab}:${variant}`}
            label={`${t('ribbon_label')}: ${RIBBON_TAB_LABELS[activeTab]}`}
            groups={groups}
            variant={variant}
            className="flex-1"
            end={activeTab === 'start' && selectedIds.size > 0 ? <SelectionInfo count={selectedIds.size} onClear={clearSelection} /> : null}
          />
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {start.dialogs}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
