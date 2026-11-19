/**
 * Mail commands. Act on the checked messages (multi-select), else on the open
 * one. Delete / archive / move / junk / flag / read / undo run through the same
 * handlers as the keyboard shortcuts (MessageList + layout register them), so
 * undo toasts, "open the next mail" and the read-only checks behave identically
 * for mouse and keyboard. Enablement and labels: lib/mailCommands.ts; texts: i18n.
 *
 * Two arrangements of the same commands (useMailCommandGroups):
 *  - `ribbon` — the Start tab of the ribbon (10.1, components/MailRibbon.tsx):
 *    Neu | Löschen | Melden | Antworten | Markieren | Weiteres;
 *  - the compact bar of the narrow layout (< 768 px, MailCommandBar below).
 * "Neue E-Mail" is a split button in both (the only accent-filled control): the
 * main part writes a new mail, the chevron / Alt+↓ offers E-Mail, E-Mail aus
 * Vorlage (when a template source is wired in) and Ereignis.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  SquarePen, Mail, Trash2, Archive, FolderInput, AlertOctagon, ShieldOff, Flag, FlagOff,
  MailOpen, Tag, Pin, Undo2, PanelsTopLeft, Check, X, CalendarPlus, FileText, Reply, ReplyAll, Forward,
  CheckCheck, Printer, Folder as FolderIcon, Ban,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Category, Folder } from '../api/types.js';
import { useUiStore, useUiPrefs, type Density, type ReadingPane } from '../store/ui.js';
import { useActiveMailbox } from '../hooks/useActiveMailbox.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { useTargetMessages } from '../hooks/useTargetMessages.js';
import { useFollowUp } from '../hooks/useFollowUp.js';
import { dispatchShortcut, useAriaKeys } from '../hooks/useShortcuts.js';
import { toastError } from '../lib/errors.js';
import { OWN_MAILBOX } from '../lib/mailboxContext.js';
import {
  categoryCoverage, commandTargets, mailCommandStates, nextCategoryIds, readToggle, ribbonMailStates, summarizeSelection,
  type CommandState, type MailCommandId, type RibbonMailCommandId,
} from '../lib/mailCommands.js';
import { newMenuItems } from '../lib/ribbon.js';
import type { ShortcutAction } from '../lib/shortcuts.js';
import { CommandBar, type CommandGroup, type CommandItem } from './CommandBar.js';
import type { ContextMenuItem } from './ContextMenu.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { NewEventDialog } from './NewEventDialog.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

export const READING_PANE: { value: ReadingPane; labelKey: TranslationKey }[] = [
  { value: 'right', labelKey: 'mail_view_pane_right' },
  { value: 'bottom', labelKey: 'mail_view_pane_bottom' },
  { value: 'off', labelKey: 'mail_view_pane_off' },
];
export const DENSITY: { value: Density; labelKey: TranslationKey }[] = [
  { value: 'compact', labelKey: 'mail_view_density_compact' },
  { value: 'normal', labelKey: 'mail_view_density_normal' },
  { value: 'comfortable', labelKey: 'mail_view_density_comfortable' },
];

export const checkIcon = (on: boolean) => (on ? <Check size={14} /> : undefined);

/** Selected-messages counter + "clear selection" (outside the toolbar's roving focus). */
export function SelectionInfo({ count, onClear }: { count: number; onClear: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 pl-2 shrink-0">
      <span role="status" className="text-xs font-semibold text-accent-fg whitespace-nowrap">
        <AnimatedCounter value={count} /> {t('mail_selected')}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('mail_clear_selection')}
        title={t('mail_clear_selection')}
        className="p-1 rounded text-fg-subtle hover:bg-surface-2 hover:text-fg transition-colors"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface MailCommandOptions {
  /** Start tab of the ribbon (true) or the compact narrow bar. */
  ribbon: boolean;
  /** "E-Mail aus Vorlage" — supplied by the templates module; the entry is hidden without it. */
  onNewFromTemplate?: (() => void) | undefined;
}

/** Command groups + the dialogs they open (render `dialogs` next to the bar). */
export function useMailCommandGroups({ ribbon, onNewFromTemplate }: MailCommandOptions): { groups: CommandGroup[]; dialogs: ReactNode } {
  const t = useT();
  const navigate = useNavigate();
  const { selectedIds, selectedMessageId, selectedFolderId, clearSelection, setSelectedMessage, openCompose, recentMoveTargets } = useUiStore();
  const { readingPane, setReadingPane, density, setDensity, groupByConversation, setGroupByConversation } = useUiPrefs();
  const mailbox = useActiveMailbox();
  const { setState, invalidate, runWithUndo, locateIds, markFolderRead } = useMailActions();
  const ariaKeys = useAriaKeys();
  const [eventOpen, setEventOpen] = useState(false);

  const targets = commandTargets(selectedIds, selectedMessageId);
  const known = useTargetMessages(targets);
  const followUp = useFollowUp();

  const { data: folders = [] } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });
  // Categories are personal — own mailbox only; 9.4: the module can be switched off
  const categoriesOn = useWebmailFeatures().features.categories;
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
    enabled: !mailbox.foreign && categoriesOn,
  });

  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isJunkFolder = currentFolder?.name === 'Junk';
  const selection = summarizeSelection(targets.length, known);
  const states = mailCommandStates({ selection, readOnly: mailbox.readOnly, foreign: mailbox.foreign, isJunkFolder }, t);
  const extra = ribbonMailStates({
    selection, readOnly: mailbox.readOnly, foreign: mailbox.foreign, isJunkFolder,
    hasFolder: !!currentFolder, folderUnread: currentFolder?.unreadCount ?? 0,
    hasOpenMessage: !!selectedMessageId && selectedIds.size === 0,
  }, t);

  const leaveTargets = () => {
    if (selectedMessageId && targets.includes(selectedMessageId)) setSelectedMessage(null);
    clearSelection();
  };

  const applyCategory = (categoryId: string, removeFromAll: boolean) => {
    void Promise.all(known.map((m) => api.post(`/categories/messages/${m.id}`, {
      categoryIds: nextCategoryIds(m.categoryIds, categoryId, removeFromAll),
    }))).catch(toastError).finally(invalidate);
  };

  const categoryMenu = (): ContextMenuItem[] => [
    ...categories.map((c): ContextMenuItem => {
      const all = categoryCoverage(known.map((m) => m.categoryIds), c.id) === 'all';
      return {
        label: c.name,
        icon: all
          ? <Check size={14} style={{ color: c.color }} />
          : <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: c.color }} />,
        ...(all ? { title: t('mail_cmd_category_assigned') } : {}),
        onClick: () => applyCategory(c.id, all),
      };
    }),
    ...(categories.length ? [{ type: 'divider' as const }] : []),
    { label: t('mail_cmd_categories_manage'), icon: <Tag size={14} />, onClick: () => navigate('/settings#categories') },
  ];

  const viewMenu = (): ContextMenuItem[] => [
    ...READING_PANE.map(({ value, labelKey }) => ({ label: t(labelKey), icon: checkIcon(readingPane === value), onClick: () => setReadingPane(value) })),
    { type: 'divider' },
    ...DENSITY.map(({ value, labelKey }) => ({ label: t(labelKey), icon: checkIcon(density === value), onClick: () => setDensity(value) })),
    { type: 'divider' },
    { label: t('mail_view_conversations'), icon: checkIcon(groupByConversation), onClick: () => setGroupByConversation(!groupByConversation) },
  ];

  const newItems: Record<'mail' | 'template' | 'event', ContextMenuItem> = {
    mail: { label: t('mail_cmd_new_mail'), icon: <Mail size={14} />, onClick: () => openCompose() },
    template: { label: t('mail_cmd_new_template'), icon: <FileText size={14} />, onClick: () => onNewFromTemplate?.() },
    event: { label: t('mail_cmd_new_event'), icon: <CalendarPlus size={14} />, onClick: () => setEventOpen(true) },
  };
  const newMenu = (): ContextMenuItem[] => newMenuItems(!!onNewFromTemplate).flatMap((id): ContextMenuItem[] => [
    newItems[id],
    // a shared / delegated mailbox is shown: a mail from the own mailbox stays one click away
    ...(id === 'mail' && mailbox.foreign
      ? [{ label: t('mail_cmd_new_mail_own'), icon: <Mail size={14} />, onClick: () => openCompose({ mailbox: OWN_MAILBOX }) }]
      : []),
  ]);

  /** Common fields of a command from its state. */
  const fromState = (id: string, s: CommandState, icon: ReactNode, more: Partial<CommandItem> = {}): CommandItem =>
    ({ id, label: s.label, tooltip: s.tooltip, icon, ...(s.enabled ? {} : { disabled: true }), ...more });
  const cmd = (id: MailCommandId, icon: ReactNode, more: Partial<CommandItem> = {}) => fromState(id, states[id], icon, more);
  const rcmd = (id: RibbonMailCommandId, icon: ReactNode, more: Partial<CommandItem> = {}) => fromState(id, extra[id], icon, more);
  const viaShortcut = (action: ShortcutAction) => ({
    onClick: () => { dispatchShortcut(action); },
    keyshortcuts: ariaKeys(action),
  });

  const respond = (mode: 'reply' | 'replyAll' | 'forward') => () => {
    const m = known[0];
    if (!m) return;
    openCompose({ mode, id: m.id, subject: m.subject, fromAddr: m.fromAddr, ...(mode === 'replyAll' ? { toAddrs: m.toAddrs } : {}) });
  };

  const moveTo = (folderId: string) => {
    void runWithUndo('move', locateIds(targets, selectedFolderId ?? ''), folderId).then((done) => { if (done) leaveTargets(); });
  };
  const folderLabel = (f: Folder) => f.displayName ?? f.name;
  const moveMenu = (): ContextMenuItem[] => {
    const recent = recentMoveTargets
      .map((id) => folders.find((f) => f.id === id))
      .filter((f): f is Folder => !!f && f.id !== selectedFolderId);
    return [
      ...(recent.length ? [{ label: t('mail_cmd_recent_folders'), disabled: true } as ContextMenuItem] : []),
      ...recent.map((f): ContextMenuItem => ({ label: folderLabel(f), icon: <FolderIcon size={14} />, onClick: () => moveTo(f.id) })),
      ...(recent.length ? [{ type: 'divider' as const }] : []),
      { label: t('mail_cmd_move_other'), icon: <FolderInput size={14} />, onClick: () => { dispatchShortcut('mail.move'); } },
    ];
  };

  const markAllRead = () => {
    if (!selectedFolderId) return;
    void markFolderRead(selectedFolderId)
      .then((n) => { toast.success(`${t('mark_all_read')}${n ? ` (${n})` : ''}`, { duration: 1500 }); })
      .catch(toastError);
  };

  const flagItem = cmd('flag', selection.allFlagged ? <FlagOff size={16} /> : <Flag size={16} />, {
    ...viaShortcut('mail.flag'),
    // 9.4: split button — click toggles, the menu sets due dates / reminder / complete (own mailbox)
    ...(!mailbox.foreign && known.length > 0 ? { menu: () => followUp.menu(known) } : {}),
  });
  const readItem = readToggle(selection) === 'read'
    ? cmd('read', <MailOpen size={16} />, viaShortcut('mail.markRead'))
    : cmd('read', <Mail size={16} />, viaShortcut('mail.markUnread'));
  const junkItem = (label?: string) => (isJunkFolder
    ? cmd('junk', <ShieldOff size={16} />, { onClick: () => { void setState('notSpam', targets).then(leaveTargets); } })
    : cmd('junk', <AlertOctagon size={16} />, { ...viaShortcut('mail.spam'), ...(label ? { label } : {}) }));
  const newItem = cmd('new', <SquarePen size={16} />, {
    tone: 'primary', placement: 'pinned', keyshortcuts: ariaKeys('compose.new'),
    onClick: () => openCompose(), menu: newMenu,
  });

  const groups: CommandGroup[] = ribbon ? [
    { id: 'new', title: t('mail_group_new'), items: [newItem] },
    { id: 'delete', title: t('ribbon_group_delete'), items: [
      cmd('delete', <Trash2 size={16} />, {
        ...viaShortcut('mail.delete'),
        menu: () => [
          { label: t('mail_cmd_delete'), icon: <Trash2 size={14} />, ...(states.delete.enabled ? {} : { disabled: true }), onClick: () => { dispatchShortcut('mail.delete'); } },
          {
            label: t('mail_cmd_delete_permanent'), icon: <Ban size={14} />, danger: true,
            ...(extra.deletePermanent.enabled ? {} : { disabled: true, title: extra.deletePermanent.tooltip }),
            onClick: () => { dispatchShortcut('mail.deletePermanent'); },
          },
        ],
      }),
      cmd('archive', <Archive size={16} />, viaShortcut('mail.archive')),
      cmd('move', <FolderInput size={16} />, { label: t('mail_cmd_move_to'), menu: moveMenu }),
    ] },
    { id: 'report', title: t('ribbon_group_report'), items: [junkItem(t('mail_cmd_junk_mail'))] },
    { id: 'respond', title: t('ribbon_group_respond'), items: [
      rcmd('reply', <Reply size={16} />, { onClick: respond('reply'), keyshortcuts: ariaKeys('mail.reply') }),
      rcmd('replyAll', <ReplyAll size={16} />, { onClick: respond('replyAll'), keyshortcuts: ariaKeys('mail.replyAll') }),
      rcmd('forward', <Forward size={16} />, { onClick: respond('forward'), keyshortcuts: ariaKeys('mail.forward') }),
    ] },
    { id: 'mark', title: t('mail_group_mark'), items: [
      rcmd('markAllRead', <CheckCheck size={16} />, { onClick: markAllRead }),
      readItem,
      ...(categoriesOn ? [cmd('categorize', <Tag size={16} />, { menu: categoryMenu })] : []),
      flagItem,
    ] },
    { id: 'more', title: t('ribbon_group_more'), items: [
      rcmd('print', <Printer size={16} />, { onClick: () => window.print() }),
      cmd('undo', <Undo2 size={16} />, viaShortcut('undo')),
    ] },
  ] : [
    { id: 'new', title: t('mail_group_new'), items: [newItem] },
    { id: 'organize', title: t('mail_group_organize'), items: [
      cmd('delete', <Trash2 size={16} />, viaShortcut('mail.delete')),
      cmd('archive', <Archive size={16} />, viaShortcut('mail.archive')),
      cmd('move', <FolderInput size={16} />, viaShortcut('mail.move')),
      junkItem(),
    ] },
    { id: 'mark', title: t('mail_group_mark'), items: [
      flagItem,
      readItem,
      ...(categoriesOn ? [cmd('categorize', <Tag size={16} />, { menu: categoryMenu })] : []),
      cmd('pin', <Pin size={16} />, { onClick: () => { void setState(selection.allPinned ? 'unpin' : 'pin', targets); } }),
    ] },
    { id: 'history', title: t('mail_cmd_undo'), items: [
      cmd('undo', <Undo2 size={16} />, viaShortcut('undo')),
    ] },
    { id: 'view', title: t('mail_cmd_view'), items: [
      cmd('view', <PanelsTopLeft size={16} />, { menu: viewMenu }),
    ] },
  ];

  const dialogs = (
    <>
      {followUp.dialog}
      {eventOpen && <NewEventDialog onClose={() => setEventOpen(false)} />}
    </>
  );
  return { groups, dialogs };
}

/** The compact command bar of the narrow layout (below 768 px the ribbon is not shown). */
export function MailCommandBar({ onNewFromTemplate }: { onNewFromTemplate?: () => void }) {
  const t = useT();
  const { selectedIds, clearSelection } = useUiStore();
  const { groups, dialogs } = useMailCommandGroups({ ribbon: false, onNewFromTemplate });
  return (
    <>
      <CommandBar
        label={t('mail_commands_label')}
        groups={groups}
        className="flex-1"
        end={selectedIds.size > 0 ? <SelectionInfo count={selectedIds.size} onClear={clearSelection} /> : null}
      />
      {dialogs}
    </>
  );
}
