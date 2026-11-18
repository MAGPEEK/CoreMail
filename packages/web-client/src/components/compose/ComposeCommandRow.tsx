/**
 * Command row of the compose area: Senden (split: Senden / Senden planen …),
 * Verwerfen, Anhängen (file / picture) and "…" (signature, read receipt,
 * plain text, save, own window); ✕ Schließen at the end. Shared command bar:
 * one tab stop, ←/→, overflow menu.
 */
import {
  CalendarClock, Flag, Image as ImageIcon, MailCheck, PackageCheck, Paperclip, PenLine, Save, Send, SquareArrowOutUpRight, Trash2, Type, X,
} from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import type { NamedSignature } from '../../lib/signaturePick.js';
import { IMPORTANCE_LEVELS, type Importance } from '../../lib/importance.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

export interface ComposeCommandState {
  canSend: boolean;
  /** Why sending is not possible (tooltip / description). */
  sendBlockedReason: string | undefined;
  plainText: boolean;
  receiptVisible: boolean;
  requestReceipt: boolean;
  /** 9.4: delivery receipt (success DSN) asked for. */
  deliveryReceipt: boolean;
  importance: Importance;
  signatures: NamedSignature[];
  /** The draft is in its own window (no "In neuem Fenster öffnen"). */
  inWindow: boolean;
}

export interface ComposeCommandActions {
  send: () => void;
  openSchedule: (anchor: HTMLElement) => void;
  discard: () => void;
  attachFile: () => void;
  insertImage: () => void;
  pickSignature: (id: string) => void;
  toggleReceipt: () => void;
  toggleDeliveryReceipt: () => void;
  setImportance: (level: Importance) => void;
  togglePlain: () => void;
  saveDraft: () => void;
  popOut: () => void;
  close: () => void;
}

/** Signature choices (named signatures, then "Keine Signatur"); shared with the ribbon. */
export function signatureMenu(signatures: NamedSignature[], pick: (id: string) => void, noneLabel: string): ContextMenuItem[] {
  return [
    ...signatures.map((s): ContextMenuItem => ({ label: s.name, icon: <PenLine size={14} />, onClick: () => pick(s.id) })),
    ...(signatures.length ? [{ type: 'divider' as const }] : []),
    { label: noneLabel, onClick: () => pick('') },
  ];
}

export function ComposeCommandRow({ state, actions }: { state: ComposeCommandState; actions: ComposeCommandActions }) {
  const t = useT();
  const blocked = !state.canSend;
  const sendItem: CommandItem = {
    id: 'send', label: t('compose_send'), icon: <Send size={15} />, tone: 'primary', placement: 'pinned',
    tooltip: state.sendBlockedReason ?? t('compose_send_tip'), keyshortcuts: 'Control+Enter Meta+Enter',
    ...(blocked ? { disabled: true } : {}),
    onClick: actions.send,
    menu: () => [
      { label: t('compose_send'), icon: <Send size={14} />, onClick: actions.send },
      { label: t('compose_schedule'), icon: <CalendarClock size={14} />, onClick: () => {
        // the menu gave focus back to its button before running this: anchor the popover there
        const anchor = document.activeElement;
        if (anchor instanceof HTMLElement) actions.openSchedule(anchor);
      } },
    ],
  };
  const more: CommandItem[] = [
    ...(state.signatures.length ? [{
      id: 'signature', label: t('compose_signature'), icon: <PenLine size={15} />, placement: 'overflow' as const,
      menu: () => signatureMenu(state.signatures, actions.pickSignature, t('compose_no_signature')),
    }] : []),
    ...(state.receiptVisible ? [{
      id: 'receipt', label: t('compose_receipt'), icon: <MailCheck size={15} />, placement: 'overflow' as const,
      pressed: state.requestReceipt, onClick: actions.toggleReceipt,
    }] : []),
    {
      id: 'delivery-receipt', label: t('compose_delivery_receipt'), icon: <PackageCheck size={15} />, placement: 'overflow',
      pressed: state.deliveryReceipt, onClick: actions.toggleDeliveryReceipt,
    },
    {
      id: 'importance', label: t('compose_importance'), icon: <Flag size={15} />, placement: 'overflow',
      menu: () => IMPORTANCE_LEVELS.map((level): ContextMenuItem => ({
        label: t(`compose_importance_${level}` as TranslationKey), checked: state.importance === level, onClick: () => actions.setImportance(level),
      })),
    },
    { id: 'plain', label: t('compose_plain'), icon: <Type size={15} />, placement: 'overflow', pressed: state.plainText, onClick: actions.togglePlain },
    { id: 'save', label: t('compose_save_draft'), icon: <Save size={15} />, placement: 'overflow', onClick: actions.saveDraft },
    ...(state.inWindow ? [] : [{
      id: 'popout', label: t('compose_popout'), icon: <SquareArrowOutUpRight size={15} />, placement: 'overflow' as const, onClick: actions.popOut,
    }]),
  ];
  const groups: CommandGroup[] = [
    { id: 'send', items: [sendItem] },
    { id: 'edit', items: [
      { id: 'discard', label: t('draft_discard'), icon: <Trash2 size={15} />, onClick: actions.discard },
      {
        id: 'attach', label: t('compose_attach'), icon: <Paperclip size={15} />, onClick: actions.attachFile,
        menu: () => [
          { label: t('compose_attach_file'), icon: <Paperclip size={14} />, onClick: actions.attachFile },
          ...(state.plainText ? [] : [{ label: t('compose_insert_image'), icon: <ImageIcon size={14} />, onClick: actions.insertImage }]),
        ],
      },
    ] },
    { id: 'more', items: more },
  ];
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-line bg-surface shrink-0">
      <CommandBar
        label={t('compose_commands_label')}
        groups={groups}
        className="flex-1"
        end={(
          <button
            type="button"
            onClick={actions.close}
            aria-label={t('compose_close')}
            title={t('compose_close_tip')}
            aria-keyshortcuts="Escape"
            className="ml-1 p-1.5 rounded text-fg-muted hover:bg-surface-2 hover:text-fg shrink-0"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
}
