/**
 * 9.4: sensitivity of a mail — chosen in compose ("…" → Nachrichtenoptionen),
 * stored by the server as the `Sensitivity` header, shown as a badge in the
 * reader for personal / private / confidential mail. Pure — unit-tested with
 * `node --test`.
 */

export type Sensitivity = 'normal' | 'personal' | 'private' | 'confidential';

/** Order of the "Vertraulichkeit" choice. */
export const SENSITIVITY_LEVELS: readonly Sensitivity[] = ['normal', 'personal', 'private', 'confidential'];

/** A value from the server (draft, message) as a level; anything unknown is normal. */
export function toSensitivity(value: unknown): Sensitivity {
  return value === 'personal' || value === 'private' || value === 'confidential' ? value : 'normal';
}

/** Badge of the reader: personal / private / confidential get one, normal none. */
export function sensitivityBadge(value: unknown): Exclude<Sensitivity, 'normal'> | null {
  const level = toSensitivity(value);
  return level === 'normal' ? null : level;
}
