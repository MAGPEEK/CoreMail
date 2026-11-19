/**
 * Header row of the compose card: left the split button "Senden" (the only
 * accent-filled control; its chevron / Alt+↓ opens Senden, Später senden,
 * Wichtigkeit, Nachrichtenoptionen) and quiet icon buttons (Anhängen, Bild,
 * Signatur, "Aa" for the formatting bar) and the "…" menu with everything else
 * (lib/composeToolbar.ts: headerCommands, SEND_MENU, moreMenuCommands); right
 * the draft status (aria-live), "In neuem Fenster öffnen" (inline only),
 * "Verwerfen" and the quiet ✕ "Schließen" (the draft is kept). Shared command bar: one tab stop, ←/→, overflow menu.
 */
import {
  Accessibility, ALargeSmall, CalendarClock, CalendarDays, Flag, Image as ImageIcon, Loader2, Paperclip, PenLine, Save, Send, Settings2,
  Smile, SquareArrowOutUpRight, Trash2, Type, UserCheck, UserRound, X,
} from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { IMPORTANCE_LEVELS, type Importance } from '../../lib/importance.js';
import {
  SEND_MENU, formatBarToggleLabel, formatSwitchLabel, headerCommands, moreMenuCommands, statusLayoutClass, type HeaderId, type MoreMenuId, type SendMenuId,
} from '../../lib/composeToolbar.js';
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
  /** The formatting bar at the bottom of the card is shown. */
  formatBarShown: boolean;
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
  toggleFormatBar: () => void;
  openOptions: () => void;
  checkAccessibility: () => void;
  popOut: () => void;
  close: () => void;
}

/** The draft status line: text, failed (danger colour), busy (spinner). */
export interface ComposeStatusLine { text: string; failed: boolean; busy: boolean }

type T = (key: TranslationKey) => string;

/** Entries of the "…" menu. */
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
    datetime: {
      id: 'datetime', label: t('compose_datetime'), icon: <CalendarDays size={15} />,
      menu: () => actions.dateTimes().map((text): ContextMenuItem => ({ label: text, onClick: () => actions.insertText(text) })),
    },
    format: { id: 'format', label: t(formatSwitchLabel(state.plainText)), icon: <Type size={15} />, onClick: actions.togglePlain },
    formatBar: {
      id: 'format-bar', label: t(formatBarToggleLabel(state.formatBarShown)), icon: <ALargeSmall size={15} />, onClick: actions.toggleFormatBar,
    },
    a11y: { id: 'a11y', label: t('compose_a11y_check'), icon: <Accessibility size={15} />, onClick: actions.checkAccessibility },
    emoji: { id: 'emoji', label: t('compose_emoji_title'), icon: <Smile size={15} />, onClick: actions.openEmoji, dialogOpen: state.emojiOpen },
  };
  return moreMenuCommands(state.plainText).map((id) => all[id]);
}

/** Entries of the chevron of "Senden". */
function sendMenu(state: ComposeCommandState, actions: ComposeCommandActions, t: T): ContextMenuItem[] {
  const all: Record<SendMenuId, ContextMenuItem> = {
    send: { label: t('compose_send'), icon: <Send size={14} />, onClick: actions.send },
    schedule: {
      label: t('compose_schedule'), icon: <CalendarClock size={14} />,
      onClick: () => {
        // the menu gave focus back to its button before running this: anchor the popover there
        const anchor = document.activeElement;
        if (anchor instanceof HTMLElement) actions.openSchedule(anchor);
      },
    },
    importance: {
      label: t('compose_importance'), icon: <Flag size={14} />,
      children: IMPORTANCE_LEVELS.map((level): ContextMenuItem => ({
        label: t(`compose_importance_${level}` as TranslationKey), checked: state.importance === level, onClick: () => actions.setImportance(level),
      })),
    },
    options: { label: t('compose_options'), icon: <Settings2 size={14} />, onClick: actions.openOptions },
  };
  return SEND_MENU.flatMap((id): ContextMenuItem[] => [...(id === 'importance' ? [{ type: 'divider' as const }] : []), all[id]]);
}

/** Signature choices (named signatures, then "Keine Signatur"). */
function signatureMenu(signatures: NamedSignature[], pick: (id: string) => void, noneLabel: string): ContextMenuItem[] {
  return [
    ...signatures.map((s): ContextMenuItem => ({ label: s.name, icon: <PenLine size={14} />, onClick: () => pick(s.id) })),
    ...(signatures.length ? [{ type: 'divider' as const }] : []),
    { label: noneLabel, onClick: () => pick('') },
  ];
}

function headerItems(state: ComposeCommandState, actions: ComposeCommandActions, t: T): Record<HeaderId, CommandItem> {
  return {
    attach: { id: 'attach', label: t('compose_attach_file'), icon: <Paperclip size={16} />, iconOnly: true, onClick: actions.attachFile },
    inlineImage: { id: 'inline-image', label: t('compose_insert_image'), icon: <ImageIcon size={16} />, iconOnly: true, onClick: actions.insertImage },
    signature: {
      id: 'signature', label: t('compose_signature_insert'), icon: <PenLine size={16} />, iconOnly: true,
      menu: () => signatureMenu(state.signatures, actions.pickSignature, t('compose_no_signature')),
    },
    formatBar: {
      id: 'format-bar-toggle', label: t(formatBarToggleLabel(state.formatBarShown)), icon: <ALargeSmall size={16} />, iconOnly: true,
      pressed: state.formatBarShown, onClick: actions.toggleFormatBar,
    },
  };
}

const QUIET_ICON = 'p-0 inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-md text-fg-muted';

function StatusText({ status, inWindow }: { status: ComposeStatusLine; inWindow: boolean }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-xs min-w-0 truncate flex items-center gap-1.5 ${statusLayoutClass(inWindow, status.failed)} ${status.failed ? 'text-danger-fg' : 'text-fg-muted'}`}
    >
      {status.busy && <Loader2 size={12} className="animate-spin shrink-0" aria-hidden="true" />}
      <span className="truncate">{status.text}</span>
    </p>
  );
}

export function ComposeCommandRow({ state, actions, status }: { state: ComposeCommandState; actions: ComposeCommandActions; status: ComposeStatusLine }) {
  const t = useT();
  const header = headerItems(state, actions, t);
  const groups: CommandGroup[] = [
    { id: 'send', items: [{
      id: 'send', label: t('compose_send'), icon: <Send size={15} />, tone: 'primary', placement: 'pinned',
      tooltip: state.sendBlockedReason ?? t('compose_send_tip'), keyshortcuts: 'Control+Enter Meta+Enter Alt+ArrowDown',
      ...(state.canSend ? {} : { disabled: true }),
      onClick: actions.send,
      menu: () => sendMenu(state, actions, t),
    }] },
    { id: 'edit', items: headerCommands(state.plainText, state.signatures.length > 0).map((id) => header[id]) },
    { id: 'more', items: moreCommands(state, actions, t).map((item) => ({ ...item, placement: 'overflow' as const })) },
  ];
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-surface shrink-0">
      <CommandBar label={t('compose_commands_label')} groups={groups} dividers={false} className="flex-1" />
      <div className="flex items-center gap-1 min-w-0 shrink">
        <StatusText status={status} inWindow={state.inWindow} />
        {!state.inWindow && (
          <button type="button" onClick={actions.popOut} aria-label={t('compose_popout')} title={t('compose_popout')} className={`${QUIET_ICON} hover:bg-surface-2 hover:text-fg`}>
            <SquareArrowOutUpRight size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={actions.discard}
          aria-label={t('draft_discard')}
          title={t('draft_discard')}
          className={`${QUIET_ICON} hover:bg-danger-bg hover:text-danger-fg`}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={actions.close}
          aria-label={t('compose_close')}
          title={t('compose_close_icon_tip')}
          className={`${QUIET_ICON} hover:bg-surface-2 hover:text-fg`}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
