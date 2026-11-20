/**
 * 10.2: growing tables in the compose editor — the size picker of "Tabelle
 * einfügen" (8 × 8 grid, word-processor style), the "+" handles at the right
 * and bottom edge of a table (add a column / row at the end) and Enter on an
 * empty last paragraph of the table's last cell (adds a row, like Enter on an
 * empty list item). Pure — unit-tested with `node --test`; the editor wiring
 * lives in components/compose/tableGrow.ts and TableGrowHandles.tsx.
 */
import { NEW_TABLE } from './composeFormat.ts';

// ── Size picker ─────────────────────────────────────────────────────────────

/** A table size, 1-based (rows × columns). */
export interface GridSize { rows: number; cols: number }

/** Cells of the size picker. */
export const TABLE_GRID: GridSize = { rows: 8, cols: 8 };

/** Where the picker's highlight starts when it opens by keyboard (the old fixed insert). */
export const GRID_START: GridSize = { rows: 1, cols: 1 };

const clamp = (n: number, max: number) => Math.min(max, Math.max(1, Math.round(n)));

/** A size inside the picker (1 … max on both axes). */
export function clampGridSize(s: GridSize, max: GridSize = TABLE_GRID): GridSize {
  return { rows: clamp(s.rows, max.rows), cols: clamp(s.cols, max.cols) };
}

/**
 * Keyboard model of the picker: arrows grow / shrink the highlighted rectangle,
 * Home / End jump to the first / last column, PageUp / PageDown to the first /
 * last row. ArrowLeft in the first column is not the picker's (null): the menu
 * takes it and goes back to "Tabelle einfügen". Null = not a picker key.
 */
export function moveGridSize(s: GridSize, key: string, max: GridSize = TABLE_GRID): GridSize | null {
  const c = clampGridSize(s, max);
  switch (key) {
    case 'ArrowRight': return { ...c, cols: Math.min(max.cols, c.cols + 1) };
    case 'ArrowLeft': return c.cols > 1 ? { ...c, cols: c.cols - 1 } : null;
    case 'ArrowDown': return { ...c, rows: Math.min(max.rows, c.rows + 1) };
    case 'ArrowUp': return { ...c, rows: Math.max(1, c.rows - 1) };
    case 'Home': return { ...c, cols: 1 };
    case 'End': return { ...c, cols: max.cols };
    case 'PageUp': return { ...c, rows: 1 };
    case 'PageDown': return { ...c, rows: max.rows };
    default: return null;
  }
}

/** The cell (1-based row / column) lies in the highlighted top-left rectangle. */
export function gridCellHighlighted(row: number, col: number, s: GridSize): boolean {
  return row <= s.rows && col <= s.cols;
}

/** Options of `insertTable` for a picked size; the header row as the fixed insert had it. */
export function insertTableOptions(s: GridSize): { rows: number; cols: number; withHeaderRow: boolean } {
  const c = clampGridSize(s);
  return { rows: c.rows, cols: c.cols, withHeaderRow: NEW_TABLE.withHeaderRow };
}

// ── "+" handles at the table edge ───────────────────────────────────────────

export interface Box { left: number; top: number; right: number; bottom: number }

/** Hit area of a "+" handle (px; at least 24 × 24, WCAG 2.5.8) and its gap to the table edge. */
export const GROW_HANDLE_PX = 24;
export const GROW_HANDLE_GAP = 2;

/** How far right of / below a table the pointer still belongs to it (reaches its handles). */
export const GROW_REACH = GROW_HANDLE_PX + GROW_HANDLE_GAP + 6;

/**
 * Index of the table the pointer is over or next to (its handle strip on the
 * right / bottom included); -1 when none. Hidden tables (zero size, e.g. inside
 * the folded quote) never match. The innermost / last match wins, so a table
 * nested in a cell beats its outer table.
 */
export function tableAtPoint(boxes: readonly Box[], x: number, y: number, reach: number = GROW_REACH): number {
  let hit = -1;
  boxes.forEach((b, i) => {
    if (b.right - b.left <= 0 || b.bottom - b.top <= 0) return;
    if (x >= b.left && x <= b.right + reach && y >= b.top && y <= b.bottom + reach) hit = i;
  });
  return hit;
}

export interface HandlePositions {
  /** "Spalte hinzufügen": centred on the right edge, just outside it. */
  col: { left: number; top: number };
  /** "Zeile hinzufügen": centred on the bottom edge, just below it. */
  row: { left: number; top: number };
}

/**
 * Positions of the two handles inside the overlay layer (`origin` = the layer's
 * box, same coordinate space as `table`). The column handle never leaves the
 * layer on the right (`layerWidth`), so it cannot widen the scroll area.
 */
export function growHandlePositions(table: Box, origin: { left: number; top: number }, layerWidth: number,
  size: number = GROW_HANDLE_PX, gap: number = GROW_HANDLE_GAP): HandlePositions {
  const midY = (table.top + table.bottom) / 2 - origin.top;
  const midX = (table.left + table.right) / 2 - origin.left;
  const colLeft = Math.min(table.right - origin.left + gap, Math.max(0, layerWidth - size));
  return {
    col: { left: Math.round(colLeft), top: Math.round(midY - size / 2) },
    row: { left: Math.round(midX - size / 2), top: Math.round(table.bottom - origin.top + gap) },
  };
}

// ── Document positions (structural, works on ProseMirror nodes) ─────────────

/** The bits of a ProseMirror node the position maths needs. */
export interface NodeLike {
  nodeSize: number;
  childCount: number;
  isTextblock: boolean;
  child(index: number): NodeLike;
}

export type GrowDirection = 'row' | 'col';

/**
 * Position (before the cell) of the cell a grow starts from — and, after the
 * grow, the first new cell: for a column the last cell of the first row (it
 * always reaches the last column), for a row the first cell of the last row.
 * Null for a table without rows / cells.
 */
export function edgeCellPos(table: NodeLike, tablePos: number, dir: GrowDirection): number | null {
  if (table.childCount === 0) return null;
  const rowIndex = dir === 'col' ? 0 : table.childCount - 1;
  let pos = tablePos + 1;
  for (let i = 0; i < rowIndex; i++) pos += table.child(i).nodeSize;
  const row = table.child(rowIndex);
  if (row.childCount === 0) return null;
  pos += 1;
  const cellIndex = dir === 'col' ? row.childCount - 1 : 0;
  for (let i = 0; i < cellIndex; i++) pos += row.child(i).nodeSize;
  return pos;
}

/** Start of the first text block inside `node` (at `pos`, the position before it); null without one. */
export function firstTextPos(node: NodeLike, pos: number): number | null {
  if (node.isTextblock) return pos + 1;
  let p = pos + 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const found = firstTextPos(child, p);
    if (found !== null) return found;
    p += child.nodeSize;
  }
  return null;
}

// ── Enter in the last cell ──────────────────────────────────────────────────

/** Where the cursor is, for Enter inside a table. */
export interface CellEnterContext {
  /** Collapsed cursor (no range / cell selection). */
  selectionEmpty: boolean;
  /** The cursor's block is a plain paragraph directly inside a cell of a table. */
  paragraphInCell: boolean;
  paragraphEmpty: boolean;
  /** Index of the paragraph in its cell / count of the cell's blocks. */
  blockIndex: number;
  blockCount: number;
  /** Index of the cell in its row / cells of the row. */
  cellIndex: number;
  cellCount: number;
  /** Index of the row in the table / rows of the table. */
  rowIndex: number;
  rowCount: number;
}

/**
 * - `default`: Enter stays a line break inside the cell (a new paragraph).
 * - `addRow`: the empty paragraph is the cell's only block — it stays, a row is added.
 * - `dropParagraphAndAddRow`: the empty last paragraph is removed, a row is added.
 * Only the empty LAST paragraph of the table's LAST cell grows the table.
 */
export type CellEnterAction = 'default' | 'addRow' | 'dropParagraphAndAddRow';

export function cellEnterAction(c: CellEnterContext): CellEnterAction {
  if (!c.selectionEmpty || !c.paragraphInCell || !c.paragraphEmpty) return 'default';
  const lastBlock = c.blockIndex === c.blockCount - 1;
  const lastCell = c.cellIndex === c.cellCount - 1 && c.rowIndex === c.rowCount - 1;
  if (!lastBlock || !lastCell) return 'default';
  return c.blockCount > 1 ? 'dropParagraphAndAddRow' : 'addRow';
}
