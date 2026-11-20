/**
 * 10.2: editor side of growing tables (positions and decisions: lib/composeTable.ts).
 * - growTable: "+" handles — a column after the last column / a row after the
 *   last row, the cursor in the first new cell.
 * - TableEnterExt: Enter on the empty last paragraph of the table's last cell
 *   adds a row (the empty paragraph is dropped unless it is the cell's only block).
 * - editorTables: the tables of the document with their DOM elements (never the
 *   tables inside non-editable content).
 * Tab in the last cell adds a row and Shift+Tab goes back: Tiptap's Table
 * extension already does both (addKeyboardShortcuts Tab / Shift-Tab).
 */
import { Extension, type Editor } from '@tiptap/react';
import { cellEnterAction, edgeCellPos, firstTextPos, type GrowDirection, type NodeLike } from '../../lib/composeTable.js';

type Doc = Editor['state']['doc'];
type PmNode = ReturnType<Doc['child']>;

const CELL_TYPES = new Set(['tableCell', 'tableHeader']);

/** Text position inside the table's edge cell (lib edgeCellPos), or null. */
function edgeTextPos(doc: Doc, tablePos: number, dir: GrowDirection): number | null {
  const table = doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table') return null;
  const cellPos = edgeCellPos(table as NodeLike, tablePos, dir);
  if (cellPos === null) return null;
  const cell = doc.nodeAt(cellPos);
  return cell ? firstTextPos(cell as NodeLike, cellPos) : null;
}

/**
 * Adds a column after the last column / a row after the last row of the table at
 * `tablePos`; the new cells are empty and the cursor goes into the first new
 * one. False when the editor could not (read-only, not a table).
 */
export function growTable(editor: Editor, tablePos: number, dir: GrowDirection): boolean {
  if (!editor.isEditable) return false;
  const from = edgeTextPos(editor.state.doc, tablePos, dir);
  if (from === null) return false;
  const chain = editor.chain().focus().setTextSelection(from);
  return (dir === 'col' ? chain.addColumnAfter() : chain.addRowAfter())
    .command(({ tr, commands }) => {
      const to = edgeTextPos(tr.doc, tablePos, dir);
      return to !== null && commands.setTextSelection(to);
    })
    .scrollIntoView()
    .run();
}

/** Enter in the last cell (lib cellEnterAction); false leaves Enter to the editor (a line break in the cell). */
function enterInLastCell(editor: Editor): boolean {
  const { selection } = editor.state;
  const $from = selection.$from;
  const d = $from.depth;
  // doc > table > tableRow > cell > paragraph: the paragraph is at depth ≥ 4
  if (d < 4) return false;
  const para = $from.parent;
  const cell = $from.node(d - 1);
  const row = $from.node(d - 2);
  const table = $from.node(d - 3);
  const action = cellEnterAction({
    selectionEmpty: selection.empty,
    paragraphInCell: para.type.name === 'paragraph' && CELL_TYPES.has(cell.type.name)
      && row.type.name === 'tableRow' && table.type.name === 'table',
    paragraphEmpty: para.content.size === 0,
    blockIndex: $from.index(d - 1), blockCount: cell.childCount,
    cellIndex: $from.index(d - 2), cellCount: row.childCount,
    rowIndex: $from.index(d - 3), rowCount: table.childCount,
  });
  if (action === 'default') return false;
  const tablePos = $from.before(d - 3);
  const paraFrom = $from.before(d);
  const paraTo = $from.after(d);
  return editor.chain()
    .command(({ tr, commands }) => {
      if (action === 'dropParagraphAndAddRow') tr.delete(paraFrom, paraTo);
      // a cursor in the last row, so the row is added after it
      const anchor = edgeTextPos(tr.doc, tablePos, 'row');
      return anchor !== null && commands.setTextSelection(anchor);
    })
    .addRowAfter()
    .command(({ tr, commands }) => {
      const to = edgeTextPos(tr.doc, tablePos, 'row');
      return to !== null && commands.setTextSelection(to);
    })
    .scrollIntoView()
    .run();
}

/** Enter on the empty last paragraph of a table's last cell adds a row (like Enter on an empty list item). */
export const TableEnterExt = Extension.create({
  name: 'tableEnter',
  // before the list / paragraph Enter handling
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => enterInLastCell(editor as Editor) };
  },
});

export interface EditorTable { pos: number; dom: HTMLElement }

/** The document's tables with their rendered element (tables nest: outer before inner). */
export function editorTables(editor: Editor): EditorTable[] {
  const out: EditorTable[] = [];
  editor.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type.name !== 'table') return true;
    const dom = editor.view.nodeDOM(pos);
    const el = dom instanceof HTMLElement ? (dom.tagName === 'TABLE' ? dom : dom.querySelector('table')) : null;
    if (el) out.push({ pos, dom: el });
    return true;
  });
  return out;
}
