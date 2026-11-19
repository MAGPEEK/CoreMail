/**
 * 10.1: the ribbon's contextual tabs while a draft is shown in the reading pane —
 * Nachricht | Einfügen | Text formatieren | Optionen. Every command is one the
 * compose card already has (its header row, "…" menu, Senden menu, formatting
 * bar and flyout) and runs the same action: the commands come from those
 * definitions (ComposeCommandRow headerItems / moreCommands / sendMenu,
 * ComposeFormatBar formatBarCommands / formatFlyoutCommands) through the
 * published compose API (store/composeRibbon.ts). Nothing is shown that the
 * draft cannot do (plain text: no pictures, no formatting).
 */

import { CalendarClock, FilePlus2, FileText, Flag, Mail, MailCheck, Paperclip, Save, Settings2 } from 'lucide-react';
import type { CommandGroup, CommandItem } from '../CommandBar.js';

import type { ContextMenuItem } from '../ContextMenu.js';
import { headerItems, moreCommands } from './ComposeCommandRow.js';
import { formatBarCommands, formatFlyoutCommands } from './ComposeFormatBar.js';
import { IMPORTANCE_LEVELS } from '../../lib/importance.js';
import type { RibbonTabId } from '../../lib/ribbon.js';
import type { ComposeRibbonApi } from '../../store/composeRibbon.js';
import type { TranslationKey } from '../../i18n/translations.js';

type T = (key: TranslationKey) => string;

const compact = (items: (CommandItem | undefined | null | false)[]): CommandItem[] => items.filter((i): i is CommandItem => !!i);
const group = (id: string, title: string, items: (CommandItem | undefined | null | false)[]): CommandGroup[] => {
  const list = compact(items);
  return list.length ? [{ id, title, items: list }] : [];
};

/** Command groups of one contextual tab. */
export function composeRibbonGroups(tab: RibbonTabId, api: ComposeRibbonApi, t: T): CommandGroup[] {
  const { state, actions, editor } = api;
  const plain = state.plainText;
  const header = headerItems(state, actions, t);
  const more = Object.fromEntries(moreCommands(state, actions, t).map((c) => [c.id, c])) as Record<string, CommandItem>;
  const formatProps = {
    editor, defaultSize: api.defaultSize, emojiOpen: state.emojiOpen,
    actions: { openLink: actions.openLink, insertImage: actions.insertImage, openEmoji: actions.openEmoji },
  };
  const bar = plain ? null : formatBarCommands(formatProps, t);
  const fly = plain ? {} : formatFlyoutCommands(formatProps, t);

  const attach: CommandItem = { ...header.attach, id: 'attach', iconOnly: false, icon: <Paperclip size={16} /> };
  const image = !plain && { ...header.inlineImage, iconOnly: false };
  const signature = state.signatures.length > 0 && { ...header.signature, iconOnly: false };
  const link = bar && { ...bar.link, iconOnly: false };
  const emoji = bar ? { ...bar.emoji, iconOnly: false } : { ...more['emoji']!, iconOnly: false };
  const schedule: CommandItem = {
    id: 'schedule', label: t('compose_schedule'), icon: <CalendarClock size={16} />,
    ...(state.canSend ? {} : { disabled: true, tooltip: state.sendBlockedReason }),
    onClick: (anchor) => actions.openSchedule(anchor),
  };
  const save: CommandItem = { ...more['save']!, icon: <Save size={16} /> };
  // mail templates: the same "…" menu commands of the card (the card hides that menu while the ribbon shows)
  const insertTemplate: CommandItem = { ...more['insert-template']!, icon: <FileText size={16} /> };
  const saveTemplate: CommandItem = { ...more['save-template']!, icon: <FilePlus2 size={16} /> };
  const unIcon = (c: CommandItem | false | null | undefined) => c && ({ ...c, iconOnly: false });

  switch (tab) {
    case 'message':
      return [
        ...group('undo', t('ribbon_compose_group_undo'), [fly.undo, fly.redo]),
        ...group('font', t('ribbon_compose_group_font'), [fly.font, fly.size, unIcon(bar?.bold), unIcon(bar?.italic), unIcon(bar?.underline), fly.strike]),
        ...group('insert', t('ribbon_compose_group_insert'), [attach, link, signature, image, emoji]),
        ...group('send', t('ribbon_compose_group_send'), [schedule, save, saveTemplate]),
      ];
    case 'insert':
      return [
        ...group('insert', t('ribbon_compose_group_insert'), [
          { ...attach, label: t('compose_insert_file') }, image, link, emoji, signature, insertTemplate,
        ]),
        ...group('objects', t('ribbon_compose_group_paragraph'), [fly.rule, fly.table, more['datetime'] && { ...more['datetime'] }]),
      ];
    case 'format':
      return [
        ...group('font', t('ribbon_compose_group_font'), [fly.font, fly.size, unIcon(bar?.grow), unIcon(bar?.shrink)]),
        ...group('text', t('ribbon_compose_group_text'), [
          unIcon(bar?.bold), unIcon(bar?.italic), unIcon(bar?.underline), fly.strike, unIcon(bar?.highlight), unIcon(bar?.color),
          fly.superscript, fly.subscript, fly.code,
        ]),
        ...group('paragraph', t('ribbon_compose_group_paragraph'), [
          unIcon(bar?.bullets), unIcon(bar?.numbering), fly.outdent, fly.indent, fly.align, fly.direction, fly.quote, fly.style,
        ]),
        ...group('format', t('ribbon_compose_group_format'), [fly.clear, more['format'], more['format-bar']]),
      ];
    case 'options': {
      const importance: CommandItem = {
        id: 'importance', label: t('compose_importance'), icon: <Flag size={16} />,
        menu: (): ContextMenuItem[] => IMPORTANCE_LEVELS.map((level) => ({
          label: t(`compose_importance_${level}` as TranslationKey), checked: state.importance === level, onClick: () => actions.setImportance(level),
        })),
      };
      const receipt = api.receiptVisible && {
        id: 'receipt', label: t('compose_receipt'), icon: <MailCheck size={16} />, pressed: api.requestReceipt, onClick: actions.toggleRequestReceipt,
      };
      return [
        ...group('tags', t('ribbon_compose_group_tags'), [
          importance, receipt,
          { id: 'options', label: t('compose_options'), icon: <Settings2 size={16} />, onClick: actions.openOptions },
        ]),
        ...group('from', t('ribbon_compose_group_send'), [more['show-from'] && { ...more['show-from'], icon: <Mail size={16} /> }]),
        ...group('check', t('ribbon_compose_group_check'), [more['check-names'], more['a11y']]),
        ...group('format', t('ribbon_compose_group_format'), [more['format']]),
      ];
    }
    default:
      return [];
  }
}

