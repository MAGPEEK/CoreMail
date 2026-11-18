/**
 * 9.4: choices of the compose ribbon — colours, paragraph styles, emoji and
 * the date/time formats of "Einfügen → Datum/Uhrzeit" (fonts and sizes:
 * lib/composeFonts.ts). Labels of
 * colours and styles come from the translation table (`compose_color_<id>`,
 * `compose_style_<id>`). Pure — unit-tested with `node --test`.
 */
import { formatDate, formatTime, localeOf, type RegionalSettings } from './regionalFormat.ts';

/**
 * Tables written into a mail: inline styles (mail clients ignore our CSS) —
 * collapsed borders, a thin grey grid and cell padding; the first row is a
 * header row. Mail content, not the app theme.
 */
export const TABLE_STYLE = 'border-collapse: collapse; margin: 4px 0';
export const TABLE_CELL_STYLE = 'border: 1px solid #a6a6a6; padding: 4px 8px; vertical-align: top; min-width: 2em';
export const NEW_TABLE = { rows: 3, cols: 3, withHeaderRow: true } as const;

/** Commands of "Einfügen → Tabelle" (insert first; the others need the cursor in a table). */
export type TableCommandId =
  | 'insert' | 'rowBefore' | 'rowAfter' | 'colBefore' | 'colAfter' | 'deleteRow' | 'deleteCol' | 'deleteTable';
export const TABLE_COMMANDS: readonly TableCommandId[] = [
  'insert', 'rowBefore', 'rowAfter', 'colBefore', 'colAfter', 'deleteRow', 'deleteCol', 'deleteTable',
];

export type ParagraphStyleId = 'paragraph' | 'h1' | 'h2' | 'h3' | 'codeBlock';
export const PARAGRAPH_STYLES: readonly ParagraphStyleId[] = ['paragraph', 'h1', 'h2', 'h3', 'codeBlock'];

export interface ContentColor { id: string; hex: string }

/** Text colours (mail content, not the app theme). */
export const TEXT_COLORS: readonly ContentColor[] = [
  { id: 'black', hex: '#000000' }, { id: 'darkgray', hex: '#434343' }, { id: 'gray', hex: '#999999' },
  { id: 'red', hex: '#cc0000' }, { id: 'orange', hex: '#e69138' }, { id: 'yellow', hex: '#f1c232' },
  { id: 'green', hex: '#38761d' }, { id: 'teal', hex: '#45818e' }, { id: 'blue', hex: '#1155cc' },
  { id: 'darkblue', hex: '#073763' }, { id: 'purple', hex: '#674ea7' }, { id: 'pink', hex: '#a64d79' },
];

/** Highlight colours (light, the text stays readable on them). */
export const HIGHLIGHT_COLORS: readonly ContentColor[] = [
  { id: 'yellow', hex: '#ffff00' }, { id: 'lightgreen', hex: '#b6d7a8' }, { id: 'cyan', hex: '#a2e8f0' },
  { id: 'pink', hex: '#f4cccc' }, { id: 'orange', hex: '#fce5cd' }, { id: 'lavender', hex: '#d9d2e9' },
];

/** Emoji of "Einfügen → Emoji" (screen readers announce each by its own name). */
export const COMPOSE_EMOJI: readonly string[] = [
  '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😍', '😘', '😎',
  '🤔', '😐', '😅', '😂', '🥳', '😢', '😮', '😴', '🙄', '😬',
  '👍', '👎', '👏', '🙏', '👋', '💪', '🤝', '✌️', '👌', '✅',
  '❌', '⚠️', '❗', '❓', '💡', '🔥', '⭐', '🎉', '❤️', '📎',
  '📅', '📌', '📞', '✉️', '☕', '🚀',
];

export const EMOJI_COLUMNS = 10;

/** Arrow-key movement in a grid of `count` cells, `cols` per row; null = not a grid key. */
export function gridMove(index: number, key: string, count: number, cols: number): number | null {
  if (count <= 0) return null;
  const i = index < 0 ? 0 : index;
  switch (key) {
    case 'ArrowRight': return Math.min(count - 1, i + 1);
    case 'ArrowLeft': return Math.max(0, i - 1);
    case 'ArrowDown': return i + cols < count ? i + cols : i;
    case 'ArrowUp': return i - cols >= 0 ? i - cols : i;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

export type DateTimeFormatId = 'date' | 'longDate' | 'time' | 'dateTime';

/** The texts "Einfügen → Datum/Uhrzeit" offers for `now`, in the user's regional format. */
export function dateTimeInsertOptions(now: Date, r: RegionalSettings): Array<{ id: DateTimeFormatId; text: string }> {
  const longDate = new Intl.DateTimeFormat(localeOf(r.language), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...(r.timeZone ? { timeZone: r.timeZone } : {}),
  }).format(now);
  return [
    { id: 'date', text: formatDate(now, r) },
    { id: 'longDate', text: longDate },
    { id: 'time', text: formatTime(now, r) },
    { id: 'dateTime', text: `${formatDate(now, r)} ${formatTime(now, r)}` },
  ];
}
