/**
 * 9.4: "Namen prüfen" of the compose area — every recipient that is not yet a
 * "Name <address>" entry is looked up in the address book (own contacts and
 * the organisation's directory, `/contacts?q=`):
 *  - a valid address found there gets its display name,
 *  - a valid address not found stays as typed (external recipient),
 *  - a name or partial address ("bob") is replaced by the one matching entry;
 *    several or no matches leave it unresolved (marked in the field, and it
 *    still stops the send as an invalid address).
 * Pure — unit-tested with `node --test`.
 */
import { addEntries, formatRecipient, parseRecipient } from './recipients.ts';

export interface DirectoryEntry { displayName: string; email: string }

export type NameCheckResult =
  | { kind: 'known'; entry: string }
  | { kind: 'external'; entry: string }
  | { kind: 'resolved'; entry: string; from: string }
  | { kind: 'ambiguous'; entry: string; matches: number }
  | { kind: 'notFound'; entry: string };

export type UnresolvedReason = 'ambiguous' | 'notFound';

/** At most this many address book lookups per check (the rest stays as it is). */
export const MAX_NAME_CHECKS = 50;

/** An entry that needs a lookup: anything but "Name <valid address>". */
export function needsNameCheck(entry: string): boolean {
  const r = parseRecipient(entry);
  return !r.valid || !r.name;
}

/** Text to search the address book for: the address when valid, else what was typed. */
export function nameCheckQuery(entry: string): string {
  const r = parseRecipient(entry);
  if (r.valid) return r.address;
  return (r.name || r.address).replace(/[<>"]/g, '').trim();
}

const localPart = (email: string) => email.split('@')[0]!.toLowerCase();

function unique(list: readonly DirectoryEntry[]): DirectoryEntry[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = c.email.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Result of one entry against the address book entries found for its query. */
export function resolveRecipient(entry: string, found: readonly DirectoryEntry[]): NameCheckResult {
  const r = parseRecipient(entry);
  const candidates = unique(found);
  if (r.valid) {
    const match = candidates.find((c) => c.email.trim().toLowerCase() === r.address.toLowerCase());
    if (!match) return { kind: 'external', entry };
    if (r.name || !match.displayName.trim()) return { kind: 'known', entry };
    return { kind: 'resolved', entry: formatRecipient(match.displayName, match.email.trim()), from: entry };
  }
  const q = nameCheckQuery(entry).toLowerCase();
  if (!q) return { kind: 'notFound', entry };
  const exact = candidates.filter((c) =>
    c.displayName.trim().toLowerCase() === q || c.email.trim().toLowerCase() === q || localPart(c.email) === q);
  const pool = exact.length ? exact : candidates;
  if (pool.length === 1) return { kind: 'resolved', entry: formatRecipient(pool[0]!.displayName, pool[0]!.email.trim()), from: entry };
  return pool.length ? { kind: 'ambiguous', entry, matches: pool.length } : { kind: 'notFound', entry };
}

/** Entries after the check (resolved ones replaced, order kept, duplicates dropped) and the unresolved ones. */
export function applyNameCheck(results: readonly NameCheckResult[]): { entries: string[]; unresolved: Record<string, UnresolvedReason> } {
  const unresolved: Record<string, UnresolvedReason> = {};
  const entries = results.map((r) => {
    if (r.kind === 'ambiguous' || r.kind === 'notFound') unresolved[r.entry] = r.kind;
    return r.entry;
  });
  return { entries: addEntries([], entries), unresolved };
}
