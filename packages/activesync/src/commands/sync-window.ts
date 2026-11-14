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

export const SYNC_WINDOW_SIZE = 25;

export interface SyncMessageRow {
  id: string;
  modSeq: bigint;
  flags: string[];
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  date: Date;
  bodyText: string;
  bodyHtml: string;
}

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
  id: true, modSeq: true, flags: true, subject: true,
  fromAddr: true, toAddrs: true, date: true, bodyText: true, bodyHtml: true,
} as const;

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
