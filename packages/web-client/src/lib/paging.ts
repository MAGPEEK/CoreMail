/**
 * Offset paging helpers for list endpoints that answer
 * `{ messages, total, limit, offset }` (mail folder list + mail search).
 *
 * Pure functions (no imports) so they can be unit-tested with `node --test`.
 */

export const MESSAGE_PAGE_SIZE = 50;

export interface OffsetPage<T> {
  messages: T[];
  total: number;
  limit?: number;
  offset?: number;
}

/**
 * Returns the offset of the next page, or `undefined` when everything is loaded.
 * Used as TanStack Query `getNextPageParam`.
 */
export function nextPageOffset<T>(lastPage: OffsetPage<T>, allPages: OffsetPage<T>[]): number | undefined {
  const loaded = allPages.reduce((n, p) => n + p.messages.length, 0);
  // An empty page means the server has nothing more, even if `total` says otherwise
  // (messages may have been deleted/moved between page requests).
  if (lastPage.messages.length === 0) return undefined;
  if (loaded >= lastPage.total) return undefined;
  return loaded;
}

/**
 * Flattens all loaded pages into one list. Duplicates (a message that shifted
 * from page n to n+1 because new mail arrived in between) are dropped.
 */
export function flattenPages<T extends { id: string }>(pages: OffsetPage<T>[] | undefined): T[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const m of page.messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** Builds the query string for a page request. */
export function pageQuery(offset: number, limit: number = MESSAGE_PAGE_SIZE): string {
  return `limit=${limit}&offset=${offset}`;
}
