import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_START, GROW_HANDLE_PX, GROW_REACH, TABLE_GRID, cellEnterAction, clampGridSize, edgeCellPos, firstTextPos,
  gridCellHighlighted, growHandlePositions, insertTableOptions, moveGridSize, tableAtPoint,
  type CellEnterContext, type NodeLike,
} from './composeTable.ts';
import { NEW_TABLE } from './composeFormat.ts';
import { translations } from '../i18n/translations.ts';

test('size picker: an 8 × 8 grid, the highlight is the top-left rectangle', () => {
  assert.deepEqual(TABLE_GRID, { rows: 8, cols: 8 });
  assert.deepEqual(GRID_START, { rows: 1, cols: 1 });
  const s = { rows: 2, cols: 3 };
  assert.equal(gridCellHighlighted(1, 1, s), true);
  assert.equal(gridCellHighlighted(2, 3, s), true);
  assert.equal(gridCellHighlighted(3, 1, s), false, 'row below the rectangle');
  assert.equal(gridCellHighlighted(1, 4, s), false, 'column right of the rectangle');
  assert.deepEqual(clampGridSize({ rows: 0, cols: 12 }), { rows: 1, cols: 8 });
  assert.deepEqual(clampGridSize({ rows: 3.4, cols: -2 }), { rows: 3, cols: 1 });
});

test('size picker: arrows move the corner inside the grid, ArrowLeft in the first column goes back to the menu', () => {
  const s = { rows: 2, cols: 2 };
  assert.deepEqual(moveGridSize(s, 'ArrowRight'), { rows: 2, cols: 3 });
  assert.deepEqual(moveGridSize(s, 'ArrowDown'), { rows: 3, cols: 2 });
  assert.deepEqual(moveGridSize(s, 'ArrowUp'), { rows: 1, cols: 2 });
  assert.deepEqual(moveGridSize(s, 'ArrowLeft'), { rows: 2, cols: 1 });
  assert.equal(moveGridSize({ rows: 2, cols: 1 }, 'ArrowLeft'), null, 'the menu takes it (back)');
  assert.deepEqual(moveGridSize({ rows: 1, cols: 1 }, 'ArrowUp'), { rows: 1, cols: 1 }, 'stays at the top');
  assert.deepEqual(moveGridSize({ rows: 8, cols: 8 }, 'ArrowRight'), { rows: 8, cols: 8 }, 'stays at the edge');
  assert.deepEqual(moveGridSize({ rows: 8, cols: 8 }, 'ArrowDown'), { rows: 8, cols: 8 });
  assert.deepEqual(moveGridSize(s, 'Home'), { rows: 2, cols: 1 });
  assert.deepEqual(moveGridSize(s, 'End'), { rows: 2, cols: 8 });
  assert.deepEqual(moveGridSize(s, 'PageUp'), { rows: 1, cols: 2 });
  assert.deepEqual(moveGridSize(s, 'PageDown'), { rows: 8, cols: 2 });
  assert.equal(moveGridSize(s, 'Enter'), null, 'Enter inserts — not a move');
  assert.equal(moveGridSize(s, 'Escape'), null);
  assert.equal(moveGridSize(s, 'a'), null);
});

test('size picker: the inserted table keeps the header row of the fixed insert', () => {
  assert.deepEqual(insertTableOptions({ rows: 4, cols: 6 }), { rows: 4, cols: 6, withHeaderRow: NEW_TABLE.withHeaderRow });
  assert.deepEqual(insertTableOptions({ rows: 20, cols: 0 }), { rows: 8, cols: 1, withHeaderRow: NEW_TABLE.withHeaderRow });
});

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test('grow handles: the pointer over a table or its handle strip picks it, hidden tables never', () => {
  const boxes = [box(0, 0, 100, 50), box(0, 200, 100, 260), box(10, 10, 40, 30)];
  assert.equal(tableAtPoint(boxes, 50, 20), 2, 'the nested (later) table wins');
  assert.equal(tableAtPoint(boxes, 80, 20), 0);
  assert.equal(tableAtPoint(boxes, 100 + GROW_REACH, 25), 0, 'right handle strip');
  assert.equal(tableAtPoint(boxes, 50, 50 + GROW_REACH), 0, 'bottom handle strip');
  assert.equal(tableAtPoint(boxes, 101 + GROW_REACH, 25), -1);
  assert.equal(tableAtPoint(boxes, 50, 120), -1, 'between the tables');
  assert.equal(tableAtPoint(boxes, -1, 20), -1, 'left of the table');
  assert.equal(tableAtPoint(boxes, 50, 230), 1);
  assert.equal(tableAtPoint([box(10, 10, 10, 10)], 10, 10), -1, 'folded quote: zero size');
  assert.ok(GROW_REACH > GROW_HANDLE_PX, 'the strip covers the handles');
});

test('grow handles: centred on the right / bottom edge, outside the table, inside the layer', () => {
  const p = growHandlePositions(box(124, 140, 324, 240), { left: 100, top: 100 }, 600);
  assert.equal(GROW_HANDLE_PX, 24, 'at least a 24 px hit area');
  assert.deepEqual(p.col, { left: 226, top: 78 }, 'right of the table, vertically centred');
  assert.deepEqual(p.row, { left: 112, top: 142 }, 'below the table, horizontally centred');
  const wide = growHandlePositions(box(100, 100, 700, 200), { left: 100, top: 100 }, 600);
  assert.equal(wide.col.left, 576, 'never past the layer edge (no horizontal scroll)');
});

/** Fake ProseMirror nodes: text blocks have nodeSize = content + 2. */
const para = (text = 0): NodeLike => ({ nodeSize: text + 2, childCount: 0, isTextblock: true, child: () => { throw new Error('leaf'); } });
const node = (children: NodeLike[]): NodeLike => ({
  nodeSize: children.reduce((s, c) => s + c.nodeSize, 2), childCount: children.length, isTextblock: false, child: (i) => children[i]!,
});

test('document positions: the edge cells a grow starts from and lands in', () => {
  // table at 10: rows of [cell(p "ab"), cell(p)] / [cell(p), cell(list(item(p)))]
  const r0 = node([node([para(2)]), node([para()])]);
  const r1 = node([node([para()]), node([node([node([para()])])])]);
  const table = node([r0, r1]);
  // 10 table, 11 r0, 12 cell0 (size 6), 18 cell1
  assert.equal(edgeCellPos(table, 10, 'col'), 18, 'last cell of the first row');
  // r0 size 2 + 6 + 4 = 12 → r1 at 23, its first cell at 24
  assert.equal(edgeCellPos(table, 10, 'row'), 24, 'first cell of the last row');
  assert.equal(edgeCellPos(node([]), 0, 'row'), null);
  assert.equal(edgeCellPos(node([node([])]), 0, 'col'), null);
  assert.equal(firstTextPos(r0.child(1), 18), 20, 'inside the cell paragraph');
  // second cell of r1: 24 + 4 = 28; list 29, item 30, paragraph 31 → text 32
  assert.equal(firstTextPos(r1.child(1), 28), 32, 'first text block in a list');
  assert.equal(firstTextPos(node([node([])]), 0), null);
});

const at = (o: Partial<CellEnterContext>): CellEnterContext => ({
  selectionEmpty: true, paragraphInCell: true, paragraphEmpty: true,
  blockIndex: 1, blockCount: 2, cellIndex: 2, cellCount: 3, rowIndex: 2, rowCount: 3, ...o,
});

test('Enter in a table: only the empty last paragraph of the last cell adds a row', () => {
  assert.equal(cellEnterAction(at({})), 'dropParagraphAndAddRow');
  assert.equal(cellEnterAction(at({ blockIndex: 0, blockCount: 1 })), 'addRow', 'an empty cell keeps its only paragraph');
  assert.equal(cellEnterAction(at({ paragraphEmpty: false })), 'default', 'text in the paragraph: a line break');
  assert.equal(cellEnterAction(at({ blockIndex: 0 })), 'default', 'empty paragraph above other content');
  assert.equal(cellEnterAction(at({ cellIndex: 1 })), 'default', 'not the last cell of the row');
  assert.equal(cellEnterAction(at({ rowIndex: 1 })), 'default', 'not the last row');
  assert.equal(cellEnterAction(at({ selectionEmpty: false })), 'default', 'a selection');
  assert.equal(cellEnterAction(at({ paragraphInCell: false })), 'default', 'e.g. a list item inside the cell');
});

test('table texts: German labels of the picker and the handles', () => {
  const de = translations.de;
  assert.equal(de.compose_table_insert, 'Tabelle einfügen');
  assert.equal(de.compose_table_add_col, 'Spalte hinzufügen');
  assert.equal(de.compose_table_add_row, 'Zeile hinzufügen');
  assert.equal(de.compose_table_grid, 'Tabellengröße');
  assert.ok(de.compose_table_size.includes('{rows}') && de.compose_table_size.includes('{cols}'));
  assert.ok(de.compose_table_cell.includes('{rows}') && de.compose_table_cell.includes('{cols}'));
  assert.equal(translations.en.compose_table_add_col, 'Add column');
  assert.equal(translations.en.compose_table_add_row, 'Add row');
  // compose texts: Spanish / Italian fall back to English (composeUi.test.ts)
  for (const lang of ['es', 'it'] as const) assert.equal(translations[lang].compose_table_add_row, translations.en.compose_table_add_row);
});
