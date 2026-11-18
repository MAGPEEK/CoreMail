/**
 * 9.4: command row at the top of the compose area — Senden, Anhängen (file /
 * picture), Verwerfen and "…" (Entwurf speichern, Absender anzeigen, Namen
 * prüfen, Wichtigkeit ›, Zu Nur-Text / HTML wechseln, Nachrichtenoptionen …,
 * Auf Barrierefreiheitsprobleme prüfen, In neuem Fenster öffnen); right:
 * "In neuem Fenster öffnen" and ✕ Schließen. Shared command bar: one tab stop,
 * ←/→, overflow menu. The "…" entries are shared with the action bar at the
 * bottom (moreCommands).
 */
import {
  Accessibility, Flag, Image as ImageIcon, Paperclip, Save, Send, Settings2, SquareArrowOutUpRight, Trash2, Type, UserCheck,
  UserRound, X,
} from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { IMPORTANCE_LEVELS, type Importance } from '../../lib/importance.js';
import { formatSwitchLabel, moreMenuCommands, type MoreMenuId } from '../../lib/composeToolbar.js';
import type { NamedSignature } from '../../lib/signaturePick.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

export interface ComposeCommandState {
  canSend: boolean;
  /** Why sending is not possible (tooltip / description). */
  sendBlockedReason: string | undefined;
  plainText: boolean;
  importance: Importance;
  signatures: NamedSignature[];
  /** The Von row is shown, and whether a choice of senders forces it. */
  fromShown: boolean;
  fromAutomatic: boolean;
  /** "Namen prüfen" is running. */
  checkingNames: boolean;
  emojiOpen: boolean;
  /** The draft is in its own window (no "In neuem Fenster öffnen"). */
  inWindow: boolean;
}

export interface ComposeCommandActions {
  send: () => void;
  openSchedule: (anchor: HTMLElement) => void;
  discard: () => void;
  attachFile: () => void;
  insertImage: () => void;
  openEmoji: (anchor: HTMLElement) => void;
  pickSignature: (id: string) => void;
  /** Texts of "Datum/Uhrzeit" for now, and inserting one. */
  dateTimes: () => string[];
  insertText: (text: string) => void;
  saveDraft: () => void;
  toggleFrom: () => void;
  checkNames: () => void;
  setImportance: (level: Importance) => void;
  togglePlain: () => void;
  openOptions: () => void;
  checkAccessibility: () => void;
  popOut: () => void;
  close: () => void;
}

type T = (key: TranslationKey) => string;

/** The "…" entries (top row overflow, and the chevron of the action bar). */
export function moreCommands(state: ComposeCommandState, actions: ComposeCommandActions, t: T): CommandItem[] {
  const all: Record<MoreMenuId, CommandItem> = {
    save: { id: 'save', label: t('compose_save_draft'), icon: <Save size={15} />, onClick: actions.saveDraft },
    showFrom: {
      id: 'show-from', label: t('compose_show_from'), icon: <UserRound size={15} />, pressed: state.fromShown,
      onClick: actions.toggleFrom,
      ...(state.fromAutomatic ? { disabled: true, tooltip: t('compose_show_from_auto') } : {}),
    },
    checkNames: {
      id: 'check-names', label: t('compose_check_names'), icon: <UserCheck size={15} />, onClick: actions.checkNames,
      ...(state.checkingNames ? { disabled: true } : {}),
    },
    importance: {
      id: 'importance', label: t('compose_importance'), icon: <Flag size={15} />,
      menu: () => IMPORTANCE_LEVELS.map((level): ContextMenuItem => ({
        label: t(`compose_importance_${level}` as TranslationKey), checked: state.importance === level, onClick: () => actions.setImportance(level),
      })),
    },
    format: { id: 'format', label: t(formatSwitchLabel(state.plainText)), icon: <Type size={15} />, onClick: actions.togglePlain },
    options: { id: 'options', label: t('compose_options'), icon: <Settings2 size={15} />, onClick: actions.openOptions },
    a11y: { id: 'a11y', label: t('compose_a11y_check'), icon: <Accessibility size={15} />, onClick: actions.checkAccessibility },
    popout: { id: 'popout', label: t('compose_popout'), icon: <SquareArrowOutUpRight size={15} />, onClick: actions.popOut },
  };
  return moreMenuCommands(state.inWindow).map((id) => all[id]);
}

export function ComposeCommandRow({ state, actions }: { state: ComposeCommandState; actions: ComposeCommandActions }) {
  const t = useT();
  const groups: CommandGroup[] = [
    { id: 'send', items: [{
      id: 'send', label: t('compose_send'), icon: <Send size={15} />, tone: 'primary', placement: 'pinned',
      tooltip: state.sendBlockedReason ?? t('compose_send_tip'), keyshortcuts: 'Control+Enter Meta+Enter',
      ...(state.canSend ? {} : { disabled: true }),
      onClick: actions.send,
    }] },
    { id: 'edit', items: [
      {
        id: 'attach', label: t('compose_attach'), icon: <Paperclip size={15} />, onClick: actions.attachFile,
        menu: () => [
          { label: t('compose_attach_file'), icon: <Paperclip size={14} />, onClick: actions.attachFile },
          ...(state.plainText ? [] : [{ label: t('compose_insert_image'), icon: <ImageIcon size={14} />, onClick: actions.insertImage }]),
        ],
      },
      { id: 'discard', label: t('draft_discard'), icon: <Trash2 size={15} />, onClick: actions.discard },
    ] },
    { id: 'more', items: moreCommands(state, actions, t).map((item) => ({ ...item, placement: 'overflow' as const })) },
  ];
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-line bg-surface shrink-0">
      <CommandBar
        label={t('compose_commands_label')}
        groups={groups}
        className="flex-1"
        end={(
          <div className="flex items-center shrink-0 ml-1">
            {!state.inWindow && (
              <button
                type="button"
                onClick={actions.popOut}
                aria-label={t('compose_popout')}
                title={t('compose_popout')}
                className="p-1.5 rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <SquareArrowOutUpRight size={16} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={actions.close}
              aria-label={t('compose_close')}
              title={t('compose_close_tip')}
              aria-keyshortcuts="Escape"
              className="p-1.5 rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      />
    </div>
  );
}
