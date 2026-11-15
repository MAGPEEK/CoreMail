/**
 * ActiveSync Sync delta selection based on the mailbox modSeq counter.
 *
 * SyncKey semantics: a key `k` (decimal) means "the client has seen every change
 * with modSeq < k". The server answers with the messages whose modSeq lies in
 * [k, upper) and the new key `upper`, where `upper = Mailbox.highestModSeq + 1`
 * read BEFORE the message query — a change committed after that read has a
 * modSeq ≥ upper and is delivered with the next Sync, never skipped.
 *
 * Before v6.x the key was `Date.now()` while SMTP/IMAP/JMAP wrote small counter
 * modSeqs, so `modSeq > key` never matched and incremental sync delivered nothing.
 * Keys that are not decimal or lie beyond the current counter (e.g. old Date.now()
 * keys) are reported as invalid → Status 3, the client restarts with SyncKey 0.
 *
 * No runtime imports: the caller passes the Prisma client (or a fake).
 */

import type { EasMessage } from './body.js';

export const SYNC_WINDOW_SIZE = 25;
/** Upper bound for a client-supplied airsync:WindowSize. */
export const MAX_WINDOW_SIZE = 512;

/** Message columns of a Sync window row (attachments are loaded separately). */
export type SyncMessageRow = Omit<EasMessage, 'attachments'> & { modSeq: bigint };

export interface SyncWindowDb {
  mailbox: {
    findUnique(args: { where: { id: string }; select: { highestModSeq: true } }): Promise<{ highestModSeq: bigint } | null>;
  };
  message: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
      select: Record<string, true>;
    }): Promise<SyncMessageRow[]>;
  };
}

/**
 * [MS-ASCMD] 2.2.3.166.4: a Sync with SyncKey 0 only primes the sync state — the
 * response carries a new SyncKey and NO Commands; clients fetch the items with the
 * next Sync (and drop items sent in the priming response). The priming key is the
 * lowest modSeq bound (message modSeqs start at 1), so that next Sync returns the
 * whole folder.
 */
export const PRIMING_SYNC_KEY = '1';
export function isPrimingSyncKey(key: string | undefined): boolean {
  return key === undefined || key === '' || key === '0';
}

export type ParsedSyncKey = { kind: 'delta'; since: bigint } | { kind: 'invalid' };

/** `'0'`/empty = initial sync (everything); otherwise the lower modSeq bound. */
export function parseSyncKey(key: string | undefined, upper: bigint): ParsedSyncKey {
  if (key === undefined || key === '' || key === '0') return { kind: 'delta', since: 0n };
  if (!/^\d{1,20}$/.test(key)) return { kind: 'invalid' };
  const since = BigInt(key);
  if (since > upper) return { kind: 'invalid' };
  return { kind: 'delta', since };
}

const SELECT = {
  id: true, modSeq: true, flags: true, subject: true, fromAddr: true, fromName: true,
  toAddrs: true, ccAddrs: true, replyTo: true, messageId: true, inReplyTo: true, threadId: true,
  date: true, bodyText: true, bodyHtml: true, storagePath: true, smimeMeta: true,
} as const;

/** airsync:WindowSize → window size (default SYNC_WINDOW_SIZE, capped at MAX_WINDOW_SIZE). */
export function parseWindowSize(s: string | undefined): number {
  if (!s || !/^\d{1,6}$/.test(s)) return SYNC_WINDOW_SIZE;
  const n = Number(s);
  return n < 1 ? SYNC_WINDOW_SIZE : Math.min(n, MAX_WINDOW_SIZE);
}

export interface SyncEstimateDb {
  mailbox: SyncWindowDb['mailbox'];
  message: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

export type SyncEstimate = { status: 'ok'; estimate: number } | { status: 'invalid' } | { status: 'not-primed' };

/**
 * [MS-ASCMD] GetItemEstimate: number of items the next Sync(s) with `clientSyncKey`
 * would deliver — the same modSeq range [key, upper) as loadSyncWindow, over all
 * windows (no WindowSize cut). SyncKey 0/empty → not primed (Status 3).
 */
export async function estimateSyncWindow(
  db: SyncEstimateDb,
  opts: { mailboxId: string; folderId: string; clientSyncKey: string | undefined },
): Promise<SyncEstimate> {
  if (isPrimingSyncKey(opts.clientSyncKey)) return { status: 'not-primed' };
  const mbx = await db.mailbox.findUnique({ where: { id: opts.mailboxId }, select: { highestModSeq: true } });
  const upper = (mbx?.highestModSeq ?? 0n) + 1n;
  const key = parseSyncKey(opts.clientSyncKey, upper);
  if (key.kind === 'invalid') return { status: 'invalid' };
  const estimate = await db.message.count({
    where: { folderId: opts.folderId, deletedAt: null, modSeq: { gte: key.since, lt: upper } },
  });
  return { status: 'ok', estimate };
}

export type SyncWindow =
  | { status: 'ok'; messages: SyncMessageRow[]; newSyncKey: string; moreAvailable: boolean }
  | { status: 'invalid' };

/**
 * Messages of `folderId` changed since `clientSyncKey`, oldest change first, at most
 * `windowSize` (all messages sharing the boundary modSeq stay together).
 */
export async function loadSyncWindow(
  db: SyncWindowDb,
  opts: { mailboxId: string; folderId: string; clientSyncKey: string | undefined; windowSize?: number },
): Promise<SyncWindow> {
  const windowSize = opts.windowSize ?? SYNC_WINDOW_SIZE;
  const mbx = await db.mailbox.findUnique({ where: { id: opts.mailboxId }, select: { highestModSeq: true } });
  const upper = (mbx?.highestModSeq ?? 0n) + 1n;
  const key = parseSyncKey(opts.clientSyncKey, upper);
  if (key.kind === 'invalid') return { status: 'invalid' };

  const base = { folderId: opts.folderId, deletedAt: null };
  const rows = await db.message.findMany({
    where: { ...base, modSeq: { gte: key.since, lt: upper } },
    orderBy: [{ modSeq: 'asc' }, { id: 'asc' }],
    take: windowSize + 1,
    select: SELECT,
  });
  if (rows.length <= windowSize) {
    return { status: 'ok', messages: rows, newSyncKey: upper.toString(), moreAvailable: false };
  }

  // More than one window: cut before the first modSeq that does not fit completely.
  const boundary = rows[windowSize]!.modSeq;
  const page = rows.filter((r) => r.modSeq < boundary);
  if (page.length > 0) {
    return { status: 'ok', messages: page, newSyncKey: boundary.toString(), moreAvailable: true };
  }
  // Every row of the window shares one modSeq → deliver that whole group.
  const group = await db.message.findMany({
    where: { ...base, modSeq: boundary },
    orderBy: [{ id: 'asc' }],
    select: SELECT,
  });
  return { status: 'ok', messages: group, newSyncKey: (boundary + 1n).toString(), moreAvailable: boundary + 1n < upper };
}
