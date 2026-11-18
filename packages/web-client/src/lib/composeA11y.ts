/**
 * 9.4: "Auf Barrierefreiheitsprobleme prüfen" of the compose area — a local
 * check of the body (nothing leaves the browser):
 *  - pictures without alternative text (an explicit empty `alt=""` marks a
 *    decorative picture and counts as resolved),
 *  - tables without a header row,
 *  - text colours with too little contrast (below 4.5:1 against the
 *    highlight, else the white a mail is usually shown on; theme contrast helper),
 *  - links without text,
 *  - long runs of capitals (four or more words in a row).
 * The quoted original of a reply / forward is not checked (not the user's text).
 * `collectA11yItems` walks the editor document through a minimal node
 * interface; `checkAccessibility` turns the items into issues with the
 * document position to jump to. Pure — unit-tested with `node --test`.
 */
import { contrastRatio, type Rgb } from '../theme/contrast.ts';

export type A11yItem =
  | { kind: 'image'; pos: number; alt: string | null }
  | { kind: 'table'; pos: number; headerRow: boolean }
  | { kind: 'link'; pos: number; text: string; href: string }
  | { kind: 'colored'; pos: number; text: string; color: string | null; background: string | null }
  | { kind: 'block'; pos: number; text: string };

export type A11yIssueKind = 'imageAlt' | 'tableHeader' | 'contrast' | 'emptyLink' | 'uppercase';

export interface A11yIssue {
  kind: A11yIssueKind;
  /** Document position to jump to. */
  pos: number;
  /** Short excerpt of the affected text (empty for pictures and tables). */
  excerpt: string;
  /** Contrast issues: the ratio, rounded down to one decimal. */
  ratio?: number;
}

/** WCAG 2.2 AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;
/** Four or more words of two or more capitals in a row. */
const UPPERCASE_RUN = /(?:^|[^\p{L}])((?:\p{Lu}{2,}[^\p{L}\n]+){3}\p{Lu}{2,})(?![\p{L}])/u;
const EXCERPT_LENGTH = 40;

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** A CSS colour of mail content (#rgb, #rrggbb, rgb()/rgba()) as RGB, or null. */
export function parseCssColor(value: string | null | undefined): Rgb | null {
  const v = (value ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]!].map((c) => parseInt(c + c, 16)) as unknown as Rgb;
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as unknown as Rgb;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(v);
  if (rgb) {
    const ch = [rgb[1], rgb[2], rgb[3]].map(Number);
    return ch.every((n) => n <= 255) ? (ch as unknown as Rgb) : null;
  }
  return null;
}

const excerpt = (text: string) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > EXCERPT_LENGTH ? `${s.slice(0, EXCERPT_LENGTH - 1)}…` : s;
};

function contrastIssue(item: Extract<A11yItem, { kind: 'colored' }>): A11yIssue | null {
  if (!item.text.trim()) return null;
  const fg = item.color ? parseCssColor(item.color) : BLACK;
  const bg = item.background ? parseCssColor(item.background) : WHITE;
  if (!fg || !bg) return null;                 // a colour we cannot read: not judged
  const ratio = contrastRatio(fg, bg);
  if (ratio >= MIN_TEXT_CONTRAST) return null;
  return { kind: 'contrast', pos: item.pos, excerpt: excerpt(item.text), ratio: Math.floor(ratio * 10) / 10 };
}

/** A picture is fine with alternative text or an explicit empty `alt` (decorative). */
export function isImageAltResolved(alt: string | null): boolean {
  return alt !== null && (alt === '' || alt.trim() !== '');
}

/**
 * The `alt` value to set from the dialog inputs: '' for a decorative picture,
 * the trimmed text otherwise, null while neither is given (nothing to apply).
 */
export function altTextToApply(text: string, decorative: boolean): string | null {
  if (decorative) return '';
  const t = text.trim();
  return t ? t : null;
}

/** Issues of the collected items, in document order. */
export function checkAccessibility(items: readonly A11yItem[]): A11yIssue[] {
  const issues: A11yIssue[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'image':
        if (!isImageAltResolved(item.alt)) issues.push({ kind: 'imageAlt', pos: item.pos, excerpt: '' });
        break;
      case 'table':
        if (!item.headerRow) issues.push({ kind: 'tableHeader', pos: item.pos, excerpt: '' });
        break;
      case 'link':
        if (!item.text.trim()) issues.push({ kind: 'emptyLink', pos: item.pos, excerpt: item.href });
        break;
      case 'colored': {
        const issue = contrastIssue(item);
        if (issue) issues.push(issue);
        break;
      }
      case 'block': {
        const m = UPPERCASE_RUN.exec(item.text);
        if (m) issues.push({ kind: 'uppercase', pos: item.pos, excerpt: excerpt(m[1]!) });
        break;
      }
    }
  }
  return issues.sort((a, b) => a.pos - b.pos);
}

/**
 * Where "Anzeigen" puts the cursor: pictures and tables are selected as a
 * whole, a paragraph at its first character, coloured text / links at their start.
 */
export function jumpTarget(issue: A11yIssue): { select: 'node' | 'text'; pos: number } {
  if (issue.kind === 'imageAlt' || issue.kind === 'tableHeader') return { select: 'node', pos: issue.pos };
  return { select: 'text', pos: issue.kind === 'uppercase' ? issue.pos + 1 : issue.pos };
}

// ── Walking the editor document ─────────────────────────────────────────────

interface MarkLike { type: { name: string }; attrs: Record<string, unknown> }
export interface NodeLike {
  type: { name: string };
  attrs: Record<string, unknown>;
  isText: boolean;
  isTextblock: boolean;
  text?: string | undefined;
  textContent: string;
  nodeSize: number;
  marks: readonly MarkLike[];
  firstChild: NodeLike | null;
  forEach(fn: (child: NodeLike) => void): void;
}
export interface DocLike {
  descendants(fn: (node: NodeLike, pos: number) => boolean | void): void;
}

const markOf = (node: NodeLike, name: string) => node.marks.find((m) => m.type.name === name);
const attr = (m: MarkLike | undefined, key: string) => {
  const v = m?.attrs[key];
  return typeof v === 'string' && v ? v : null;
};

function hasHeaderRow(table: NodeLike): boolean {
  const row = table.firstChild;
  if (!row) return false;
  let all = true;
  let cells = 0;
  row.forEach((cell) => { cells++; if (cell.type.name !== 'tableHeader') all = false; });
  return cells > 0 && all;
}

/** Items of the document the checks look at (the quoted original is skipped). */
export function collectA11yItems(doc: DocLike): A11yItem[] {
  const items: A11yItem[] = [];
  let lastLink: { item: Extract<A11yItem, { kind: 'link' }>; end: number } | null = null;
  doc.descendants((node, pos) => {
    const name = node.type.name;
    // the quoted original (QuoteMarkerExt: attribute `quote` = '')
    if (name === 'blockquote' && node.attrs['quote'] === '') return false;
    if (name === 'image') items.push({ kind: 'image', pos, alt: typeof node.attrs['alt'] === 'string' ? node.attrs['alt'] : null });
    if (name === 'table') items.push({ kind: 'table', pos, headerRow: hasHeaderRow(node) });
    if (node.isTextblock) items.push({ kind: 'block', pos, text: node.textContent });
    if (!node.isText) return true;
    const text = node.text ?? '';
    const link = attr(markOf(node, 'link'), 'href');
    if (link) {
      // one link split into several text nodes (bold part …) is one link
      if (lastLink && lastLink.end === pos && lastLink.item.href === link) lastLink.item.text += text;
      else { const item = { kind: 'link' as const, pos, text, href: link }; items.push(item); lastLink = { item, end: pos }; }
      lastLink.end = pos + node.nodeSize;
    }
    const color = attr(markOf(node, 'textStyle'), 'color');
    const background = attr(markOf(node, 'highlight'), 'color');
    if (color || background) items.push({ kind: 'colored', pos, text, color, background });
    return false;
  });
  return items;
}
