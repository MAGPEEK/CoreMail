/**
 * 10.1: the ribbon of the mail view — tab row "Start | Ansicht | Hilfe", and
 * while a draft is shown in the reading pane the contextual tabs "Nachricht |
 * Einfügen | Text formatieren | Optionen" (announced; selected when a draft
 * opens, back to Start when it goes). Tab row, layouts and collapse: the shared
 * components/Ribbon.tsx (10.2). Below 768 px the compact command bar of the
 * narrow layout takes its place.
 * Tab logic: lib/ribbon.ts; Start commands: MailCommandBar useMailCommandGroups;
 * compose tabs: compose/composeRibbonTabs.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowUpDown, Info, Keyboard, MessagesSquare, PanelsTopLeft, RefreshCw, Rows3, SlidersHorizontal } from 'lucide-react';
import type { CommandGroup } from './CommandBar.js';
import type { ContextMenuItem } from './ContextMenu.js';
import { Ribbon } from './Ribbon.js';
import { AboutDialog } from './AboutDialog.js';
import { MailCommandBar, SelectionInfo, useMailCommandGroups, READING_PANE, DENSITY } from './MailCommandBar.js';
import { composeRibbonGroups } from './compose/composeRibbonTabs.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { usePreferences } from '../store/preferences.js';
import { useComposeRibbon } from '../store/composeRibbon.js';
import { useLayoutMode } from '../hooks/useLayoutMode.js';
import { useBranding } from '../hooks/useBranding.js';
import {
  COMPOSE_TABS_ANNOUNCEMENT, RIBBON_TAB_LABELS, isComposeTab, ribbonTabs, selectableTab, tabAfterComposeChange, type RibbonTabId,
} from '../lib/ribbon.js';
import type { SortDir, SortField } from '../lib/preferences.js';
import { fmt, useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

interface Props {
  /** "E-Mail aus Vorlage" (templates module); hidden without it. */
  onNewFromTemplate?: () => void;
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

export function MailRibbon({ onNewFromTemplate }: Props) {
  const t = useT();
  const mode = useLayoutMode();
  const { productName } = useBranding();
  const { selectedIds, clearSelection } = useUiStore();
  const composeKey = useUiStore((s) => s.compose.activeKey);
  const composeApi = useComposeRibbon((s) => s.api);
  const collapsed = usePreferences((s) => s.prefs.ribbon.collapsed);
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
  const activeTab = selectableTab(tab, composeShown);

  // The compose card keeps only Senden while the ribbon offers its commands
  useEffect(() => {
    useComposeRibbon.getState().setShownFor(!narrow && !collapsed && composeShown ? composeKey : null);
    return () => useComposeRibbon.getState().setShownFor(null);
  }, [narrow, collapsed, composeShown, composeKey]);

  const start = useMailCommandGroups({ ribbon: true, onNewFromTemplate });
  const viewGroups = useViewGroups();

  if (narrow) return <MailCommandBar {...(onNewFromTemplate ? { onNewFromTemplate } : {})} />;

  const groups: CommandGroup[] = activeTab === 'start' ? start.groups
    : activeTab === 'view' ? viewGroups
      : activeTab === 'help' ? helpGroups(t, productName, () => setAboutOpen(true))
        : composeApi ? composeRibbonGroups(activeTab, composeApi, t) : [];

  return (
    <Ribbon
      label={t('ribbon_label')}
      tabs={ribbonTabs(composeShown).map((id) => ({ id, label: RIBBON_TAB_LABELS[id], contextual: isComposeTab(id) }))}
      active={activeTab}
      onSelect={setTab}
      groups={groups}
      end={activeTab === 'start' && selectedIds.size > 0 ? <SelectionInfo count={selectedIds.size} onClear={clearSelection} /> : null}
    >
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {start.dialogs}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </Ribbon>
  );
}
