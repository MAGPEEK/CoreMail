/**
 * The client's view of the selected mailbox (RFC 9051 §2.3.1.2, §5.2, §7.4.1, §7.5.1).
 *
 * Message sequence numbers are NOT recomputed from the database per command:
 * every session keeps its own sequence map (SelectedMailbox.uids). Commands
 * address messages through that map; changes made elsewhere (delivery, other
 * clients, the web client) reach the client only as unsolicited responses:
 *
 *   - EXISTS after new messages were appended to the map,
 *   - FETCH (UID … FLAGS …) for messages whose modSeq changed,
 *   - EXPUNGE for messages that disappeared — and only where RFC 9051 §7.5.1
 *     allows it: never while no command is in progress, and never during
 *     FETCH, STORE or SEARCH (their UID variants may report expunges).
 *
 * Until an EXPUNGE has been sent the removed message keeps its sequence
 * number (a "ghost"): commands that address it find nothing and do nothing.
 */
import { prisma } from '@coremail/storage';
import { flagList } from '../fetch/imap-string.js';
import { type ImapSession, type SelectedMailbox, sendUntagged, sendOk } from './state.js';
import { chunkRanges, rangesOf } from './uid-set.js';

export interface ViewRow { uid: number; flags: string[]; modSeq: bigint }

/** Current non-expunged messages of a folder, ascending by UID. */
export async function loadViewRows(folderId: string): Promise<ViewRow[]> {
  return prisma.message.findMany({
    where: { folderId, deletedAt: null },
    select: { uid: true, flags: true, modSeq: true },
    orderBy: { uid: 'asc' },
  });
}

/**
 * Change stamp of a folder: its mailbox's highestModSeq (bumped by every
 * message-store write) and the folder's live message count (hard deletes).
 * null when the folder is gone (the full comparison then reports it).
 */
export async function syncStampOf(folderId: string): Promise<string | null> {
  const [folder, count] = await Promise.all([
    prisma.folder.findFirst({ where: { id: folderId }, select: { mailbox: { select: { highestModSeq: true } } } }),
    prisma.message.count({ where: { folderId, deletedAt: null } }),
  ]);
  if (!folder?.mailbox) return null;
  return `${folder.mailbox.highestModSeq}:${count}`;
}

/** Builds the view of a freshly selected mailbox. */
export function createView(
  folder: { id: string; name: string; uidValidity: number },
  rows: ViewRow[],
  readOnly: boolean,
  extra: Pick<SelectedMailbox, 'mailboxId' | 'foreign' | 'clientName' | 'delimiter' | 'noWrite' | 'access'> = {},
): SelectedMailbox {
  return {
    folderId: folder.id,
    folderName: folder.name,
    uidValidity: folder.uidValidity,
    readOnly,
    uids: rows.map((r) => r.uid),
    known: new Map(rows.map((r) => [r.uid, r.modSeq])),
    searchRes: [],
    ...extra,
  };
}

/** Index of the first element >= value in an ascending array. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sequence number of a UID in the view, or 0 when the UID is not part of it. */
export function seqOf(view: SelectedMailbox, uid: number): number {
  const i = lowerBound(view.uids, uid);
  return view.uids[i] === uid ? i + 1 : 0;
}

/** Highest UID in the view (value of "*" in a UID set), 0 for an empty mailbox. */
export function lastUid(view: SelectedMailbox): number {
  return view.uids[view.uids.length - 1] ?? 0;
}

const SEQ_SET = /^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/;

/** RFC 9051 §9 sequence-set, or "$" (SEARCHRES, RFC 5182 §2.1). */
export function isValidSequenceSet(set: string): boolean {
  return set === '$' || SEQ_SET.test(set);
}

/**
 * Resolves a sequence set against the view and returns the addressed UIDs
 * (ascending, unique). Sequence numbers and UIDs that are not part of the view
 * are ignored; "*" is the last message / the highest UID of the view; "$" is
 * the saved search result.
 */
export function resolveSet(view: SelectedMailbox, set: string, byUid: boolean): number[] {
  if (set === '$') {
    const inView = view.searchRes.filter((uid) => seqOf(view, uid) > 0);
    return [...new Set(inView)].sort((a, b) => a - b);
  }
  const uids = view.uids;
  if (uids.length === 0) return [];
  const result = new Set<number>();
  const max = byUid ? lastUid(view) : uids.length;
  for (const part of set.split(',')) {
    const [a, b] = part.split(':') as [string, string | undefined];
    const first = a === '*' ? max : Number(a);
    const second = b === undefined ? first : b === '*' ? max : Number(b);
    const lo = Math.min(first, second);
    const hi = Math.max(first, second);
    if (byUid) {
      for (let i = lowerBound(uids, lo); i < uids.length && (uids[i] as number) <= hi; i++) result.add(uids[i] as number);
    } else {
      for (let n = Math.max(lo, 1); n <= Math.min(hi, uids.length); n++) result.add(uids[n - 1] as number);
    }
  }
  return [...result].sort((x, y) => x - y);
}

/** Records the modSeq the client has just been told about (own STORE / FETCH). */
export function markReported(view: SelectedMailbox, uid: number, modSeq: bigint): void {
  if (view.known.has(uid)) view.known.set(uid, modSeq);
}

/**
 * Removes UIDs from the view and sends one EXPUNGE response per removed
 * message (ascending; every response renumbers the following messages).
 */
export function reportExpunged(session: ImapSession, view: SelectedMailbox, gone: Set<number>): void {
  if (gone.size === 0) return;
  const keep: number[] = [];
  const vanished: number[] = [];
  let removed = 0;
  for (const [i, uid] of view.uids.entries()) {
    if (gone.has(uid)) {
      // RFC 7162 §3.2.10: with QRESYNC enabled, VANISHED replaces EXPUNGE.
      if (session.qresyncEnabled) vanished.push(uid);
      else sendUntagged(session, `${i + 1 - removed} EXPUNGE`);
      removed++;
      view.known.delete(uid);
    } else {
      keep.push(uid);
    }
  }
  for (const set of chunkRanges(rangesOf(vanished))) sendUntagged(session, `VANISHED ${set}`);
  view.uids = keep;
  if (removed > 0) view.searchRes = view.searchRes.filter((uid) => !gone.has(uid));
}

export interface SyncOptions {
  /** EXPUNGE responses may be sent (false during FETCH, STORE and SEARCH). */
  expunge: boolean;
}

/**
 * Compares the view with the database and reports the differences as
 * unsolicited EXPUNGE / FETCH FLAGS / EXISTS responses.
 */
export async function syncView(session: ImapSession, opts: SyncOptions): Promise<void> {
  const view = session.selected;
  if (!view) return;
  // Cheap check first (IDLE polls every 30 s, every command ends with a sync):
  // every message change goes through the message store and bumps the
  // mailbox's highestModSeq; hard deletes change the count. Only when one of
  // them moved are all rows of the folder read and compared. The stamp is read
  // BEFORE the rows, so a change racing with the comparison triggers the next one.
  const stamp = await syncStampOf(view.folderId);
  if (stamp !== null && stamp === view.syncStamp) return;
  const rows = await loadViewRows(view.folderId);
  // The mailbox may have been closed while the query ran (IDLE push vs. logout).
  if (session.selected !== view || session.state === 'LOGOUT') return;

  const present = new Map(rows.map((r) => [r.uid, r]));
  const gone = new Set(view.uids.filter((uid) => !present.has(uid)));
  if (opts.expunge) reportExpunged(session, view, gone);
  // Withheld EXPUNGEs (FETCH/STORE/SEARCH) keep the stamp stale, so the next
  // sync that may send them compares again.
  view.syncStamp = opts.expunge || gone.size === 0 ? (stamp ?? undefined) : undefined;

  for (const [i, uid] of view.uids.entries()) {
    const row = present.get(uid);
    if (!row || view.known.get(uid) === row.modSeq) continue;
    view.known.set(uid, row.modSeq);
    const modSeq = session.condstoreEnabled ? ` MODSEQ (${row.modSeq})` : '';
    // RFC 9051 §7.5.2: an unsolicited FETCH response includes the UID.
    sendUntagged(session, `${i + 1} FETCH (UID ${uid} FLAGS ${flagList(row.flags)}${modSeq})`);
  }

  const fresh = rows.filter((r) => !view.known.has(r.uid) && seqOf(view, r.uid) === 0);
  if (fresh.length > 0) {
    for (const row of fresh) {
      view.uids.splice(lowerBound(view.uids, row.uid), 0, row.uid);
      view.known.set(row.uid, row.modSeq);
    }
    sendUntagged(session, `${view.uids.length} EXISTS`);
  }
}

/**
 * Sends the pending mailbox updates and the tagged OK of a command.
 * `expunge` follows RFC 9051 §7.5.1 (false for FETCH, STORE and SEARCH).
 */
export async function completeWithUpdates(
  session: ImapSession, tag: string, text: string, expunge = true, withHighestModSeq = false,
): Promise<void> {
  // RFC 7162 §3.2.10: after EXPUNGE / UID EXPUNGE / MOVE a QRESYNC client is told
  // the HIGHESTMODSEQ it is now synchronised to. It is read BEFORE the updates
  // are computed, so a change racing with them is reported again later.
  let prefix = '';
  if (withHighestModSeq && session.qresyncEnabled && session.selected) {
    const highest = await highestModSeqOf(session.selected.folderId);
    if (highest !== null) prefix = `[HIGHESTMODSEQ ${highest}] `;
  }
  if (session.selected) await syncView(session, { expunge });
  sendOk(session, tag, `${prefix}${text}`);
}

/** Current highestModSeq of the mailbox a folder belongs to (null: folder gone). */
export async function highestModSeqOf(folderId: string): Promise<bigint | null> {
  const folder = await prisma.folder.findFirst({ where: { id: folderId }, select: { mailbox: { select: { highestModSeq: true } } } });
  return folder?.mailbox?.highestModSeq ?? null;
}

/** Runs `fn` after all earlier queued update work of the session (IDLE push/poll vs. DONE). */
export function withUpdateLock(session: ImapSession, fn: () => Promise<void>): Promise<void> {
  const run = (session.updateLock ?? Promise.resolve()).then(fn, fn);
  session.updateLock = run.catch(() => undefined);
  return run;
}
