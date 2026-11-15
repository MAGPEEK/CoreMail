/**
 * Delta computation for Email/changes and Thread/changes (RFC 8620 §5.2) from the
 * state parts (see state.ts).
 *
 *  - Window: every row whose modSeq is newer than the old state. The message
 *    store gives each create/update/move/expunge a fresh modSeq, so the window
 *    holds exactly the rows touched since then (live rows and expunge tombstones).
 *  - created vs updated: Message.createdModSeq (set by the message store when the
 *    row appears in the mailbox) compared with the old state's creation base.
 *    Rows from before v7.1 have no createdModSeq and fall back to createdAt.
 *  - destroyed: soft-deleted rows (deletedAt) expunged inside the window that
 *    existed at the old state; created-and-destroyed rows are left out (SHOULD).
 *  - Hard deletes leave no trace. The count check (old + created − destroyed =
 *    now) catches them → cannotCalculateChanges, the client resyncs.
 *  - maxChanges / server limit: rows are paged in modSeq order, a page always ends
 *    on a modSeq boundary; the intermediate state carries the creation base so
 *    the next call still classifies against the original state.
 */
import { prisma } from '@coremail/storage';
import { MethodError, cannotCalculateChanges } from '../errors.js';
import type { EmailStateParts } from '../state.js';
import type { AccountContext } from '../types.js';

export interface Changes {
  created: string[];
  updated: string[];
  destroyed: string[];
  hasMoreChanges: boolean;
  /** State to return as newState (intermediate when hasMoreChanges). */
  newState: EmailStateParts;
}

/** Ids per /changes response when the client sets no (or a larger) maxChanges. */
export const CHANGES_SERVER_LIMIT = 5000;
/** Beyond this many touched rows the delta is not computed (cannotCalculateChanges). */
export const CHANGES_WINDOW_LIMIT = 50_000;

export interface WindowRow {
  id: string;
  modSeq: bigint;
  createdAt: Date;
  createdModSeq?: bigint | null;
  deletedAt: Date | null;
}

/** RFC 8620 §5.2: maxChanges is a positive UnsignedInt or null. */
export function parseMaxChanges(v: unknown): number {
  if (v === undefined || v === null) return CHANGES_SERVER_LIMIT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new MethodError('invalidArguments', 'maxChanges must be a positive integer');
  }
  return Math.min(v, CHANGES_SERVER_LIMIT);
}

/** Lower bound of the window: rows with a modSeq above it changed after `old`. */
export function windowFloor(old: EmailStateParts): bigint {
  return old.highestModSeq > old.maxModSeq ? old.highestModSeq : old.maxModSeq;
}

/** Did the row exist (in this mailbox) at the old state? */
export function existedAt(row: WindowRow, old: EmailStateParts): boolean {
  if (row.createdModSeq !== undefined && row.createdModSeq !== null) return row.createdModSeq <= old.createdBase;
  return row.createdAt.getTime() <= old.maxCreatedMs; // rows written before v7.1
}

/**
 * Pure part: classify the window rows and cut the page. `rows` must hold the
 * complete window (every row with modSeq above the old state).
 */
export function computeChanges(rows: WindowRow[], old: EmailStateParts, now: EmailStateParts, maxChanges: number): Changes {
  const floor = windowFloor(old);
  const ceiling = windowFloor(now); // rows written after `now` was read belong to the next call
  const sorted = rows
    .filter((r) => r.modSeq > floor && r.modSeq <= ceiling)
    .sort((a, b) => (a.modSeq < b.modSeq ? -1 : a.modSeq > b.modSeq ? 1 : a.id.localeCompare(b.id)));

  type Kind = 'created' | 'updated' | 'destroyed' | null;
  const kindOf = (r: WindowRow): Kind => {
    const before = existedAt(r, old);
    if (r.deletedAt) return before ? 'destroyed' : null;
    return before ? 'updated' : 'created';
  };
  const kinds = sorted.map(kindOf);
  const total = { created: 0, destroyed: 0 };
  for (const k of kinds) if (k === 'created' || k === 'destroyed') total[k]++;
  if (old.count + total.created - total.destroyed !== now.count) throw cannotCalculateChanges();

  const out: Changes = { created: [], updated: [], destroyed: [], hasMoreChanges: false, newState: now };
  let n = 0;
  let i = 0;
  while (i < sorted.length) {
    // one modSeq group at a time — an intermediate state can only sit between groups
    let j = i;
    while (j < sorted.length && sorted[j]!.modSeq === sorted[i]!.modSeq) j++;
    const groupIds = kinds.slice(i, j).filter((k) => k !== null).length;
    if (n + groupIds > maxChanges) {
      if (n === 0) throw cannotCalculateChanges(); // a single change set larger than maxChanges
      const boundary = sorted[i - 1]!.modSeq;
      out.hasMoreChanges = true;
      out.newState = {
        maxModSeq: boundary, highestModSeq: boundary, maxCreatedMs: old.maxCreatedMs,
        count: old.count + out.created.length - out.destroyed.length,
        createdBase: old.createdBase,
      };
      return out;
    }
    for (let k = i; k < j; k++) {
      const kind = kinds[k];
      if (kind) out[kind].push(sorted[k]!.id);
    }
    n += groupIds;
    i = j;
  }
  return out;
}

export async function changedMessageIds(
  account: AccountContext, old: EmailStateParts, now: EmailStateParts, maxChanges = CHANGES_SERVER_LIMIT,
): Promise<Changes> {
  if (old.maxModSeq === now.maxModSeq && old.highestModSeq === now.highestModSeq
    && old.maxCreatedMs === now.maxCreatedMs && old.count === now.count) {
    return { created: [], updated: [], destroyed: [], hasMoreChanges: false, newState: now };
  }
  const rows = await prisma.message.findMany({
    where: { folder: { mailboxId: account.mailboxId }, modSeq: { gt: windowFloor(old) } },
    select: { id: true, modSeq: true, createdAt: true, createdModSeq: true, deletedAt: true },
    orderBy: [{ modSeq: 'asc' }, { id: 'asc' }],
    take: CHANGES_WINDOW_LIMIT + 1,
  });
  if (rows.length > CHANGES_WINDOW_LIMIT) throw cannotCalculateChanges();
  return computeChanges(rows, old, now, maxChanges);
}
