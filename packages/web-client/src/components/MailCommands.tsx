/**
 * 10.7: the mail commands of the three-column layout (they replace the ribbon
 * and the narrow command bar):
 *  - `NewMailButton` — the "Neue E-Mail" split button at the top of the folder
 *    card (E-Mail, E-Mail aus Vorlage, Ereignis, aus eigenem Postfach);
 *  - `SelectionBar` — replaces the filter row of the list card while messages
 *    are checked: "N ausgewählt", Löschen (split: endgültig löschen),
 *    Archivieren, Verschieben, Junk / Kein Junk, Gelesen / Ungelesen, Markieren
 *    (split: Nachverfolgung), Kategorisieren, Anheften, Zurückstellen,
 *    Rückgängig, Auswahl aufheben (lib/mailCommands.ts SELECTION_BAR).
 * Delete / archive / move / junk / flag / read / undo run through the same
 * handlers as the keyboard shortcuts (MessageList registers them), so undo
 * toasts, "open the next mail" and the read-only checks behave identically for
 * mouse and keyboard. Enablement and labels: lib/mailCommands.ts; texts: i18n.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  SquarePen, Mail, Trash2, Archive, FolderInput, AlertOctagon, ShieldOff, Flag, FlagOff, Clock,
  MailOpen, Tag, Pin, Undo2, Check, X, CalendarPlus, FileText, Folder as FolderIcon, Ban,
} from 'lucide-react';
import { api } from '../api/client.js';
import type { Category, Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { useActiveMailbox } from '../hooks/useActiveMailbox.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { useTargetMessages } from '../hooks/useTargetMessages.js';
import { useFollowUp } from '../hooks/useFollowUp.js';
import { dispatchShortcut, useAriaKeys } from '../hooks/useShortcuts.js';
import { toastError } from '../lib/errors.js';
import { OWN_MAILBOX } from '../lib/mailboxContext.js';
import {
  SELECTION_BAR, categoryCoverage, commandTargets, extraMailStates, mailCommandStates, newMenuItems, nextCategoryIds, readToggle,
  summarizeSelection, type CommandState, type NewItemId, type SelectionBarId,
} from '../lib/mailCommands.js';
import type { ShortcutAction } from '../lib/shortcuts.js';
import { CommandBar, type CommandItem } from './CommandBar.js';
import type { ContextMenuItem } from './ContextMenu.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { NewEventDialog } from './NewEventDialog.js';
import { SplitButton } from './SplitButton.js';
import { useT } from '../i18n/useT.js';

// ── "Neue E-Mail" (folder card) ──────────────────────────────────────────────

export function NewMailButton({ onNewFromTemplate }: { onNewFromTemplate?: (() => void) | undefined }) {
  const t = useT();
  const openCompose = useUiStore((s) => s.openCompose);
  const mailbox = useActiveMailbox();
  const ariaKeys = useAriaKeys();
  const [eventOpen, setEventOpen] = useState(false);

  const items: Record<NewItemId, ContextMenuItem> = {
    mail: { label: t('mail_cmd_new_mail'), icon: <Mail size={14} />, onClick: () => openCompose() },
    template: { label: t('mail_cmd_new_template'), icon: <FileText size={14} />, onClick: () => onNewFromTemplate?.() },
    event: { label: t('mail_cmd_new_event'), icon: <CalendarPlus size={14} />, onClick: () => setEventOpen(true) },
    // a shared / delegated mailbox is shown: a mail from the own mailbox stays one click away
    ownMail: { label: t('mail_cmd_new_mail_own'), icon: <Mail size={14} />, onClick: () => openCompose({ mailbox: OWN_MAILBOX }) },
  };
  return (
    <>
      <SplitButton
        label={t('mail_cmd_new')}
        icon={<SquarePen size={16} />}
        tooltip={t('mail_cmd_new_tip')}
        keyshortcuts={ariaKeys('compose.new')}
        onClick={() => openCompose()}
        menu={() => newMenuItems(!!onNewFromTemplate, mailbox.foreign).map((id) => items[id])}
      />
      {eventOpen && <NewEventDialog onClose={() => setEventOpen(false)} />}
    </>
  );
}

// ── Selection bar (list card) ────────────────────────────────────────────────

const SNOOZE_PRESETS: { key: 'reader_snooze_1h' | 'reader_snooze_3h' | 'reader_snooze_tomorrow' | 'reader_snooze_monday'; at: () => Date }[] = [
  { key: 'reader_snooze_1h', at: () => { const d = new Date(); d.setHours(d.getHours() + 1); return d; } },
  { key: 'reader_snooze_3h', at: () => { const d = new Date(); d.setHours(d.getHours() + 3); return d; } },
  { key: 'reader_snooze_tomorrow', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; } },
  { key: 'reader_snooze_monday', at: () => { const d = new Date(); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); d.setHours(8, 0, 0, 0); return d; } },
];

/** Snooze choices (Zurückstellen); shared by the selection bar and the reading pane. */
export function snoozeMenu(t: (k: (typeof SNOOZE_PRESETS)[number]['key']) => string, snooze: (until: Date) => void): ContextMenuItem[] {
  return SNOOZE_PRESETS.map((p) => ({ label: t(p.key), onClick: () => snooze(p.at()) }));
}

/** Category choices for the targets (toggle for all) + "Kategorien verwalten". */
export function useCategoryMenu(known: readonly { id: string; categoryIds: readonly string[] }[], done: () => void): () => ContextMenuItem[] {
  const t = useT();
  const navigate = useNavigate();
  const mailbox = useActiveMailbox();
  // Categories are personal — own mailbox only; 9.4: the module can be switched off
  const categoriesOn = useWebmailFeatures().features.categories;
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
    enabled: !mailbox.foreign && categoriesOn,
  });
  const apply = (categoryId: string, removeFromAll: boolean) => {
    void Promise.all(known.map((m) => api.post(`/categories/messages/${m.id}`, {
      categoryIds: nextCategoryIds(m.categoryIds, categoryId, removeFromAll),
    }))).catch(toastError).finally(done);
  };
  return () => [
    ...categories.map((c): ContextMenuItem => {
      const all = categoryCoverage(known.map((m) => m.categoryIds), c.id) === 'all';
      return {
        label: c.name,
        icon: all
          ? <Check size={14} style={{ color: c.color }} />
          : <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: c.color }} />,
        ...(all ? { title: t('mail_cmd_category_assigned') } : {}),
        onClick: () => apply(c.id, all),
      };
    }),
    ...(categories.length ? [{ type: 'divider' as const }] : []),
    { label: t('mail_cmd_categories_manage'), icon: <Tag size={14} />, onClick: () => navigate('/settings#categories') },
  ];
}

/** Recent move targets + "Anderer Ordner …". */
export function useMoveMenu(moveTo: (folderId: string) => void, other: () => void): () => ContextMenuItem[] {
  const t = useT();
  const mailbox = useActiveMailbox();
  const { selectedFolderId, recentMoveTargets } = useUiStore();
  const { data: folders = [] } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });
  return () => {
    const recent = recentMoveTargets
      .map((id) => folders.find((f) => f.id === id))
      .filter((f): f is Folder => !!f && f.id !== selectedFolderId);
    return [
      ...(recent.length ? [{ label: t('mail_cmd_recent_folders'), disabled: true } as ContextMenuItem] : []),
      ...recent.map((f): ContextMenuItem => ({ label: f.displayName ?? f.name, icon: <FolderIcon size={14} />, onClick: () => moveTo(f.id) })),
      ...(recent.length ? [{ type: 'divider' as const }] : []),
      { label: t('mail_cmd_move_other'), icon: <FolderInput size={14} />, onClick: other },
    ];
  };
}

/** The selection bar: shown instead of the filter row while messages are checked. */
export function SelectionBar() {
  const t = useT();
  const { selectedIds, selectedMessageId, selectedFolderId, clearSelection, setSelectedMessage } = useUiStore();
  const mailbox = useActiveMailbox();
  const { setState, invalidate, runWithUndo, locateIds } = useMailActions();
  const ariaKeys = useAriaKeys();
  const categoriesOn = useWebmailFeatures().features.categories;

  const targets = commandTargets(selectedIds, selectedMessageId);
  const known = useTargetMessages(targets);
  const followUp = useFollowUp();
  const { data: folders = [] } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isJunkFolder = currentFolder?.name === 'Junk';
  const selection = summarizeSelection(targets.length, known);
  const ctx = { selection, readOnly: mailbox.readOnly, foreign: mailbox.foreign, isJunkFolder };
  const states = mailCommandStates(ctx, t);
  const extra = extraMailStates({
    ...ctx, hasFolder: !!currentFolder, folderUnread: currentFolder?.unreadCount ?? 0, hasOpenMessage: false,
  }, t);

  const leaveTargets = () => {
    if (selectedMessageId && targets.includes(selectedMessageId)) setSelectedMessage(null);
    clearSelection();
  };
  const viaShortcut = (action: ShortcutAction) => ({
    onClick: () => { dispatchShortcut(action); },
    keyshortcuts: ariaKeys(action),
  });
  const fromState = (id: string, s: CommandState, icon: ReactNode, more: Partial<CommandItem> = {}): CommandItem =>
    ({ id, label: s.label, tooltip: s.tooltip, icon, ...(s.enabled ? {} : { disabled: true }), ...more });

  const categoryMenu = useCategoryMenu(known, invalidate);
  const moveMenu = useMoveMenu(
    (folderId) => { void runWithUndo('move', locateIds(targets, selectedFolderId ?? ''), folderId).then((done) => { if (done) leaveTargets(); }); },
    () => { dispatchShortcut('mail.move'); },
  );
  const snooze = (until: Date) => {
    void Promise.all(targets.map((id) => api.post(`/mail/messages/${id}/snooze`, { until: until.toISOString() })))
      .then(() => { invalidate(); leaveTargets(); })
      .catch(toastError);
  };

  const items: Record<SelectionBarId, CommandItem | null> = {
    delete: fromState('delete', states.delete, <Trash2 size={16} />, {
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
    archive: fromState('archive', states.archive, <Archive size={16} />, viaShortcut('mail.archive')),
    move: fromState('move', states.move, <FolderInput size={16} />, { label: t('mail_cmd_move_to'), menu: moveMenu, keyshortcuts: ariaKeys('mail.move') }),
    junk: isJunkFolder
      ? fromState('junk', states.junk, <ShieldOff size={16} />, { onClick: () => { void setState('notSpam', targets).then(leaveTargets); } })
      : fromState('junk', states.junk, <AlertOctagon size={16} />, viaShortcut('mail.spam')),
    read: readToggle(selection) === 'read'
      ? fromState('read', states.read, <MailOpen size={16} />, viaShortcut('mail.markRead'))
      : fromState('read', states.read, <Mail size={16} />, viaShortcut('mail.markUnread')),
    flag: fromState('flag', states.flag, selection.allFlagged ? <FlagOff size={16} /> : <Flag size={16} />, {
      ...viaShortcut('mail.flag'),
      // split button — click toggles, the menu sets due dates / reminder / complete (own mailbox)
      ...(!mailbox.foreign && known.length > 0 ? { menu: () => followUp.menu(known) } : {}),
    }),
    categorize: categoriesOn ? fromState('categorize', states.categorize, <Tag size={16} />, { menu: categoryMenu }) : null,
    pin: fromState('pin', states.pin, <Pin size={16} />, { onClick: () => { void setState(selection.allPinned ? 'unpin' : 'pin', targets); } }),
    snooze: fromState('snooze', states.snooze, <Clock size={16} />, { menu: () => snoozeMenu(t, snooze) }),
    undo: fromState('undo', states.undo, <Undo2 size={16} />, viaShortcut('undo')),
  };

  return (
    <div className="flex items-center gap-1 min-w-0 flex-1">
      <span role="status" className="text-xs font-semibold text-accent-fg whitespace-nowrap pl-1 pr-1">
        <AnimatedCounter value={selectedIds.size} /> {t('mail_selected')}
      </span>
      <CommandBar
        label={t('list_selection_label')}
        groups={[{ id: 'selection', items: SELECTION_BAR.map((id) => items[id]).filter((i): i is CommandItem => !!i).map((i) => ({ ...i, iconOnly: true })) }]}
        dividers={false}
        className="flex-1"
        end={(
          <button
            type="button"
            onClick={clearSelection}
            aria-label={t('mail_clear_selection')}
            title={t('mail_clear_selection')}
            className="p-1.5 rounded text-fg-subtle hover:bg-surface-2 hover:text-fg transition-colors shrink-0"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      />
      {followUp.dialog}
    </div>
  );
}
