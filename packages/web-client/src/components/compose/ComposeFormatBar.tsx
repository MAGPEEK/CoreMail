/**
 * Formatting toolbar at the bottom of the compose card (an inset rounded strip on
 * the subtle surface): Schrift größer / kleiner, Fett, Kursiv, Unterstrichen,
 * Hervorhebung, Schriftfarbe, Aufzählung, Nummerierung, Einzug, Link, Emoji and a chevron flyout with everything else
 * (lib/composeToolbar.ts formatFlyout). Shared command bar: one tab stop,
 * ←/→, overflow menu. Not shown in plain-text format.
 */
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  AArrowDown, AArrowUp, AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowLeftRight, Baseline, Bold, ChevronDown, Code,
  Heading, Highlighter, Image as ImageIcon, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, Minus,
  Redo2, RemoveFormatting, Strikethrough, Subscript, Superscript, Table as TableIcon, TextQuote, Type, Underline, Undo2,
  Unlink, ALargeSmall, Smile,
} from 'lucide-react';
import { CommandBar, commandFromMenuItem, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { TEXT_DIRECTION_TYPES } from '../editorExtensions.js';
import {
  HIGHLIGHT_COLORS, NEW_TABLE, PARAGRAPH_STYLES, TEXT_COLORS, type ContentColor, type ParagraphStyleId, type TableCommandId,
} from '../../lib/composeFormat.js';
import { COMPOSE_FONT_SIZES_PT, FONT_SCRIPTS, findFont, fontsOf, sizeLabel, sizeValue } from '../../lib/composeFonts.js';
import {
  ALIGNMENTS, FORMAT_BAR, TEXT_DIRECTIONS, formatFlyout, stepFontSize, tableCommandsFor,
  type Alignment, type FlyoutEntry, type FlyoutEntryId, type FlyoutState, type FormatBarId, type TextDirection,
} from '../../lib/composeToolbar.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

export interface FormatBarActions {
  openLink: () => void;
  insertImage: () => void;
  openEmoji: (anchor: HTMLElement) => void;
}

interface Props {
  editor: Editor | null;
  /** Size new text starts with (Settings → Verfassen), the base of Schrift größer / kleiner. */
  defaultSize: string;
  /** The emoji popover is open (aria-expanded of its button). */
  emojiOpen: boolean;
  actions: FormatBarActions;
}

type T = (key: TranslationKey) => string;

const ICON = 15;
const ALIGN_ICONS: Record<Alignment, ReactNode> = {
  left: <AlignLeft size={14} />, center: <AlignCenter size={14} />, right: <AlignRight size={14} />, justify: <AlignJustify size={14} />,
};

const swatch = (hex: string): ReactNode => (
  <span className="w-3.5 h-3.5 rounded-sm border border-line-strong" style={{ backgroundColor: hex }} />
);

function colorMenu(colors: readonly ContentColor[], current: string | undefined, prefix: 'compose_color_' | 'compose_hl_', t: T,
  pick: (hex: string | null) => void, noneLabel: string): ContextMenuItem[] {
  return [
    { label: noneLabel, checked: !current, onClick: () => pick(null) },
    { type: 'divider' },
    ...colors.map((c): ContextMenuItem => ({
      label: t(`${prefix}${c.id}` as TranslationKey), icon: swatch(c.hex), checked: current?.toLowerCase() === c.hex, onClick: () => pick(c.hex),
    })),
  ];
}

function activeStyle(e: Editor): ParagraphStyleId {
  for (const level of [1, 2, 3] as const) if (e.isActive('heading', { level })) return `h${level}`;
  return e.isActive('codeBlock') ? 'codeBlock' : 'paragraph';
}

function applyStyle(e: Editor, id: ParagraphStyleId): void {
  const chain = e.chain().focus();
  if (id === 'paragraph') chain.setParagraph().run();
  else if (id === 'codeBlock') chain.setCodeBlock().run();
  else chain.setHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
}

/** Runs a table command; true when the editor could (cursor in a table, or insert). */
function tableCommand(e: Editor, id: TableCommandId, dryRun: boolean): boolean {
  const chain = dryRun ? e.can().chain() : e.chain().focus();
  switch (id) {
    case 'insert': return chain.insertTable(NEW_TABLE).run();
    case 'rowBefore': return chain.addRowBefore().run();
    case 'rowAfter': return chain.addRowAfter().run();
    case 'colBefore': return chain.addColumnBefore().run();
    case 'colAfter': return chain.addColumnAfter().run();
    case 'deleteRow': return chain.deleteRow().run();
    case 'deleteCol': return chain.deleteColumn().run();
    case 'deleteTable': return chain.deleteTable().run();
  }
}

function setDirection(e: Editor, dir: TextDirection): void {
  let chain = e.chain().focus();
  for (const type of TEXT_DIRECTION_TYPES) chain = chain.updateAttributes(type, { dir: dir === 'rtl' ? 'rtl' : null });
  chain.run();
}

/** Editor state the flyout shows (toggles, submenus). */
function flyoutState(e: Editor | null): FlyoutState {
  const dirOf = (type: string) => e?.getAttributes(type)['dir'];
  return {
    inTable: !!e?.isActive('table'),
    inLink: !!e?.isActive('link'),
    align: ALIGNMENTS.find((a) => e?.isActive({ textAlign: a })) ?? 'left',
    direction: TEXT_DIRECTION_TYPES.some((type) => dirOf(type) === 'rtl') ? 'rtl' : 'ltr',
    superscript: !!e?.isActive('superscript'),
    subscript: !!e?.isActive('subscript'),
    strike: !!e?.isActive('strike'),
    quote: !!e?.isActive('blockquote'),
    code: !!e?.isActive('code'),
  };
}

function fontMenu(e: Editor, t: T): ContextMenuItem[] {
  const font = e.getAttributes('textStyle')['fontFamily'] as string | undefined;
  return [
    { label: t('compose_font_default'), checked: !findFont(font), onClick: () => { e.chain().focus().unsetFontFamily().run(); } },
    { type: 'divider' },
    ...FONT_SCRIPTS.map((script): ContextMenuItem => ({
      label: t(`compose_fonts_${script}` as TranslationKey),
      children: fontsOf(script).map((f) => ({
        label: f.label, labelStyle: { fontFamily: f.stack }, checked: findFont(font)?.label === f.label,
        onClick: () => { e.chain().focus().setFontFamily(f.stack).run(); },
      })),
    })),
  ];
}

function sizeMenu(e: Editor, t: T): ContextMenuItem[] {
  const size = e.getAttributes('textStyle')['fontSize'] as string | undefined;
  return [
    { label: t('compose_size_default'), checked: !size, onClick: () => { e.chain().focus().setMark('textStyle', { fontSize: null }).run(); } },
    ...COMPOSE_FONT_SIZES_PT.map(sizeValue).map((s): ContextMenuItem => ({
      label: sizeLabel(s), checked: size === s, onClick: () => { e.chain().focus().setMark('textStyle', { fontSize: s }).run(); },
    })),
  ];
}

/** One flyout entry as a menu entry. */
function flyoutItem(entry: FlyoutEntry, e: Editor, s: FlyoutState, t: T, p: Props): ContextMenuItem {
  const run = (fn: () => void): Pick<ContextMenuItem, 'onClick'> => ({ onClick: fn });
  const checked = entry.checked !== undefined ? { checked: entry.checked } : {};
  const defs: Record<FlyoutEntryId, ContextMenuItem> = {
    outdent: { label: t('compose_outdent'), icon: <IndentDecrease size={14} />, ...run(() => { e.chain().focus().liftListItem('listItem').run(); }) },
    indent: { label: t('compose_indent'), icon: <IndentIncrease size={14} />, ...run(() => { e.chain().focus().sinkListItem('listItem').run(); }) },
    align: {
      label: t('compose_align'), icon: ALIGN_ICONS[s.align],
      children: ALIGNMENTS.map((a) => ({
        label: t(`compose_align_${a}` as TranslationKey), icon: ALIGN_ICONS[a], checked: s.align === a,
        onClick: () => { e.chain().focus().setTextAlign(a).run(); },
      })),
    },
    direction: {
      label: t('compose_direction'), icon: <ArrowLeftRight size={14} />,
      children: TEXT_DIRECTIONS.map((d) => ({ label: t(`compose_dir_${d}` as TranslationKey), checked: s.direction === d, onClick: () => setDirection(e, d) })),
    },
    link: { label: t('compose_link'), icon: <Link2 size={14} />, ...run(p.actions.openLink) },
    unlink: { label: t('compose_link_remove'), icon: <Unlink size={14} />, ...run(() => { e.chain().focus().extendMarkRange('link').unsetLink().run(); }) },
    quote: { label: t('compose_quote_block'), icon: <TextQuote size={14} />, ...run(() => { e.chain().focus().toggleBlockquote().run(); }) },
    code: { label: t('compose_code'), icon: <Code size={14} />, ...run(() => { e.chain().focus().toggleCode().run(); }) },
    superscript: { label: t('compose_superscript'), icon: <Superscript size={14} />, ...run(() => { e.chain().focus().toggleMark('superscript').run(); }) },
    subscript: { label: t('compose_subscript'), icon: <Subscript size={14} />, ...run(() => { e.chain().focus().toggleMark('subscript').run(); }) },
    strike: { label: t('compose_strike'), icon: <Strikethrough size={14} />, ...run(() => { e.chain().focus().toggleStrike().run(); }) },
    image: { label: t('compose_insert_image'), icon: <ImageIcon size={14} />, ...run(p.actions.insertImage) },
    table: {
      label: t('compose_table'), icon: <TableIcon size={14} />,
      children: tableCommandsFor(s.inTable).flatMap((id): ContextMenuItem[] => [
        ...(id === 'rowBefore' || id === 'deleteRow' ? [{ type: 'divider' as const }] : []),
        {
          label: t(`compose_table_${id}` as TranslationKey),
          ...(tableCommand(e, id, true) ? {} : { disabled: true }),
          onClick: () => { tableCommand(e, id, false); },
        },
      ]),
    },
    rule: { label: t('compose_rule'), icon: <Minus size={14} />, ...run(() => { e.chain().focus().setHorizontalRule().run(); }) },
    style: {
      label: t('compose_style'), icon: <Heading size={14} />,
      children: PARAGRAPH_STYLES.map((id) => ({
        label: t(`compose_style_${id}` as TranslationKey), checked: activeStyle(e) === id, onClick: () => applyStyle(e, id),
      })),
    },
    font: { label: t('compose_font'), icon: <Type size={14} />, children: fontMenu(e, t) },
    size: { label: t('compose_size'), icon: <ALargeSmall size={14} />, children: sizeMenu(e, t) },
    undo: { label: t('compose_undo'), icon: <Undo2 size={14} />, ...(e.can().undo() ? {} : { disabled: true }), ...run(() => { e.chain().focus().undo().run(); }) },
    redo: { label: t('compose_redo'), icon: <Redo2 size={14} />, ...(e.can().redo() ? {} : { disabled: true }), ...run(() => { e.chain().focus().redo().run(); }) },
    clear: { label: t('compose_clear'), icon: <RemoveFormatting size={14} />, ...run(() => { e.chain().focus().clearNodes().unsetAllMarks().run(); }) },
  };
  return { ...defs[entry.id], ...checked };
}

function flyoutMenu(e: Editor | null, t: T, p: Props): ContextMenuItem[] {
  if (!e) return [];
  const s = flyoutState(e);
  return formatFlyout(s).flatMap((section, i): ContextMenuItem[] => [
    ...(i > 0 ? [{ type: 'divider' as const }] : []),
    ...section.map((entry) => flyoutItem(entry, e, s, t, p)),
  ]);
}

/** The toolbar buttons, by id. */
function barItems(e: Editor | null, t: T, p: Props): Record<FormatBarId, CommandItem> {
  const on = (name: string) => !!e?.isActive(name);
  const run = (fn: (ed: Editor) => void) => () => { if (e) fn(e); };
  const base = (id: FormatBarId, labelKey: TranslationKey, icon: ReactNode, extra: Partial<CommandItem>): CommandItem => ({
    id, label: t(labelKey), icon, iconOnly: true, ...(e ? {} : { disabled: true }), ...extra,
  });
  const size = e?.getAttributes('textStyle')['fontSize'] as string | undefined;
  const step = (dir: 1 | -1) => stepFontSize(size, p.defaultSize, dir);
  const sizeStep = (dir: 1 | -1): Partial<CommandItem> => {
    const next = step(dir);
    return next
      ? { onClick: run((ed) => ed.chain().focus().setMark('textStyle', { fontSize: next }).run()) }
      : { disabled: true };
  };
  const textColor = e?.getAttributes('textStyle')['color'] as string | undefined;
  const highlight = e?.getAttributes('highlight')['color'] as string | undefined;
  return {
    grow: base('grow', 'compose_grow', <AArrowUp size={ICON} />, sizeStep(1)),
    shrink: base('shrink', 'compose_shrink', <AArrowDown size={ICON} />, sizeStep(-1)),
    bold: base('bold', 'compose_bold', <Bold size={ICON} />, { onClick: run((ed) => ed.chain().focus().toggleBold().run()), pressed: on('bold'), keyshortcuts: 'Control+B' }),
    italic: base('italic', 'compose_italic', <Italic size={ICON} />, { onClick: run((ed) => ed.chain().focus().toggleItalic().run()), pressed: on('italic'), keyshortcuts: 'Control+I' }),
    underline: base('underline', 'compose_underline', <Underline size={ICON} />, { onClick: run((ed) => ed.chain().focus().toggleUnderline().run()), pressed: on('underline'), keyshortcuts: 'Control+U' }),
    highlight: base('highlight', 'compose_highlight', <Highlighter size={ICON} />, {
      menu: () => colorMenu(HIGHLIGHT_COLORS, highlight, 'compose_hl_', t, (hex) => {
        if (!e) return;
        if (hex) e.chain().focus().setHighlight({ color: hex }).run(); else e.chain().focus().unsetHighlight().run();
      }, t('compose_highlight_none')),
    }),
    color: base('color', 'compose_color', <Baseline size={ICON} />, {
      menu: () => colorMenu(TEXT_COLORS, textColor, 'compose_color_', t, (hex) => {
        if (!e) return;
        if (hex) e.chain().focus().setColor(hex).run(); else e.chain().focus().unsetColor().run();
      }, t('compose_color_auto')),
    }),
    bullets: base('bullets', 'compose_bullets', <List size={ICON} />, { onClick: run((ed) => ed.chain().focus().toggleBulletList().run()), pressed: on('bulletList') }),
    numbering: base('numbering', 'compose_numbering', <ListOrdered size={ICON} />, { onClick: run((ed) => ed.chain().focus().toggleOrderedList().run()), pressed: on('orderedList') }),
    indent: base('indent', 'compose_indent', <IndentIncrease size={ICON} />, { onClick: run((ed) => ed.chain().focus().sinkListItem('listItem').run()) }),
    link: base('link', 'compose_link', <Link2 size={ICON} />, { onClick: p.actions.openLink, pressed: on('link') }),
    emoji: base('emoji', 'compose_emoji_title', <Smile size={ICON} />, { onClick: p.actions.openEmoji, dialogOpen: p.emojiOpen }),
  };
}

/** 10.1: the toolbar's buttons for the ribbon's compose tabs (same handlers as the card's bar). */
export function formatBarCommands(p: FormatBarProps, t: T): Record<FormatBarId, CommandItem> {
  return barItems(p.editor, t, p);
}

/**
 * 10.1: the flyout's entries as ribbon commands (submenus become dropdowns,
 * toggles stay toggles); empty without an editor. "Link entfernen" only inside a link.
 */
export function formatFlyoutCommands(p: FormatBarProps, t: T): Partial<Record<FlyoutEntryId, CommandItem>> {
  const e = p.editor;
  if (!e) return {};
  const s = flyoutState(e);
  const out: Partial<Record<FlyoutEntryId, CommandItem>> = {};
  for (const entry of formatFlyout(s).flat()) out[entry.id] = commandFromMenuItem(`fmt-${entry.id}`, flyoutItem(entry, e, s, t, p));
  return out;
}

export type FormatBarProps = Props;

export function ComposeFormatBar(p: Props) {
  const t = useT();
  const items = barItems(p.editor, t, p);
  const flyout: CommandItem = {
    id: 'format-more', label: t('compose_format_more'), icon: <ChevronDown size={ICON} />, iconOnly: true, placement: 'pinned',
    ...(p.editor ? {} : { disabled: true }),
    menu: () => flyoutMenu(p.editor, t, p),
  };
  return (
    <div className="shrink-0 m-3 mt-0 px-2 py-1 rounded-lg bg-surface-2 text-[13px] [&_[data-roving-stop]:hover]:bg-surface-3">
      <CommandBar
        label={t('compose_format_label')}
        groups={[{ id: 'format', items: [...FORMAT_BAR.map((id) => items[id]), flyout] }]}
      />
    </div>
  );
}
