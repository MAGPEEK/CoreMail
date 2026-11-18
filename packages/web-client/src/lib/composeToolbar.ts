/**
 * 9.4: model of the compose bars — the formatting toolbar below the body and
 * its chevron flyout, the action bar at the bottom, the "…" menu of the
 * command row, and font size steps of "Schrift größer / kleiner". Which
 * commands exist depends on the format (HTML / plain text), the editor state
 * (cursor in a table, in a link) and where the compose is (inline / own
 * window). Pure — unit-tested with `node --test`.
 */
import { COMPOSE_FONT_SIZES_PT, sizeValue } from './composeFonts.ts';
import { TABLE_COMMANDS, type TableCommandId } from './composeFormat.ts';

// ── Formatting toolbar ──────────────────────────────────────────────────────

export type FormatBarId =
  | 'grow' | 'shrink' | 'bold' | 'italic' | 'underline' | 'highlight' | 'color' | 'bullets' | 'numbering' | 'indent';

/** Buttons of the formatting toolbar, in order (the flyout chevron follows). */
export const FORMAT_BAR: readonly FormatBarId[] = [
  'grow', 'shrink', 'bold', 'italic', 'underline', 'highlight', 'color', 'bullets', 'numbering', 'indent',
];

/** Plain-text format has nothing to format: the toolbar (and its flyout) is hidden. */
export function formatBarVisible(plain: boolean): boolean {
  return !plain;
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

// ── Action bar (bottom) ─────────────────────────────────────────────────────

export type ActionBarId = 'send' | 'discard' | 'attach' | 'inlineImage' | 'emoji' | 'signature' | 'more';

/** Bottom bar: pictures need HTML; the signature picker only with named signatures. */
export function actionBarCommands(plain: boolean, hasSignatures: boolean): ActionBarId[] {
  return (['send', 'discard', 'attach', 'inlineImage', 'emoji', 'signature', 'more'] as const)
    .filter((id) => !(plain && id === 'inlineImage') && !(!hasSignatures && id === 'signature'));
}

// ── "…" menu ────────────────────────────────────────────────────────────────

export type MoreMenuId = 'save' | 'showFrom' | 'checkNames' | 'importance' | 'format' | 'options' | 'a11y' | 'popout';

/** Entries of the "…" menu (the own window has no "In neuem Fenster öffnen"). */
export function moreMenuCommands(inWindow: boolean): MoreMenuId[] {
  const all: MoreMenuId[] = ['save', 'showFrom', 'checkNames', 'importance', 'format', 'options', 'a11y', 'popout'];
  return inWindow ? all.filter((id) => id !== 'popout') : all;
}

/** Label of the format switch: the format the mail changes to. */
export function formatSwitchLabel(plain: boolean): 'compose_to_html' | 'compose_to_plain' {
  return plain ? 'compose_to_html' : 'compose_to_plain';
}
