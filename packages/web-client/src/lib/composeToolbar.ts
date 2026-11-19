/**
 * Model of the compose bars: the header row at the top of the compose card
 * (quiet icon buttons, the "…" overflow menu, the Senden chevron menu), the
 * formatting toolbar at its bottom with its chevron flyout, and font size steps
 * of "Schrift größer / kleiner". Which commands exist depends on the format
 * (HTML / plain text), the editor state (cursor in a table, in a link) and where
 * the compose is (inline / own window). Pure — unit-tested with `node --test`.
 */
import { COMPOSE_FONT_SIZES_PT, sizeValue } from './composeFonts.ts';
import { TABLE_COMMANDS, type TableCommandId } from './composeFormat.ts';

// ── Formatting toolbar ──────────────────────────────────────────────────────

export type FormatBarId =
  | 'grow' | 'shrink' | 'bold' | 'italic' | 'underline' | 'highlight' | 'color' | 'bullets' | 'numbering' | 'indent'
  | 'link' | 'emoji';

/** Buttons of the formatting toolbar, in order (the flyout chevron follows). */
export const FORMAT_BAR: readonly FormatBarId[] = [
  'grow', 'shrink', 'bold', 'italic', 'underline', 'highlight', 'color', 'bullets', 'numbering', 'indent', 'link', 'emoji',
];

/** Plain-text format has nothing to format: the toolbar (and its flyout) is hidden. */
export function formatBarAvailable(plain: boolean): boolean {
  return !plain;
}

/** The toolbar shows when the format has anything to format and the roaming preference `composeFormatBar` is on. */
export function formatBarVisible(plain: boolean, preference: boolean): boolean {
  return formatBarAvailable(plain) && preference;
}

export type Alignment = 'left' | 'center' | 'right' | 'justify';
export const ALIGNMENTS: readonly Alignment[] = ['left', 'center', 'right', 'justify'];

export type TextDirection = 'ltr' | 'rtl';
export const TEXT_DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl'];

/** What the flyout needs to know about the editor at the cursor. */
export interface FlyoutState {
  inTable: boolean;
  inLink: boolean;
  align: Alignment;
  direction: TextDirection;
  superscript: boolean;
  subscript: boolean;
  strike: boolean;
  quote: boolean;
  code: boolean;
}

export type FlyoutEntryId =
  | 'outdent' | 'indent' | 'align' | 'direction'
  | 'link' | 'unlink' | 'quote' | 'code' | 'superscript' | 'subscript' | 'strike'
  | 'image' | 'table' | 'rule'
  | 'style' | 'font' | 'size'
  | 'undo' | 'redo' | 'clear';

export interface FlyoutEntry {
  id: FlyoutEntryId;
  /** Toggle state (menuitemcheckbox); absent = an action or a submenu. */
  checked?: boolean;
}

/**
 * Flyout of the chevron at the end of the formatting toolbar, as sections
 * (dividers between them). "Link entfernen" only inside a link; the table
 * submenu (tableCommandsFor) only offers row / column commands inside a table.
 */
export function formatFlyout(s: FlyoutState): FlyoutEntry[][] {
  return [
    [{ id: 'outdent' }, { id: 'indent' }],
    [{ id: 'align' }, { id: 'direction' }],
    [
      { id: 'link' }, ...(s.inLink ? [{ id: 'unlink' as const }] : []),
      { id: 'quote', checked: s.quote }, { id: 'code', checked: s.code },
      { id: 'superscript', checked: s.superscript }, { id: 'subscript', checked: s.subscript },
      { id: 'strike', checked: s.strike },
    ],
    [{ id: 'image' }, { id: 'table' }, { id: 'rule' }],
    [{ id: 'style' }, { id: 'font' }, { id: 'size' }],
    [{ id: 'undo' }, { id: 'redo' }, { id: 'clear' }],
  ];
}

/** Entries of the table submenu: "Tabelle einfügen", plus row / column commands inside a table. */
export function tableCommandsFor(inTable: boolean): TableCommandId[] {
  return inTable ? [...TABLE_COMMANDS] : ['insert'];
}

// ── Font size steps ─────────────────────────────────────────────────────────

/** A CSS size ("11pt", "14px") in points, or null. */
export function sizeInPoints(value: string | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)(pt|px)$/.exec((value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n * 0.75 : n;
}

/**
 * "Schrift größer / kleiner": the next size of the size list above / below the
 * current one (the text's size, else the default of new text); null at the end
 * of the list.
 */
export function stepFontSize(current: string | null | undefined, fallback: string, dir: 1 | -1): string | null {
  const pt = sizeInPoints(current) ?? sizeInPoints(fallback);
  if (pt === null) return null;
  const sizes = COMPOSE_FONT_SIZES_PT;
  const next = dir > 0 ? sizes.find((s) => s > pt) : [...sizes].reverse().find((s) => s < pt);
  return next === undefined ? null : sizeValue(next);
}

// ── Header row (top of the card) ────────────────────────────────────────────

export type HeaderId = 'attach' | 'inlineImage' | 'signature' | 'formatBar';

/**
 * Quiet icon buttons after "Senden": pictures need HTML, the signature picker
 * only with named signatures, the "Aa" toggle only where there is a toolbar.
 */
export function headerCommands(plain: boolean, hasSignatures: boolean): HeaderId[] {
  return (['attach', 'inlineImage', 'signature', 'formatBar'] as const)
    .filter((id) => !(plain && (id === 'inlineImage' || id === 'formatBar')) && !(!hasSignatures && id === 'signature'));
}

export type SendMenuId = 'send' | 'schedule' | 'importance' | 'options';

/** Entries of the chevron of "Senden": send, send later, importance, message options (sensitivity, receipts). */
export const SEND_MENU: readonly SendMenuId[] = ['send', 'schedule', 'importance', 'options'];

// ── "…" menu ────────────────────────────────────────────────────────────────

export type MoreMenuId = 'save' | 'showFrom' | 'checkNames' | 'datetime' | 'format' | 'formatBar' | 'a11y' | 'emoji';

/**
 * Entries of the header's "…" menu: everything the header does not show.
 * "Formatleiste" only in HTML, "Emoji" only in plain text (HTML has it in the toolbar).
 */
export function moreMenuCommands(plain: boolean): MoreMenuId[] {
  const all: MoreMenuId[] = ['save', 'showFrom', 'checkNames', 'datetime', 'format', 'formatBar', 'a11y', 'emoji'];
  return all.filter((id) => !(plain && id === 'formatBar') && !(!plain && id === 'emoji'));
}

/** Label of the format switch: the format the mail changes to. */
export function formatSwitchLabel(plain: boolean): 'compose_to_html' | 'compose_to_plain' {
  return plain ? 'compose_to_html' : 'compose_to_plain';
}

/** Label of the toolbar toggle: what a click does. */
export function formatBarToggleLabel(shown: boolean): 'compose_format_bar_hide' | 'compose_format_bar_show' {
  return shown ? 'compose_format_bar_hide' : 'compose_format_bar_show';
}

/**
 * Layout of the draft status in the header row. The status text appearing or
 * changing must never push command buttons into the overflow menu (a layout
 * jump), so: from 1180 px (the inline pane then has room for everything) the
 * status owns a fixed width; below that the text is for screen readers only
 * (the live region stays), except a failure, which is always visible. The own
 * window has the whole width and always reserves it. Literal class names so
 * Tailwind finds them.
 */
export function statusLayoutClass(inWindow: boolean, failed: boolean): string {
  if (inWindow) return 'min-w-[10rem] justify-end';
  return failed ? 'justify-end' : 'max-[1179px]:sr-only min-[1180px]:min-w-[10rem] min-[1180px]:justify-end';
}

/** Row heights in px of the address block; compact density takes 4 px off. */
export function fieldRowHeights(density: 'compact' | 'normal' | 'comfortable'): { row: number; subject: number } {
  const cut = density === 'compact' ? 4 : 0;
  return { row: 36 - cut, subject: 40 - cut };
}
