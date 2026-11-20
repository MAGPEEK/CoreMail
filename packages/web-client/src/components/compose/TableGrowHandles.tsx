/**
 * 10.2: the "+" handles at the edge of a table in the compose editor — one
 * centred on the right edge ("Spalte hinzufügen": a column after the last
 * column), one centred on the bottom edge ("Zeile hinzufügen": a row after the
 * last row). They show for the table under the pointer (its handle strip
 * included) or, while the editor has focus, the table with the cursor.
 *
 * A React overlay next to the editor, never part of the document: the layer is
 * a sibling of the ProseMirror element (absolute, pointer-events only on the
 * buttons), positioned from the table's DOM box, so getHTML() / the draft
 * autosave never see it. Mouse-down does not take the focus from the editor.
 * Keyboard users grow tables with Tab in the last cell, Enter on an empty last
 * paragraph or the table menu — the handles stay out of the tab order.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Plus } from 'lucide-react';
import { GROW_HANDLE_PX, growHandlePositions, tableAtPoint, type GrowDirection, type HandlePositions } from '../../lib/composeTable.js';
import { editorTables, growTable } from './tableGrow.js';
import { useT } from '../../i18n/useT.js';

interface Props {
  editor: Editor | null;
  /** Off in plain-text format. */
  enabled: boolean;
}

interface Shown extends HandlePositions { pos: number }

/** Position of the innermost table around the cursor, or null. */
function cursorTablePos(editor: Editor): number | null {
  const $from = editor.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return $from.before(d);
  }
  return null;
}

function tableElement(editor: Editor, pos: number): HTMLElement | null {
  return editorTables(editor).find((tb) => tb.pos === pos)?.dom ?? null;
}

export function TableGrowHandles({ editor, enabled }: Props) {
  const t = useT();
  const layerRef = useRef<HTMLDivElement>(null);
  const hoverPos = useRef<number | null>(null);
  const frame = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);

  /** Recomputes which table gets the handles and where (next frame, after layout). */
  const update = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const layer = layerRef.current;
      if (!enabled || !editor || editor.isDestroyed || !editor.isEditable || !layer) { setShown(null); return; }
      const pos = hoverPos.current ?? (editor.isFocused ? cursorTablePos(editor) : null);
      const el = pos === null ? null : tableElement(editor, pos);
      const box = el?.getBoundingClientRect();
      // Hidden tables (the folded quote) have no box
      if (pos === null || !box || box.width === 0 || box.height === 0) { setShown(null); return; }
      const origin = layer.getBoundingClientRect();
      const next = { pos, ...growHandlePositions(box, origin, origin.width) };
      setShown((prev) => (prev && prev.pos === next.pos && prev.col.left === next.col.left && prev.col.top === next.col.top
        && prev.row.left === next.row.left && prev.row.top === next.row.top ? prev : next));
    });
  }, [editor, enabled]);

  // Editor changes (typing, growing, focus) and layout changes move the handles
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', update);
    const layer = layerRef.current;
    const observer = new ResizeObserver(update);
    if (layer) observer.observe(layer);
    if (layer?.parentElement) observer.observe(layer.parentElement);
    window.addEventListener('resize', update);
    update();
    return () => {
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', update);
      observer.disconnect();
      window.removeEventListener('resize', update);
      cancelAnimationFrame(frame.current);
    };
  }, [editor, update]);

  // The table under the pointer (the layer's parent wraps the editor and the handles)
  useEffect(() => {
    const host = layerRef.current?.parentElement;
    if (!host || !editor) return;
    const onMove = (e: MouseEvent) => {
      if (editor.isDestroyed) return;
      const tables = editorTables(editor);
      const i = tableAtPoint(tables.map((tb) => tb.dom.getBoundingClientRect()), e.clientX, e.clientY);
      const pos = i < 0 ? null : tables[i]!.pos;
      if (pos !== hoverPos.current) { hoverPos.current = pos; update(); }
    };
    const onLeave = () => {
      if (hoverPos.current !== null) { hoverPos.current = null; update(); }
    };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', onLeave);
    };
  }, [editor, update]);

  const grow = (dir: GrowDirection) => {
    if (editor && shown) growTable(editor, shown.pos, dir);
  };

  return (
    <div ref={layerRef} className="absolute inset-0 pointer-events-none" data-compose-table-handles>
      {shown && editor && (
        <>
          <GrowButton label={t('compose_table_add_col')} left={shown.col.left} top={shown.col.top} onGrow={() => grow('col')} />
          <GrowButton label={t('compose_table_add_row')} left={shown.row.left} top={shown.row.top} onGrow={() => grow('row')} />
        </>
      )}
    </div>
  );
}

interface GrowButtonProps { label: string; left: number; top: number; onGrow: () => void }

function GrowButton({ label, left, top, onGrow }: GrowButtonProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      // the editor keeps its focus (and selection)
      onMouseDown={(e) => e.preventDefault()}
      onClick={onGrow}
      className="absolute pointer-events-auto flex items-center justify-center rounded-full border border-line-strong bg-surface text-fg-muted shadow-sm transition-colors hover:bg-accent hover:border-accent hover:text-white active:bg-accent-active"
      style={{ left, top, width: GROW_HANDLE_PX, height: GROW_HANDLE_PX }}
    >
      <Plus size={14} aria-hidden="true" />
    </button>
  );
}
