/**
 * 9.4: action bar at the bottom of the compose area — Senden (split: Senden /
 * Senden planen …), Verwerfen, Anhang, Inline-Bild, Emoji, Signatur einfügen
 * and a chevron with Datum/Uhrzeit and the "…" entries of the command row
 * (lib/composeToolbar.ts actionBarCommands). Shared command bar: one tab stop,
 * ←/→, overflow menu.
 */
import { CalendarClock, CalendarDays, ChevronUp, Image as ImageIcon, Paperclip, PenLine, Send, Smile, Trash2 } from 'lucide-react';
import { CommandBar, commandMenuItem, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { moreCommands, type ComposeCommandActions, type ComposeCommandState } from './ComposeCommandRow.js';
import { actionBarCommands, type ActionBarId } from '../../lib/composeToolbar.js';
import type { NamedSignature } from '../../lib/signaturePick.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

type T = (key: TranslationKey) => string;

/** Signature choices (named signatures, then "Keine Signatur"). */
function signatureMenu(signatures: NamedSignature[], pick: (id: string) => void, noneLabel: string): ContextMenuItem[] {
  return [
    ...signatures.map((s): ContextMenuItem => ({ label: s.name, icon: <PenLine size={14} />, onClick: () => pick(s.id) })),
    ...(signatures.length ? [{ type: 'divider' as const }] : []),
    { label: noneLabel, onClick: () => pick('') },
  ];
}

function moreMenu(state: ComposeCommandState, actions: ComposeCommandActions, t: T, anchor: () => HTMLElement): ContextMenuItem[] {
  return [
    {
      label: t('compose_datetime'), icon: <CalendarDays size={14} />,
      children: actions.dateTimes().map((text) => ({ label: text, onClick: () => actions.insertText(text) })),
    },
    { type: 'divider' },
    ...moreCommands(state, actions, t).map((item) => commandMenuItem(item, anchor)),
  ];
}

function items(state: ComposeCommandState, actions: ComposeCommandActions, t: T): Record<ActionBarId, CommandItem> {
  return {
    send: {
      id: 'send', label: t('compose_send'), icon: <Send size={15} />, tone: 'primary', placement: 'pinned',
      tooltip: state.sendBlockedReason ?? t('compose_send_tip'), keyshortcuts: 'Control+Enter Meta+Enter',
      ...(state.canSend ? {} : { disabled: true }),
      onClick: actions.send,
      menu: () => [
        { label: t('compose_send'), icon: <Send size={14} />, onClick: actions.send },
        { label: t('compose_schedule'), icon: <CalendarClock size={14} />, onClick: () => {
          // the menu gave focus back to its button before running this: anchor the popover there
          const anchor = document.activeElement;
          if (anchor instanceof HTMLElement) actions.openSchedule(anchor);
        } },
      ],
    },
    discard: { id: 'discard', label: t('draft_discard'), icon: <Trash2 size={15} />, iconOnly: true, onClick: actions.discard },
    attach: { id: 'attach', label: t('compose_attach_file'), icon: <Paperclip size={15} />, iconOnly: true, onClick: actions.attachFile },
    inlineImage: { id: 'inline-image', label: t('compose_insert_image'), icon: <ImageIcon size={15} />, iconOnly: true, onClick: actions.insertImage },
    emoji: {
      id: 'emoji', label: t('compose_emoji_title'), icon: <Smile size={15} />, iconOnly: true, onClick: actions.openEmoji, dialogOpen: state.emojiOpen,
    },
    signature: {
      id: 'signature', label: t('compose_signature_insert'), icon: <PenLine size={15} />, iconOnly: true,
      menu: () => signatureMenu(state.signatures, actions.pickSignature, t('compose_no_signature')),
    },
    more: {
      id: 'more-actions', label: t('compose_more_actions'), icon: <ChevronUp size={15} />, iconOnly: true, placement: 'pinned',
      // the anchor of a dialog opened from this menu: its button (focus returns there)
      menu: () => moreMenu(state, actions, t, () => document.activeElement as HTMLElement),
    },
  };
}

export function ComposeActionBar({ state, actions }: { state: ComposeCommandState; actions: ComposeCommandActions }) {
  const t = useT();
  const all = items(state, actions, t);
  return (
    <div className="shrink-0 px-2 py-1.5 border-t border-line bg-surface">
      <CommandBar
        label={t('compose_actions_label')}
        groups={[{ id: 'actions', items: actionBarCommands(state.plainText, state.signatures.length > 0).map((id) => all[id]) }]}
      />
    </div>
  );
}
