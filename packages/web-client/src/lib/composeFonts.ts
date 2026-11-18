/**
 * 9.4: fonts and font sizes of the compose area and of Settings → Verfassen.
 * Common system fonts grouped by script; every entry is our own CSS font
 * stack: the font, close relatives, an open alternative (Noto, Liberation,
 * DejaVu) and a generic family last, so a mail reads well where the font is
 * missing. Settings store the bare name ("Calibri") or a size ("11pt", older
 * values "14px"); the editor writes the stack. Pure — unit-tested with `node --test`.
 */

export type FontScript = 'latin' | 'cjk' | 'other';

export interface ComposeFont {
  /** Name shown in the menu (and stored by Settings). */
  label: string;
  /** CSS font-family value written into the mail. */
  stack: string;
  script: FontScript;
}

export const FONT_SCRIPTS: readonly FontScript[] = ['latin', 'cjk', 'other'];

const SANS = "'Noto Sans', 'Liberation Sans', 'DejaVu Sans', sans-serif";
const SERIF = "'Noto Serif', 'Liberation Serif', 'DejaVu Serif', serif";
const MONO = "'Noto Sans Mono', 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const CJK_SC = "'Noto Sans SC', 'Noto Sans CJK SC', sans-serif";
const CJK_SC_SERIF = "'Noto Serif SC', 'Noto Serif CJK SC', serif";
const CJK_TC = "'Noto Sans TC', 'Noto Sans CJK TC', sans-serif";
const CJK_TC_SERIF = "'Noto Serif TC', 'Noto Serif CJK TC', serif";
const CJK_JP = "'Noto Sans JP', 'Noto Sans CJK JP', sans-serif";
const CJK_KR = "'Noto Sans KR', 'Noto Sans CJK KR', sans-serif";
const CJK_KR_SERIF = "'Noto Serif KR', 'Noto Serif CJK KR', serif";

const font = (label: string, script: FontScript, rest: string): ComposeFont => ({ label, script, stack: `'${label}', ${rest}` });

export const COMPOSE_FONTS: readonly ComposeFont[] = [
  font('Arial', 'latin', `Helvetica, 'Liberation Sans', 'Noto Sans', sans-serif`),
  font('Arial Black', 'latin', `'Arial Bold', Gadget, ${SANS}`),
  font('Calibri', 'latin', `Carlito, 'Segoe UI', ${SANS}`),
  font('Cambria', 'latin', `Caladea, Georgia, ${SERIF}`),
  font('Candara', 'latin', `Calibri, 'Segoe UI', ${SANS}`),
  font('Century Gothic', 'latin', `'URW Gothic', 'Avant Garde', ${SANS}`),
  font('Comic Sans MS', 'latin', `'Comic Neue', 'Chalkboard SE', cursive, sans-serif`),
  font('Consolas', 'latin', `'Cascadia Mono', Menlo, ${MONO}`),
  font('Constantia', 'latin', `Cambria, Georgia, ${SERIF}`),
  font('Corbel', 'latin', `'Segoe UI', Calibri, ${SANS}`),
  font('Courier New', 'latin', `Courier, 'Liberation Mono', ${MONO}`),
  font('Franklin Gothic', 'latin', `'Franklin Gothic Medium', 'Libre Franklin', ${SANS}`),
  font('Garamond', 'latin', `'EB Garamond', 'Times New Roman', ${SERIF}`),
  font('Georgia', 'latin', `'Gelasio', 'Times New Roman', ${SERIF}`),
  font('Helvetica', 'latin', `'Helvetica Neue', Arial, ${SANS}`),
  font('Impact', 'latin', `Haettenschweiler, 'Anton', ${SANS}`),
  font('Lucida Console', 'latin', `Monaco, 'Courier New', ${MONO}`),
  font('Lucida Sans Unicode', 'latin', `'Lucida Grande', 'Lucida Sans', ${SANS}`),
  font('Palatino Linotype', 'latin', `Palatino, 'Book Antiqua', 'TeX Gyre Pagella', ${SERIF}`),
  font('Segoe UI', 'latin', `-apple-system, 'Helvetica Neue', ${SANS}`),
  font('Tahoma', 'latin', `Verdana, 'DejaVu Sans', 'Noto Sans', sans-serif`),
  font('Times New Roman', 'latin', `Times, 'Liberation Serif', 'Noto Serif', serif`),
  font('Trebuchet MS', 'latin', `'Lucida Grande', 'Fira Sans', ${SANS}`),
  font('Verdana', 'latin', `Geneva, 'DejaVu Sans', 'Noto Sans', sans-serif`),
  font('Microsoft YaHei', 'cjk', `'PingFang SC', 'Hiragino Sans GB', ${CJK_SC}`),
  font('SimHei', 'cjk', `'Heiti SC', 'STHeiti', ${CJK_SC}`),
  font('NSimSun', 'cjk', `SimSun, 'Songti SC', ${CJK_SC_SERIF}`),
  font('Microsoft JhengHei', 'cjk', `'PingFang TC', 'Heiti TC', ${CJK_TC}`),
  font('PMingLiU', 'cjk', `MingLiU, 'Songti TC', ${CJK_TC_SERIF}`),
  font('Meiryo', 'cjk', `'Hiragino Kaku Gothic ProN', 'Yu Gothic', ${CJK_JP}`),
  font('MS PGothic', 'cjk', `'MS Gothic', 'Hiragino Sans', ${CJK_JP}`),
  font('Yu Gothic', 'cjk', `YuGothic, 'Hiragino Sans', ${CJK_JP}`),
  font('Malgun Gothic', 'cjk', `'Apple SD Gothic Neo', 'Nanum Gothic', ${CJK_KR}`),
  font('Gulim', 'cjk', `Dotum, 'Apple SD Gothic Neo', ${CJK_KR}`),
  font('Batang', 'cjk', `BatangChe, AppleMyungjo, ${CJK_KR_SERIF}`),
  font('Leelawadee UI', 'other', `Leelawadee, Thonburi, 'Noto Sans Thai', ${SANS}`),
  font('Nirmala UI', 'other', `'Kohinoor Devanagari', 'Noto Sans Devanagari', ${SANS}`),
  font('Mangal', 'other', `'Devanagari Sangam MN', 'Noto Sans Devanagari', ${SANS}`),
  font('Nyala', 'other', `Kefa, 'Noto Sans Ethiopic', ${SANS}`),
  font('Sylfaen', 'other', `'Noto Serif Armenian', 'Noto Serif Georgian', ${SERIF}`),
];

/** Generic families a stack may end with. */
export const GENERIC_FAMILIES: readonly string[] = ['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui'];

/** Font used for new text when Settings → Verfassen has none. */
export const DEFAULT_FONT_LABEL = 'Calibri';

/** Font sizes in points (the menu and Settings). */
export const COMPOSE_FONT_SIZES_PT: readonly number[] = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
export const DEFAULT_FONT_SIZE = '11pt';

export const sizeValue = (pt: number): string => `${pt}pt`;

/** Menu label of a CSS size: "11 pt" (older px values: "14 px"). */
export function sizeLabel(value: string): string {
  const m = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(value.trim());
  return m ? `${m[1]} ${m[2]}` : value;
}

/** First family of a CSS font-family value, unquoted, lower-case. */
function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase();
}

/** The entry a stored name or a CSS font-family value belongs to, or null. */
export function findFont(value: string | undefined | null): ComposeFont | null {
  if (!value) return null;
  const name = firstFamily(value);
  return COMPOSE_FONTS.find((f) => f.label.toLowerCase() === name) ?? null;
}

/** Entries of one script group, in menu order. */
export function fontsOf(script: FontScript): ComposeFont[] {
  return COMPOSE_FONTS.filter((f) => f.script === script);
}

/**
 * Font and size new text starts with: Settings → Verfassen (stored name → its
 * stack; a size as stored), else Calibri 11 pt.
 */
export function composeTextDefaults(prefs: { fontFamily: string; fontSize: string }): { fontFamily: string; fontSize: string } {
  const chosen = findFont(prefs.fontFamily);
  const fallback = findFont(DEFAULT_FONT_LABEL)!;
  const size = /^\d+(?:\.\d+)?(pt|px)$/.test(prefs.fontSize.trim()) ? prefs.fontSize.trim() : DEFAULT_FONT_SIZE;
  return { fontFamily: (chosen ?? fallback).stack, fontSize: size };
}
