import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import {
  ariaSort, clampPage, filterRows, nextRowIndex, nextSort, pageCount, pageRange, paginate, pruneSelection,
  selectionState, sortRows, toggleAllVisible, toggleSelected, type SortState, type SortValue,
} from '../lib/dataTable.js';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Plain-text header for aria labels when `header` is not a string. */
  label?: string;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable (client-side lists). */
  sortValue?: (row: T) => SortValue;
  className?: string;
  headerClassName?: string;
  /** Header only visible to screen readers (e.g. the actions column). */
  srOnlyHeader?: boolean;
}

export interface ToolbarContext<T> {
  selectedRows: T[];
  clearSelection: () => void;
}

interface ServerPaging {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Accessible name of the table (rendered as a visually hidden caption). */
  caption: string;
  loading?: boolean;
  /**
   * Search box. Client-side: give `text(row)` (strings searched).
   * Server-side: give `value` + `onChange` (the page sends `search`/`q` to the API).
   */
  search?: { placeholder?: string; text?: (row: T) => ReadonlyArray<string | null | undefined>; value?: string; onChange?: (q: string) => void };
  /** Server-side paging (API supports page/limit). Without it, paging is client-side. */
  server?: ServerPaging;
  /** Client-side page size (default 25). */
  pageSize?: number;
  initialSort?: SortState;
  /** Checkbox selection with a count. */
  selectable?: boolean;
  /** Toolbar slot (New ▾ / Edit / Delete / Refresh / More) — gets the selection. */
  toolbar?: (ctx: ToolbarContext<T>) => ReactNode;
  /** Extra filter controls, rendered next to the search box. */
  filters?: ReactNode;
  /** Row activation (click / Enter) — opens the detail panel. */
  onActivate?: (row: T) => void;
  /** Key of the row shown in the detail panel (highlighted, aria-current). */
  activeKey?: string | null;
  rowClassName?: (row: T) => string;
  emptyText?: ReactNode;
  /** Optional sub-row under a row (e.g. inline details); spans all columns. */
  renderExpanded?: (row: T) => ReactNode;
}

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="menuitem"]';

/**
 * EAC-style list: toolbar → search → sortable, paged table with selection
 * count → (optional) detail panel next to it. Semantic <table> with
 * caption, th scope, aria-sort; rows are keyboard navigable (↑/↓/Home/End/
 * PgUp/PgDn move, Space toggles selection, Enter opens the details).
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    rows, columns, rowKey, caption, loading, search, server, pageSize = 25, initialSort,
    selectable, toolbar, filters, onActivate, activeKey, rowClassName, emptyText, renderExpanded,
  } = props;
  const t = useT();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  const serverSearch = !!search && search.onChange !== undefined;
  const sortColumn = columns.find((c) => c.key === sort?.key);

  // Client pipeline: search → sort → page. Server mode: rows are one page already.
  const filtered = useMemo(
    () => (search?.text && !serverSearch ? filterRows(rows, query, search.text) : [...rows]),
    [rows, query, search?.text, serverSearch],
  );
  const sorted = useMemo(
    () => (server ? filtered : sortRows(filtered, sort, sortColumn?.sortValue)),
    [filtered, sort, sortColumn, server],
  );
  const total = server ? server.total : sorted.length;
  const size = server ? server.pageSize : pageSize;
  const currentPage = server ? server.page : clampPage(page, total, size);
  const visible = useMemo(() => (server ? sorted : paginate(sorted, currentPage, size)), [server, sorted, currentPage, size]);
  const visibleKeys = visible.map(rowKey);
  const pages = pageCount(total, size);
  const range = pageRange(currentPage, size, total);

  // Selection follows the data: drop keys of rows that vanished (delete / refresh / new server page).
  const allKeys = (server ? visible : rows).map(rowKey).join('\u0000');
  useEffect(() => {
    setSelected((s) => {
      const next = pruneSelection(s, allKeys ? allKeys.split('\u0000') : []);
      return next.size === s.size ? s : next;
    });
  }, [allKeys]);
  // Back to page 1 when the client-side search changes.
  useEffect(() => { if (!server) setPage(1); }, [query, server]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected, rowKey]);
  const headState = selectionState(selected, visibleKeys);
  const goPage = (p: number) => {
    const target = clampPage(p, total, size);
    if (server) server.onPageChange(target); else setPage(target);
    setFocusIdx(0);
  };

  const focusRow = (i: number) => {
    setFocusIdx(i);
    rowRefs.current[i]?.focus();
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T, i: number) => {
    if (e.target !== e.currentTarget) return; // keys inside cell controls behave normally
    const next = nextRowIndex(i, e.key, visible.length);
    if (next !== null) { e.preventDefault(); focusRow(next); return; }
    if (e.key === ' ' && selectable) { e.preventDefault(); setSelected((s) => toggleSelected(s, rowKey(row))); return; }
    if (e.key === 'Enter' && onActivate) { e.preventDefault(); onActivate(row); }
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, row: T, i: number) => {
    setFocusIdx(i);
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    onActivate?.(row);
  };

  const colCount = columns.length + (selectable ? 1 : 0);
  const tabbable = Math.min(focusIdx, Math.max(0, visible.length - 1));

  return (
    <div className="space-y-3">
      {/* Toolbar: actions left, filters + search right */}
      <div className="flex items-center gap-2 flex-wrap">
        {toolbar && <div className="flex items-center gap-1.5 flex-wrap" role="toolbar" aria-label={caption}>{toolbar({ selectedRows, clearSelection: () => setSelected(new Set()) })}</div>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {filters}
          {search && (
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" aria-hidden="true" />
              <input
                type="search"
                value={serverSearch ? search.value ?? '' : query}
                onChange={(e) => (serverSearch ? search.onChange!(e.target.value) : setQuery(e.target.value))}
                className="input pl-8 w-60"
                placeholder={search.placeholder ?? t('dt_search')}
                aria-label={search.placeholder ?? t('dt_search')}
              />
              {(serverSearch ? search.value : query) && (
                <button type="button" onClick={() => (serverSearch ? search.onChange!('') : setQuery(''))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label={t('dt_clear_search')}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {selectable && (
        <p className="text-xs text-gray-500 dark:text-gray-400 min-h-4" aria-live="polite">
          {selected.size > 0 && (
            <>
              {selected.size} {t('dt_selected')}
              <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setSelected(new Set())}>{t('dt_clear_selection')}</button>
            </>
          )}
        </p>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm" aria-busy={loading ? 'true' : undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <tr>
              {selectable && (
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={t('dt_select_all')}
                    checked={headState === 'all'}
                    ref={(el) => { if (el) el.indeterminate = headState === 'some'; }}
                    onChange={() => setSelected((s) => toggleAllVisible(s, visibleKeys))}
                    disabled={visible.length === 0}
                  />
                </th>
              )}
              {columns.map((c) => {
                const sortable = !server && !!c.sortValue;
                const label = c.label ?? (typeof c.header === 'string' ? c.header : c.key);
                return (
                  <th key={c.key} scope="col"
                    {...(sortable ? { 'aria-sort': ariaSort(sort, c.key) } : {})}
                    className={`text-left px-4 py-2.5 font-medium text-gray-500 dark:text-gray-400 text-xs ${c.headerClassName ?? ''}`}>
                    {c.srOnlyHeader ? <span className="sr-only">{label}</span> : sortable ? (
                      <button type="button" onClick={() => setSort((s) => nextSort(s, c.key))}
                        className="inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-gray-200"
                        aria-label={`${label}: ${t('dt_sort')}`}>
                        {c.header}
                        {sort?.key === c.key
                          ? sort.dir === 'asc' ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />
                          : <ArrowUpDown size={11} className="opacity-40" aria-hidden="true" />}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {loading && (
              <tr><td colSpan={colCount} className="px-4 py-8 text-center">
                <Loader2 size={20} className="animate-spin mx-auto text-gray-400" aria-hidden="true" />
                <span className="sr-only">{t('dt_loading')}</span>
              </td></tr>
            )}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={colCount} className="py-10 text-center text-gray-400 text-sm">
                {emptyText ?? (query || search?.value ? t('dt_no_results') : t('dt_empty'))}
              </td></tr>
            )}
            {!loading && visible.map((row, i) => {
              const key = rowKey(row);
              const isActive = activeKey === key;
              const isSelected = selected.has(key);
              const expanded = renderExpanded?.(row);
              return [
                <tr
                  key={key}
                  ref={(el) => { rowRefs.current[i] = el; }}
                  tabIndex={i === tabbable ? 0 : -1}
                  aria-current={isActive ? 'true' : undefined}
                  onKeyDown={(e) => onRowKeyDown(e, row, i)}
                  onClick={(e) => onRowClick(e, row, i)}
                  onFocus={(e) => { if (e.target === e.currentTarget) setFocusIdx(i); }}
                  className={`outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent transition-colors ${
                    onActivate ? 'cursor-pointer' : ''} ${
                    isActive ? 'bg-blue-50 dark:bg-blue-900/20' : isSelected ? 'bg-blue-50/50 dark:bg-blue-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'} ${
                    rowClassName?.(row) ?? ''}`}
                >
                  {selectable && (
                    <td className="w-10 px-3 py-3">
                      <input type="checkbox" checked={isSelected}
                        aria-label={`${t('dt_select_row')} ${i + 1}`}
                        onChange={() => setSelected((s) => toggleSelected(s, key))} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={`px-4 py-3 ${c.className ?? ''}`}>{c.cell(row)}</td>
                  ))}
                </tr>,
                expanded ? (
                  <tr key={`${key}-expanded`}>
                    <td colSpan={colCount} className="px-6 py-4 bg-blue-50/30 dark:bg-gray-800/40">{expanded}</td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <nav className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400" aria-label={t('dt_pagination')}>
          <span aria-live="polite">{range.from}–{range.to} {t('dt_of')} {range.total}</span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-secondary px-2 py-1 disabled:opacity-40" disabled={currentPage <= 1}
                onClick={() => goPage(currentPage - 1)} aria-label={t('dt_prev_page')}>
                <ChevronLeft size={13} />
              </button>
              <span>{t('dt_page')} {currentPage} / {pages}</span>
              <button type="button" className="btn-secondary px-2 py-1 disabled:opacity-40" disabled={currentPage >= pages}
                onClick={() => goPage(currentPage + 1)} aria-label={t('dt_next_page')}>
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
