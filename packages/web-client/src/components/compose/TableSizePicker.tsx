/**
 * 10.2: size picker of "Tabelle einfügen" (Word / Outlook style) — an 8 × 8
 * grid inside the table submenu. Hovering highlights the top-left rectangle and
 * shows "Spalten × Zeilen" below, a click inserts that size. Keyboard: the grid
 * is one focus stop (role="grid", aria-activedescendant = the rectangle's
 * corner); arrows / Home / End / PageUp / PageDown move the corner, Enter or
 * Space inserts, Escape and ArrowLeft in the first column go back to the menu
 * (lib/composeTable.ts moveGridSize).
 */
import { useId, useState, type KeyboardEvent } from 'react';
import { GRID_START, TABLE_GRID, gridCellHighlighted, moveGridSize, type GridSize } from '../../lib/composeTable.js';
import { fmt, useT } from '../../i18n/useT.js';

interface Props {
  onPick: (size: GridSize) => void;
  /** Closes the whole menu (before the table is inserted, so focus can go to the editor). */
  onClose: () => void;
}

const ROWS = Array.from({ length: TABLE_GRID.rows }, (_, i) => i + 1);
const COLS = Array.from({ length: TABLE_GRID.cols }, (_, i) => i + 1);

export function TableSizePicker({ onPick, onClose }: Props) {
  const t = useT();
  const baseId = useId();
  const [size, setSize] = useState<GridSize>(GRID_START);
  const cellId = (row: number, col: number) => `${baseId}-r${row}c${col}`;

  const pick = (s: GridSize) => {
    onClose();
    onPick(s);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      pick(size);
      return;
    }
    const next = moveGridSize(size, e.key);
    // Escape, Tab, ArrowLeft in the first column: the menu's keys (back / close)
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    setSize(next);
  };

  return (
    <div className="px-3 py-2.5">
      <div
        role="grid"
        aria-label={t('compose_table_grid')}
        aria-activedescendant={cellId(size.rows, size.cols)}
        tabIndex={-1}
        data-menuitem
        onKeyDown={onKeyDown}
        className="flex flex-col gap-1 w-fit mx-auto rounded-sm focus-visible:outline-offset-4"
      >
        {ROWS.map((row) => (
          <div key={row} role="row" className="flex gap-1">
            {COLS.map((col) => {
              const on = gridCellHighlighted(row, col, size);
              return (
                <div
                  key={col}
                  id={cellId(row, col)}
                  role="gridcell"
                  aria-selected={on}
                  aria-label={fmt(t('compose_table_cell'), { rows: row, cols: col })}
                  onMouseEnter={() => setSize({ rows: row, cols: col })}
                  onClick={() => pick({ rows: row, cols: col })}
                  className={`w-5 h-5 rounded-sm border cursor-pointer transition-colors ${
                    on ? 'bg-accent/20 border-accent' : 'bg-surface border-line-strong'
                  }`}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* The corner cell's label is announced through aria-activedescendant */}
      <div aria-hidden="true" className="mt-2 text-center text-[13px] tabular-nums text-fg-muted">
        {fmt(t('compose_table_size'), { rows: size.rows, cols: size.cols })}
      </div>
    </div>
  );
}
