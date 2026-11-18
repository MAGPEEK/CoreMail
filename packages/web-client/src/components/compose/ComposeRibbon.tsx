/**
 * Ribbon of the compose area: tabs Nachricht (basics), Einfügen and Format,
 * each a shared command bar (roving focus, "…" overflow). Plain-text format
 * keeps only Einfügen (lib/composeRules.ts ribbonTabs / insertCommands).
 */
import { useId, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, CalendarDays, Code, Heading, Highlighter,
  Image as ImageIcon, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, Minus, Paperclip, PenLine,
  Redo2, RemoveFormatting, Smile, Strikethrough, TextQuote, Type, Underline, Undo2, Unlink, ALargeSmall,
} from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { signatureMenu } from './ComposeCommandRow.js';
import {
  COMPOSE_FONTS, COMPOSE_FONT_SIZES, HIGHLIGHT_COLORS, PARAGRAPH_STYLES, TEXT_COLORS, dateTimeInsertOptions, fontLabel,
  sizeLabel, type ContentColor, type ParagraphStyleId,
} from '../../lib/composeFormat.js';
import { insertCommands, ribbonTabs, type InsertCommandId, type RibbonTabId } from '../../lib/composeRules.js';
import { nextRovingIndex } from '../../lib/toolbarNav.js';
import type { NamedSignature } from '../../lib/signaturePick.js';
import type { RegionalSettings } from '../../lib/regionalFormat.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

export interface RibbonActions {
  attachFile: () => void;
  insertImage: () => void;
  openLink: () => void;
  openEmoji: (anchor: HTMLElement) => void;
  pickSignature: (id: string) => void;
}

interface Props {
  editor: Editor | null;
  plain: boolean;
  tab: RibbonTabId;
  onTab: (tab: RibbonTabId) => void;
  signatures: NamedSignature[];
  regional: RegionalSettings;
  emojiOpen: boolean;
  actions: RibbonActions;
}

type T = (key: TranslationKey) => string;

const swatch = (hex: string): ReactNode => (
  <span className="w-3.5 h-3.5 rounded-sm border border-line-strong" style={{ backgroundColor: hex }} />
);

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

/** Editor commands of the ribbon, by id (one definition per command, used by several tabs). */
function editorCommands(e: Editor | null, t: T, p: Props): Record<string, CommandItem> {
  const on = (name: string, attrs?: Record<string, unknown>) => !!e?.isActive(name, attrs);
  const run = (fn: (ed: Editor) => void) => () => { if (e) fn(e); };
  const item = (id: string, labelKey: TranslationKey, icon: ReactNode, onClick: () => void, extra: Partial<CommandItem> = {}): CommandItem => ({
    id, label: t(labelKey), icon, onClick, ...(e ? {} : { disabled: true }), ...extra,
  });
  const menuItem = (id: string, labelKey: TranslationKey, icon: ReactNode, menu: () => ContextMenuItem[]): CommandItem => ({
    id, label: t(labelKey), icon, menu, ...(e ? {} : { disabled: true }),
  });
  const align = (id: 'left' | 'center' | 'right' | 'justify', icon: ReactNode) =>
    item(`align-${id}`, `compose_align_${id}`, icon, run((ed) => ed.chain().focus().setTextAlign(id).run()), { pressed: !!e?.isActive({ textAlign: id }) });
  const textColor = e?.getAttributes('textStyle')['color'] as string | undefined;
  const highlight = e?.getAttributes('highlight')['color'] as string | undefined;
  const font = e?.getAttributes('textStyle')['fontFamily'] as string | undefined;
  const size = e?.getAttributes('textStyle')['fontSize'] as string | undefined;
  return {
    undo: item('undo', 'compose_undo', <Undo2 size={15} />, run((ed) => ed.chain().focus().undo().run()),
      { keyshortcuts: 'Control+Z', ...(e?.can().undo() ? {} : { disabled: true }) }),
    redo: item('redo', 'compose_redo', <Redo2 size={15} />, run((ed) => ed.chain().focus().redo().run()),
      { keyshortcuts: 'Control+Y', ...(e?.can().redo() ? {} : { disabled: true }) }),
    bold: item('bold', 'compose_bold', <Bold size={15} />, run((ed) => ed.chain().focus().toggleBold().run()), { pressed: on('bold'), keyshortcuts: 'Control+B' }),
    italic: item('italic', 'compose_italic', <Italic size={15} />, run((ed) => ed.chain().focus().toggleItalic().run()), { pressed: on('italic'), keyshortcuts: 'Control+I' }),
    underline: item('underline', 'compose_underline', <Underline size={15} />, run((ed) => ed.chain().focus().toggleUnderline().run()), { pressed: on('underline'), keyshortcuts: 'Control+U' }),
    strike: item('strike', 'compose_strike', <Strikethrough size={15} />, run((ed) => ed.chain().focus().toggleStrike().run()), { pressed: on('strike') }),
    bullets: item('bullets', 'compose_bullets', <List size={15} />, run((ed) => ed.chain().focus().toggleBulletList().run()), { pressed: on('bulletList') }),
    numbering: item('numbering', 'compose_numbering', <ListOrdered size={15} />, run((ed) => ed.chain().focus().toggleOrderedList().run()), { pressed: on('orderedList') }),
    outdent: item('outdent', 'compose_outdent', <IndentDecrease size={15} />, run((ed) => ed.chain().focus().liftListItem('listItem').run())),
    indent: item('indent', 'compose_indent', <IndentIncrease size={15} />, run((ed) => ed.chain().focus().sinkListItem('listItem').run())),
    quote: item('quote', 'compose_quote_block', <TextQuote size={15} />, run((ed) => ed.chain().focus().toggleBlockquote().run()), { pressed: on('blockquote') }),
    code: item('code', 'compose_code', <Code size={15} />, run((ed) => ed.chain().focus().toggleCode().run()), { pressed: on('code') }),
    clear: item('clear', 'compose_clear', <RemoveFormatting size={15} />, run((ed) => ed.chain().focus().clearNodes().unsetAllMarks().run())),
    link: item('link', 'compose_link', <Link2 size={15} />, p.actions.openLink, { pressed: on('link') }),
    unlink: item('unlink', 'compose_link_remove', <Unlink size={15} />, run((ed) => ed.chain().focus().extendMarkRange('link').unsetLink().run()),
      on('link') ? {} : { disabled: true }),
    'align-left': align('left', <AlignLeft size={15} />),
    'align-center': align('center', <AlignCenter size={15} />),
    'align-right': align('right', <AlignRight size={15} />),
    'align-justify': align('justify', <AlignJustify size={15} />),
    style: menuItem('style', 'compose_style', <Heading size={15} />, () => PARAGRAPH_STYLES.map((id) => ({
      label: t(`compose_style_${id}` as TranslationKey), checked: !!e && activeStyle(e) === id, onClick: run((ed) => applyStyle(ed, id)),
    }))),
    font: menuItem('font', 'compose_font', <Type size={15} />, () => [
      { label: t('compose_font_default'), checked: !fontLabel(font), onClick: run((ed) => ed.chain().focus().unsetFontFamily().run()) },
      ...COMPOSE_FONTS.map((f) => ({ label: f.label, checked: fontLabel(font) === f.label, onClick: run((ed) => ed.chain().focus().setFontFamily(f.value).run()) })),
    ]),
    size: menuItem('size', 'compose_size', <ALargeSmall size={15} />, () => [
      { label: t('compose_size_default'), checked: !size, onClick: run((ed) => ed.chain().focus().setMark('textStyle', { fontSize: null }).run()) },
      ...COMPOSE_FONT_SIZES.map((s) => ({ label: sizeLabel(s), checked: size === s, onClick: run((ed) => ed.chain().focus().setMark('textStyle', { fontSize: s }).run()) })),
    ]),
    color: menuItem('color', 'compose_color', <Baseline size={15} />, () => colorMenu(TEXT_COLORS, textColor, 'compose_color_', t, (hex) => {
      if (!e) return;
      if (hex) e.chain().focus().setColor(hex).run(); else e.chain().focus().unsetColor().run();
    }, t('compose_color_auto'))),
    highlight: menuItem('highlight', 'compose_highlight', <Highlighter size={15} />, () => colorMenu(HIGHLIGHT_COLORS, highlight, 'compose_hl_', t, (hex) => {
      if (!e) return;
      if (hex) e.chain().focus().setHighlight({ color: hex }).run(); else e.chain().focus().unsetHighlight().run();
    }, t('compose_highlight_none'))),
  };
}

function insertItems(e: Editor | null, t: T, p: Props): CommandItem[] {
  const all: Record<InsertCommandId, CommandItem> = {
    file: { id: 'file', label: t('compose_file'), icon: <Paperclip size={15} />, onClick: p.actions.attachFile },
    image: { id: 'image', label: t('compose_image'), icon: <ImageIcon size={15} />, onClick: p.actions.insertImage },
    link: { id: 'ins-link', label: t('compose_link'), icon: <Link2 size={15} />, onClick: p.actions.openLink },
    emoji: { id: 'emoji', label: t('compose_emoji'), icon: <Smile size={15} />, onClick: p.actions.openEmoji, dialogOpen: p.emojiOpen },
    signature: {
      id: 'ins-signature', label: t('compose_signature'), icon: <PenLine size={15} />,
      menu: () => signatureMenu(p.signatures, p.actions.pickSignature, t('compose_no_signature')),
    },
    datetime: {
      id: 'datetime', label: t('compose_datetime'), icon: <CalendarDays size={15} />,
      menu: () => dateTimeInsertOptions(new Date(), p.regional).map((o) => ({
        label: o.text, onClick: () => { e?.chain().focus().insertContent(o.text).run(); },
      })),
    },
    rule: { id: 'rule', label: t('compose_rule'), icon: <Minus size={15} />, onClick: () => { e?.chain().focus().setHorizontalRule().run(); } },
  };
  return insertCommands(p.plain, p.signatures.length > 0).map((id) => ({ ...all[id], ...(e ? {} : { disabled: true }) }));
}

function groupsFor(tab: RibbonTabId, e: Editor | null, t: T, p: Props): CommandGroup[] {
  const c = editorCommands(e, t, p);
  if (tab === 'insert') return [{ id: 'insert', items: insertItems(e, t, p) }];
  if (tab === 'message') {
    return [
      { id: 'history', title: t('compose_group_history'), items: [c['undo']!, c['redo']!] },
      { id: 'text', title: t('compose_group_text'), items: [c['bold']!, c['italic']!, c['underline']!] },
      { id: 'paragraph', title: t('compose_group_paragraph'), items: [c['bullets']!, c['numbering']!] },
      { id: 'insert', title: t('compose_group_insert'), items: [c['link']!, c['clear']!] },
    ];
  }
  return [
    { id: 'font', title: t('compose_group_font'), items: [c['style']!, c['font']!, c['size']!] },
    { id: 'text', title: t('compose_group_text'), items: [c['bold']!, c['italic']!, c['underline']!, c['strike']!, c['color']!, c['highlight']!] },
    { id: 'paragraph', title: t('compose_group_paragraph'), items: [
      c['align-left']!, c['align-center']!, c['align-right']!, c['align-justify']!,
      c['bullets']!, c['numbering']!, c['outdent']!, c['indent']!, c['quote']!, c['code']!,
    ] },
    { id: 'clear', items: [c['unlink']!, c['clear']!] },
  ];
}

export function ComposeRibbon(p: Props) {
  const t = useT();
  const base = useId();
  const tabs = ribbonTabs(p.plain);
  const tabId = (id: RibbonTabId) => `${base}-tab-${id}`;
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = nextRovingIndex(tabs.indexOf(p.tab), e.key, tabs.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    const id = tabs[next]!;
    p.onTab(id);
    document.getElementById(tabId(id))?.focus();
  };
  return (
    <div className="shrink-0 border-b border-line bg-surface">
      <div role="tablist" aria-label={t('compose_ribbon_label')} onKeyDown={onTabKey} className="flex gap-1 px-2 pt-1">
        {tabs.map((id) => (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={id === p.tab}
            aria-controls={`${base}-panel`}
            tabIndex={id === p.tab ? 0 : -1}
            onClick={() => p.onTab(id)}
            className={`px-3 py-1 text-sm border-b-2 ${id === p.tab ? 'border-accent-fg text-fg font-semibold' : 'border-transparent text-fg-muted hover:text-fg'}`}
          >
            {t(`compose_tab_${id}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={tabId(p.tab)} className="px-1 py-1">
        <CommandBar label={t(`compose_tab_${p.tab}` as TranslationKey)} groups={groupsFor(p.tab, p.editor, t, p)} />
      </div>
    </div>
  );
}
