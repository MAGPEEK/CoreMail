/**
 * 10.2: "Letzte Suchen" of the mail search fields — the last 5 search terms of a
 * user, newest first, in this browser only (localStorage, one key per user). Every
 * storage access is wrapped: private windows, blocked site data or a full quota
 * leave the list empty instead of breaking the search field.
 * No imports — unit-tested with `node --test`.
 */

export const RECENT_SEARCH_LIMIT = 5;
export const RECENT_SEARCH_MAX_LENGTH = 200;
const KEY_PREFIX = 'coremail:recent-searches:';

/** The part of `Storage` the list needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function recentSearchKey(userKey: string): string {
  return `${KEY_PREFIX}${userKey}`;
}

/** Tolerant read of a stored list (anything unexpected → the valid part / empty). */
export function parseRecentSearches(raw: string | null): string[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  let list: string[] = [];
  for (const v of value.reverse()) if (typeof v === 'string') list = addRecentSearch(list, v);
  return list;
}

/**
 * The list with `term` on top: trimmed, blank or over-long terms ignored, an
 * existing entry (case-insensitive) moved instead of duplicated, at most 5.
 */
export function addRecentSearch(list: readonly string[], term: string): string[] {
  const t = term.replace(/\s+/g, ' ').trim();
  if (!t || t.length > RECENT_SEARCH_MAX_LENGTH) return [...list];
  const key = t.toLowerCase();
  return [t, ...list.filter((s) => s.toLowerCase() !== key)].slice(0, RECENT_SEARCH_LIMIT);
}

export function removeRecentSearch(list: readonly string[], term: string): string[] {
  const key = term.toLowerCase();
  return list.filter((s) => s.toLowerCase() !== key);
}

/** window.localStorage, or null when the browser refuses access. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadRecentSearches(storage: StorageLike | null, userKey: string | null): string[] {
  if (!storage || !userKey) return [];
  try {
    return parseRecentSearches(storage.getItem(recentSearchKey(userKey)));
  } catch {
    return [];
  }
}

/** Saves the list; false when the browser refused (the list then lives for this page only). */
export function saveRecentSearches(storage: StorageLike | null, userKey: string | null, list: readonly string[]): boolean {
  if (!storage || !userKey) return false;
  try {
    storage.setItem(recentSearchKey(userKey), JSON.stringify(list.slice(0, RECENT_SEARCH_LIMIT)));
    return true;
  } catch {
    return false;
  }
}
