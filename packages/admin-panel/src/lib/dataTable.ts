/**
 * DataTable logic (EAC-style list pages) — pure functions, no React, no
 * imports, unit-tested with node --test (dataTable.test.ts).
 *
 * Client-side mode: search → sort → paginate over the full row set.
 * Server-side mode: the API does search + paging; only `pageCount` /
 * `clampPage` are used here.
 */

export type SortDirection = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDirection }
export type SortValue = string | number | boolean | Date | null | undefined;

/** Normalises a search query: trimmed, lower case, split on whitespace. */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Rows whose searchable text contains EVERY term (case-insensitive).
 * `text(row)` returns the strings a row is searched by.
 */
export function filterRows<T>(rows: readonly T[], query: string, text: (row: T) => ReadonlyArray<string | null | undefined>): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const hay = text(row).filter((s): s is string => typeof s === 'string').join('\u0000').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Compares two sort values; null/undefined always sort last (in both directions). */
export function compareValues(a: SortValue, b: SortValue): number {
  const aNil = a === null || a === undefined || a === '';
  const bNil = b === null || b === undefined || b === '';
  if (aNil || bNil) return aNil === bNil ? 0 : aNil ? 1 : -1;
  if (a instanceof Date || b instanceof Date) return +new Date(a as Date) - +new Date(b as Date);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by `value(row)`; nil values stay at the end for asc and desc. */
export function sortRows<T>(rows: readonly T[], sort: SortState | null, value: ((row: T) => SortValue) | undefined): T[] {
  if (!sort || !value) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => {
      const xNil = x.v === null || x.v === undefined || x.v === '';
      const yNil = y.v === null || y.v === undefined || y.v === '';
      if (xNil || yNil) return xNil === yNil ? x.i - y.i : xNil ? 1 : -1;
      return sign * compareValues(x.v, y.v) || x.i - y.i;
    })
    .map((e) => e.row);
}

/** Header click: unsorted → asc → desc → asc …; another column starts at asc. */
export function nextSort(current: SortState | null, key: string): SortState {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/** aria-sort value of a column header. */
export function ariaSort(current: SortState | null, key: string): 'ascending' | 'descending' | 'none' {
  if (!current || current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** Keeps a 1-based page inside [1, pageCount]. */
export function clampPage(page: number, total: number, pageSize: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), pageCount(total, pageSize));
}

/** Rows of a 1-based page (page is clamped first). */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): T[] {
  const p = clampPage(page, rows.length, pageSize);
  return rows.slice((p - 1) * pageSize, p * pageSize);
}

/** "From–to of total" numbers for the pager label (from = 0 when empty). */
export function pageRange(page: number, pageSize: number, total: number): { from: number; to: number; total: number } {
  if (total <= 0) return { from: 0, to: 0, total: 0 };
  const p = clampPage(page, total, pageSize);
  return { from: (p - 1) * pageSize + 1, to: Math.min(total, p * pageSize), total };
}

/** Toggle one key in a selection (returns a new Set). */
export function toggleSelected(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** Header checkbox: select all visible keys, or clear them when all are already selected. */
export function toggleAllVisible(selected: ReadonlySet<string>, visibleKeys: readonly string[]): Set<string> {
  const next = new Set(selected);
  const all = visibleKeys.length > 0 && visibleKeys.every((k) => next.has(k));
  for (const k of visibleKeys) { if (all) next.delete(k); else next.add(k); }
  return next;
}

/** Header checkbox state for the visible keys. */
export function selectionState(selected: ReadonlySet<string>, visibleKeys: readonly string[]): 'none' | 'some' | 'all' {
  const n = visibleKeys.filter((k) => selected.has(k)).length;
  if (n === 0) return 'none';
  return n === visibleKeys.length ? 'all' : 'some';
}

/** Drops selected keys that are no longer present (after refresh / delete). */
export function pruneSelection(selected: ReadonlySet<string>, existingKeys: readonly string[]): Set<string> {
  const exist = new Set(existingKeys);
  return new Set([...selected].filter((k) => exist.has(k)));
}

/** Keyboard row navigation: new focused index for a key, or null when the key does not move focus. */
export function nextRowIndex(current: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  const cur = current < 0 ? -1 : Math.min(current, length - 1);
  switch (key) {
    case 'ArrowDown': return Math.min(length - 1, cur + 1);
    case 'ArrowUp':   return Math.max(0, cur < 0 ? 0 : cur - 1);
    case 'Home':      return 0;
    case 'End':       return length - 1;
    case 'PageDown':  return Math.min(length - 1, Math.max(0, cur) + 10);
    case 'PageUp':    return Math.max(0, cur - 10);
    default:          return null;
  }
}
