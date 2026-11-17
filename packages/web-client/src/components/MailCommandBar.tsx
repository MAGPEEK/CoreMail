/**
 * Mail command bar above the message list and the reading pane. Acts on the
 * checked messages (multi-select), else on the open one. Delete / archive / move /
 * junk / flag / read / undo run through the same handlers as the keyboard shortcuts
 * (MessageList + layout register them), so undo toasts, "open the next mail" and the
 * read-only checks behave identically for mouse and keyboard.
 * Enablement and labels: lib/mailCommands.ts; texts: i18n (useT).
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  SquarePen, Mail, Trash2, Archive, FolderInput, AlertOctagon, ShieldOff, Flag, FlagOff,
  MailOpen, Tag, Pin, Undo2, PanelsTopLeft, Check, X,
} from 'lucide-react';
import { api } from '../api/client.js';
import type { Category, Folder } from '../api/types.js';
import { useUiStore, useUiPrefs, type Density, type ReadingPane } from '../store/ui.js';
import { useActiveMailbox } from '../hooks/useActiveMailbox.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useTargetMessages } from '../hooks/useTargetMessages.js';
import { dispatchShortcut, useAriaKeys } from '../hooks/useShortcuts.js';
import { toastError } from '../lib/errors.js';
import { OWN_MAILBOX } from '../lib/mailboxContext.js';
import {
  categoryCoverage, commandTargets, mailCommandStates, nextCategoryIds, readToggle, summarizeSelection,
  type CommandState, type MailCommandId,
} from '../lib/mailCommands.js';
import type { ShortcutAction } from '../lib/shortcuts.js';
import { CommandBar, type CommandGroup, type CommandItem } from './CommandBar.js';
import type { ContextMenuItem } from './ContextMenu.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

const READING_PANE: { value: ReadingPane; labelKey: TranslationKey }[] = [
  { value: 'right', labelKey: 'mail_view_pane_right' },
  { value: 'bottom', labelKey: 'mail_view_pane_bottom' },
  { value: 'off', labelKey: 'mail_view_pane_off' },
];
const DENSITY: { value: Density; labelKey: TranslationKey }[] = [
  { value: 'compact', labelKey: 'mail_view_density_compact' },
  { value: 'normal', labelKey: 'mail_view_density_normal' },
  { value: 'comfortable', labelKey: 'mail_view_density_comfortable' },
];

const checkIcon = (on: boolean) => (on ? <Check size={14} /> : undefined);

/** Selected-messages counter + "clear selection" (outside the toolbar's roving focus). */
function SelectionInfo({ count, onClear }: { count: number; onClear: () => void }) {
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

export function MailCommandBar() {
  const t = useT();
  const navigate = useNavigate();
  const { selectedIds, selectedMessageId, selectedFolderId, clearSelection, setSelectedMessage, openCompose } = useUiStore();
  const { readingPane, setReadingPane, density, setDensity, groupByConversation, setGroupByConversation } = useUiPrefs();
  const mailbox = useActiveMailbox();
  const { setState, invalidate } = useMailActions();
  const ariaKeys = useAriaKeys();

  const targets = commandTargets(selectedIds, selectedMessageId);
  const known = useTargetMessages(targets);

  const { data: folders = [] } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });
  // Categories are personal — own mailbox only
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
    enabled: !mailbox.foreign,
  });

  const isJunkFolder = folders.find((f) => f.id === selectedFolderId)?.name === 'Junk';
  const selection = summarizeSelection(targets.length, known);
  const states = mailCommandStates({ selection, readOnly: mailbox.readOnly, foreign: mailbox.foreign, isJunkFolder }, t);

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

  const newMenu = (): ContextMenuItem[] => [
    { label: t('mail_cmd_new_mail'), icon: <Mail size={14} />, onClick: () => openCompose() },
    ...(mailbox.foreign
      ? [{ label: t('mail_cmd_new_mail_own'), icon: <Mail size={14} />, onClick: () => openCompose({ mailbox: OWN_MAILBOX }) }]
      : []),
  ];

  /** Common fields of a command from its state. */
  const cmd = (id: MailCommandId, icon: React.ReactNode, extra: Partial<CommandItem> = {}): CommandItem => {
    const s: CommandState = states[id];
    return { id, label: s.label, tooltip: s.tooltip, icon, ...(s.enabled ? {} : { disabled: true }), ...extra };
  };
  const viaShortcut = (action: ShortcutAction) => ({
    onClick: () => { dispatchShortcut(action); },
    keyshortcuts: ariaKeys(action),
  });

  const groups: CommandGroup[] = [
    { id: 'new', title: t('mail_group_new'), items: [
      cmd('new', <SquarePen size={16} />, {
        tone: 'primary', placement: 'pinned', keyshortcuts: ariaKeys('compose.new'),
        onClick: () => openCompose(), menu: newMenu,
      }),
    ] },
    { id: 'organize', title: t('mail_group_organize'), items: [
      cmd('delete', <Trash2 size={16} />, viaShortcut('mail.delete')),
      cmd('archive', <Archive size={16} />, viaShortcut('mail.archive')),
      cmd('move', <FolderInput size={16} />, viaShortcut('mail.move')),
      isJunkFolder
        ? cmd('junk', <ShieldOff size={16} />, { onClick: () => { void setState('notSpam', targets).then(leaveTargets); } })
        : cmd('junk', <AlertOctagon size={16} />, viaShortcut('mail.spam')),
    ] },
    { id: 'mark', title: t('mail_group_mark'), items: [
      cmd('flag', selection.allFlagged ? <FlagOff size={16} /> : <Flag size={16} />, viaShortcut('mail.flag')),
      readToggle(selection) === 'read'
        ? cmd('read', <MailOpen size={16} />, viaShortcut('mail.markRead'))
        : cmd('read', <Mail size={16} />, viaShortcut('mail.markUnread')),
      cmd('categorize', <Tag size={16} />, { menu: categoryMenu }),
      cmd('pin', <Pin size={16} />, { onClick: () => { void setState(selection.allPinned ? 'unpin' : 'pin', targets); } }),
    ] },
    { id: 'history', title: t('mail_cmd_undo'), items: [
      cmd('undo', <Undo2 size={16} />, viaShortcut('undo')),
    ] },
    { id: 'view', title: t('mail_cmd_view'), items: [
      cmd('view', <PanelsTopLeft size={16} />, { menu: viewMenu }),
    ] },
  ];

  return (
    <CommandBar
      label={t('mail_commands_label')}
      groups={groups}
      className="flex-1"
      end={selectedIds.size > 0 ? <SelectionInfo count={selectedIds.size} onClear={clearSelection} /> : null}
    />
  );
}
