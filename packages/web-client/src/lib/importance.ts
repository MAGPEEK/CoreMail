/**
 * 9.4: importance of a mail — chosen in compose ("…" → Wichtigkeit), stored by
 * the server as Importance / X-Priority headers, shown as a badge in the
 * reader. Pure — unit-tested with `node --test`.
 */

export type Importance = 'high' | 'normal' | 'low';

/** Menu order of "Wichtigkeit". */
export const IMPORTANCE_LEVELS: readonly Importance[] = ['high', 'normal', 'low'];

/** A value from the server (draft, message) as a level; anything unknown is normal. */
export function toImportance(value: unknown): Importance {
  return value === 'high' || value === 'low' ? value : 'normal';
}

/** Badge of the reader: high / low get one, normal none. */
export function importanceBadge(value: unknown): 'high' | 'low' | null {
  const level = toImportance(value);
  return level === 'normal' ? null : level;
}
