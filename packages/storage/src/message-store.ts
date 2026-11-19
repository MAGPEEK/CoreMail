/**
 * message-store — the single place where message UIDs and modSeqs are allocated.
 *
 * Every writer (SMTP delivery, IMAP, JMAP, ActiveSync, REST, restore,
 * retention, mail rules) must go through these primitives inside a Prisma
 * transaction, so that:
 *
 *   - UIDs come from `Mailbox.uidNext` (one counter per mailbox, unique per folder
 *     via @@unique([folderId, uid])) and are never derived from a value read earlier;
 *   - every change (create, flag change, move, copy, expunge, other metadata) gets
 *     `message.modSeq = ++Mailbox.highestModSeq`, so HIGHESTMODSEQ (CONDSTORE),
 *     the JMAP Email state and the ActiveSync sync key all see it;
 *   - a moved message gets a new UID in the target folder (RFC 6851 §4.3).
 *
 * The allocation is one `UPDATE mailboxes SET "uidNext" = "uidNext" + n,
 * "highestModSeq" = "highestModSeq" + 1 … RETURNING` (Prisma `update` with
 * `increment`). It takes the mailbox row lock until the transaction commits, so
 * concurrent writers of the same mailbox are serialized and modSeqs become
 * visible in allocation order.
 *
 * This module only talks to the transaction client it is given (also makes it
 * trivial to fake in tests); its runtime imports are the pure references.ts and
 * the realtime change scope.
 *
 * Realtime (9.4): every write records a mailbox change (realtime/change-scope.ts);
 * it is published on `mailbox:changes` once the surrounding transaction
 * committed, so the webmail, IMAP IDLE and JMAP push of every writer — SMTP,
 * IMAP, JMAP, ActiveSync, REST, restore, retention — see it without polling.
 *
 * References (v9.1): a row created without `references` but with a
 * `storagePath` gets the References of that raw object when this process stored
 * it (references.ts cache, filled by storeRawMessage). Otherwise the column stays
 * null and the backfill (references-backfill.ts) fills it later.
 *
 * Migration: rows written before v6.x may carry `Date.now()`-sized modSeqs and
 * (internal-notify) UIDs ≥ uidNext. The first allocation per mailbox and process
 * raises the counters to max(message.modSeq) / max(message.uid) + 1, see
 * {@link ensureCounterFloor} and {@link migrateMailboxCounters}.
 */
import type { Prisma, Message } from '@prisma/client';
import type { MailboxChangeKind } from '@coremail/core/realtime';
import { cachedReferencesColumn } from './references.js';
import { recordMailboxChange } from './realtime/change-scope.js';
import {
  flagsForFollowUp, followUpAfterKeywords, followUpBulkAfterKeywords, followUpColumns, followUpForNewRow, normalizeFollowUp,
  type FollowUpState, type FollowUpStatus,
} from './follow-up.js';

/** Records a change for post-commit publishing (folders: undefined = unknown). */
function noteChange(mailboxId: string, kind: MailboxChangeKind, modSeq: bigint, folderIds?: Iterable<string>): void {
  const folders = folderIds ? [...new Set(folderIds)] : [];
  recordMailboxChange({ mailboxId, kinds: [kind], modSeq: modSeq.toString(), ...(folders.length ? { folderIds: folders } : {}) });
}

/** Interactive transaction client (or the root client for single-statement use). */
export type MessageStoreTx = Prisma.TransactionClient;

export interface Allocation {
  /** First UID of the reserved block (`count` consecutive UIDs). */
  firstUid: number;
  /** The modSeq every row written under this allocation receives. */
  modSeq: bigint;
}

/** Mailboxes whose counters were already checked against legacy rows in this process. */
const verifiedMailboxes = new Set<string>();

/** Test helper: forget which mailboxes were verified. */
export function resetMessageStoreCache(): void {
  verifiedMailboxes.clear();
}

/**
 * One-time (per process and mailbox) floor check: highestModSeq ≥ max(message.modSeq)
 * and uidNext > max(message.uid). Monotonic, so concurrent callers are harmless.
 */
export async function ensureCounterFloor(tx: MessageStoreTx, mailboxId: string): Promise<void> {
  if (verifiedMailboxes.has(mailboxId)) return;
  const agg = await tx.message.aggregate({
    where: { folder: { mailboxId } },
    _max: { modSeq: true, uid: true },
  });
  const maxModSeq = agg._max.modSeq ?? 0n;
  const maxUid = agg._max.uid ?? 0;
  if (maxModSeq > 0n) {
    await tx.mailbox.updateMany({
      where: { id: mailboxId, highestModSeq: { lt: maxModSeq } },
      data: { highestModSeq: maxModSeq },
    });
  }
  if (maxUid > 0) {
    await tx.mailbox.updateMany({
      where: { id: mailboxId, uidNext: { lte: maxUid } },
      data: { uidNext: maxUid + 1 },
    });
  }
  verifiedMailboxes.add(mailboxId);
}

/**
 * Reserve `count` UIDs and one new modSeq in a single atomic statement.
 * `count = 0` only bumps the modSeq.
 */
export async function allocate(tx: MessageStoreTx, mailboxId: string, count = 1): Promise<Allocation> {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`allocate: invalid count ${count}`);
  await ensureCounterFloor(tx, mailboxId);
  const mbx = await tx.mailbox.update({
    where: { id: mailboxId },
    data: {
      ...(count > 0 ? { uidNext: { increment: count } } : {}),
      highestModSeq: { increment: 1 },
    },
    select: { uidNext: true, highestModSeq: true },
  });
  return { firstUid: mbx.uidNext - count, modSeq: mbx.highestModSeq };
}

/** New modSeq for a change that does not need a UID. */
export async function nextModSeq(tx: MessageStoreTx, mailboxId: string): Promise<bigint> {
  return (await allocate(tx, mailboxId, 0)).modSeq;
}

/** Fields a writer supplies for a new message (uid/modSeq/folderId are assigned here). */
export type NewMessageData = Omit<Prisma.MessageUncheckedCreateInput, 'uid' | 'modSeq' | 'folderId'>;

/** Create several messages in one folder with consecutive UIDs and one modSeq. */
export async function createMessages(
  tx: MessageStoreTx,
  mailboxId: string,
  folderId: string,
  rows: NewMessageData[],
): Promise<Message[]> {
  if (rows.length === 0) return [];
  const { firstUid, modSeq } = await allocate(tx, mailboxId, rows.length);
  const created: Message[] = [];
  for (const [i, data] of rows.entries()) {
    const refs = data.references === undefined && typeof data.storagePath === 'string'
      ? cachedReferencesColumn(data.storagePath)
      : undefined;
    created.push(await tx.message.create({
      data: {
        changeKey: modSeq.toString(),
        ...(refs !== undefined ? { references: refs } : {}),
        ...followUpForNewRow(data),
        ...data, folderId, uid: firstUid + i, modSeq, createdModSeq: modSeq,
      },
    }));
  }
  noteChange(mailboxId, 'messages', modSeq, [folderId]);
  return created;
}

/** Create one message. */
export async function createMessage(
  tx: MessageStoreTx,
  mailboxId: string,
  folderId: string,
  data: NewMessageData,
): Promise<Message> {
  const [msg] = await createMessages(tx, mailboxId, folderId, [data]);
  return msg!;
}

interface ScopeOpts {
  /** Mailbox of all given messages, when the caller knows it (skips a lookup). */
  mailboxId?: string;
}

interface MailboxGroup {
  ids: string[];
  /** Folders of the messages, when known (looked up, or fixed by the caller's `where`). */
  folderIds?: Set<string>;
}

/** Group message ids by their mailbox (one lookup unless the caller passes mailboxId). */
async function byMailbox(
  tx: MessageStoreTx,
  ids: string[],
  opts: ScopeOpts,
  where?: Omit<Prisma.MessageWhereInput, 'id'>,
): Promise<Map<string, MailboxGroup>> {
  const out = new Map<string, MailboxGroup>();
  if (ids.length === 0) return out;
  if (opts.mailboxId) {
    const fixedFolder = typeof where?.folderId === 'string' ? where.folderId : null;
    out.set(opts.mailboxId, { ids: [...ids], ...(fixedFolder ? { folderIds: new Set([fixedFolder]) } : {}) });
    return out;
  }
  const rows = await tx.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, folderId: true, folder: { select: { mailboxId: true } } },
  });
  for (const r of rows) {
    const group = out.get(r.folder.mailboxId) ?? { ids: [], folderIds: new Set<string>() };
    group.ids.push(r.id);
    group.folderIds?.add(r.folderId);
    out.set(r.folder.mailboxId, group);
  }
  return out;
}

interface TouchOpts extends ScopeOpts {
  /**
   * Extra conditions every row must still meet when the statement runs
   * (e.g. `{ folderId, deletedAt: null }`): rows that no longer match — moved to
   * another folder or already deleted by a concurrent writer — are left alone.
   * The check and the update are one `UPDATE … WHERE`, so it is atomic.
   */
  where?: Omit<Prisma.MessageWhereInput, 'id'>;
}

/**
 * Apply `data` to the given messages and give them a fresh modSeq (one per mailbox).
 * Use for any metadata change (pin, snooze, retention tag, read flag via a fixed list, …).
 * Returns the modSeq per mailbox.
 */
export async function touchMessages(
  tx: MessageStoreTx,
  ids: string[],
  data: Omit<Prisma.MessageUncheckedUpdateManyInput, 'uid' | 'modSeq' | 'folderId'> = {},
  opts: TouchOpts = {},
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  // 9.4: a keyword list keeps the follow-up flag in step (one extra statement, no reads)
  const followUp = Array.isArray(data.flags) ? followUpBulkAfterKeywords(data.flags as string[]) : null;
  for (const [mailboxId, group] of await byMailbox(tx, ids, opts, opts.where)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    if (followUp) {
      await tx.message.updateMany({
        where: { ...(opts.where ?? {}), id: { in: group.ids }, flagStatus: followUp.from },
        data: followUp.data,
      });
    }
    await tx.message.updateMany({
      where: { ...(opts.where ?? {}), id: { in: group.ids } },
      data: { ...data, modSeq, changeKey: modSeq.toString() },
    });
    result.set(mailboxId, modSeq);
    noteChange(mailboxId, 'messages', modSeq, group.folderIds);
  }
  return result;
}

/** Set (replace) the flags of individual messages; all get the same new modSeq. */
export async function setFlags(
  tx: MessageStoreTx,
  updates: Array<{ id: string; flags: string[] }>,
  opts: ScopeOpts = {},
): Promise<Array<{ id: string; flags: string[]; modSeq: bigint }>> {
  const flagsById = new Map(updates.map((u) => [u.id, u.flags]));
  const out: Array<{ id: string; flags: string[]; modSeq: bigint }> = [];
  for (const [mailboxId, group] of await byMailbox(tx, [...flagsById.keys()], opts)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    const before = new Map((await tx.message.findMany({
      where: { id: { in: group.ids } },
      select: { id: true, flags: true, flagStatus: true },
    })).map((r) => [r.id, r]));
    for (const id of group.ids) {
      const flags = flagsById.get(id)!;
      const prev = before.get(id);
      const followUp = prev ? followUpAfterKeywords(prev, flags) : null;
      await tx.message.update({ where: { id }, data: { flags, ...(followUp ?? {}), modSeq, changeKey: modSeq.toString() } });
      out.push({ id, flags, modSeq });
    }
    noteChange(mailboxId, 'flags', modSeq, group.folderIds);
  }
  return out;
}

/**
 * Read-modify-write of flags without lost updates: the mailbox row lock is
 * taken first (modSeq allocation), THEN the current flags are read, so two
 * concurrent "+FLAGS" on the same message are serialized and both survive.
 * `compute` returns the new flag list, or null to leave the message unchanged
 * (also gets the current modSeq, e.g. for CONDSTORE UNCHANGEDSINCE).
 * Returns the rows that were written. A modSeq is allocated even when nothing
 * changes in the end (gaps are allowed, RFC 7162 §3.1).
 */
export async function modifyFlags(
  tx: MessageStoreTx,
  ids: string[],
  compute: (flags: string[], modSeq: bigint, id: string) => string[] | null,
  opts: ScopeOpts = {},
): Promise<Array<{ id: string; flags: string[]; modSeq: bigint }>> {
  const out: Array<{ id: string; flags: string[]; modSeq: bigint }> = [];
  for (const [mailboxId, group] of await byMailbox(tx, ids, opts)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    const rows = await tx.message.findMany({
      where: { id: { in: group.ids } },
      select: { id: true, flags: true, modSeq: true, folderId: true, flagStatus: true },
    });
    const changedFolders = new Set<string>();
    for (const row of rows) {
      const flags = compute([...row.flags], row.modSeq, row.id);
      if (flags === null) continue;
      const followUp = followUpAfterKeywords(row, flags);
      await tx.message.update({ where: { id: row.id }, data: { flags, ...(followUp ?? {}), modSeq, changeKey: modSeq.toString() } });
      out.push({ id: row.id, flags, modSeq });
      changedFolders.add(row.folderId);
    }
    if (changedFolders.size > 0) noteChange(mailboxId, 'flags', modSeq, changedFolders);
  }
  return out;
}

/**
 * 9.4: set the follow-up flag of messages (REST "Kennzeichnen", EAS email:Flag).
 * The `\Flagged` keyword follows the status (see follow-up.ts) and every row gets
 * the mailbox's next modSeq, so IMAP CONDSTORE, JMAP and EAS see the change.
 * Dates left out of `state` keep their stored value (null clears one); the result is
 * normalised (dates of 'none' dropped, completion time for 'complete').
 */
export async function setFollowUp(
  tx: MessageStoreTx,
  ids: string[],
  state: Partial<FollowUpState> & { status: FollowUpStatus },
  opts: TouchOpts & { now?: Date } = {},
): Promise<Array<{ id: string; flags: string[]; modSeq: bigint }>> {
  const now = opts.now ?? new Date();
  const out: Array<{ id: string; flags: string[]; modSeq: bigint }> = [];
  for (const [mailboxId, group] of await byMailbox(tx, ids, opts, opts.where)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    const rows = await tx.message.findMany({
      where: { ...(opts.where ?? {}), id: { in: group.ids } },
      select: { id: true, flags: true, folderId: true, flagStartAt: true, flagDueAt: true, flagReminderAt: true, flagCompletedAt: true },
    });
    for (const row of rows) {
      const columns = followUpColumns(normalizeFollowUp({
        status: state.status,
        startAt: state.startAt !== undefined ? state.startAt : row.flagStartAt,
        dueAt: state.dueAt !== undefined ? state.dueAt : row.flagDueAt,
        reminderAt: state.reminderAt !== undefined ? state.reminderAt : row.flagReminderAt,
        completedAt: state.completedAt !== undefined ? state.completedAt : row.flagCompletedAt,
      }, now));
      const flags = flagsForFollowUp(row.flags, columns.flagStatus);
      await tx.message.update({ where: { id: row.id }, data: { flags, ...columns, modSeq, changeKey: modSeq.toString() } });
      out.push({ id: row.id, flags, modSeq });
    }
    if (rows.length > 0) noteChange(mailboxId, 'flags', modSeq, rows.map((r) => r.folderId));
  }
  return out;
}

/** Soft-delete (expunge) messages; the change is visible as a modSeq bump. */
export async function expunge(
  tx: MessageStoreTx,
  ids: string[],
  opts: TouchOpts & { deletedAt?: Date } = {},
): Promise<Map<string, bigint>> {
  return touchMessages(tx, ids, { deletedAt: opts.deletedAt ?? new Date() }, opts);
}

export interface MoveOpts {
  /** Mailbox of the target folder (looked up if omitted). */
  targetMailboxId?: string;
  /** Mailbox of all source messages (looked up if omitted). */
  sourceMailboxId?: string;
  /** Additional fields to set on the moved rows (e.g. spamScore, deletedAt: null). */
  data?: Omit<Prisma.MessageUncheckedUpdateInput, 'uid' | 'modSeq' | 'folderId'>;
}

export interface UidMapping { id: string; oldUid: number; newUid: number }

/**
 * Move/restore bookkeeping: the target mailbox changed in the target folder and
 * in the source folders it owns; every other source mailbox gets a modSeq bump
 * and its own change.
 */
async function noteRelocation(
  tx: MessageStoreTx,
  targetMailboxId: string,
  targetFolderId: string,
  modSeq: bigint,
  mailboxByFolder: Map<string, string>,
): Promise<void> {
  const foldersOf = (mailboxId: string) =>
    [...mailboxByFolder].filter(([, mbx]) => mbx === mailboxId).map(([folderId]) => folderId);
  noteChange(targetMailboxId, 'messages', modSeq, [targetFolderId, ...foldersOf(targetMailboxId)]);
  for (const mbx of new Set(mailboxByFolder.values())) {
    if (mbx !== targetMailboxId) noteChange(mbx, 'messages', await nextModSeq(tx, mbx), foldersOf(mbx));
  }
}

async function mailboxOfFolder(tx: MessageStoreTx, folderId: string): Promise<string> {
  const f = await tx.folder.findUnique({ where: { id: folderId }, select: { mailboxId: true } });
  if (!f) throw new Error(`message-store: folder ${folderId} not found`);
  return f.mailboxId;
}

/**
 * Move messages into `targetFolderId`. The rows keep their id (JMAP ids stay
 * stable) but receive new UIDs from the target mailbox and a new modSeq
 * (RFC 6851 §4.3: the moved message is a new message in the target). Messages
 * already in the target folder are left alone. The source mailbox gets a modSeq
 * bump too when it differs from the target mailbox.
 * Mapping order = ascending source UID (COPYUID order).
 */
export async function moveMessages(
  tx: MessageStoreTx,
  ids: string[],
  targetFolderId: string,
  opts: MoveOpts = {},
): Promise<{ mapping: UidMapping[]; modSeq: bigint | null }> {
  if (ids.length === 0) return { mapping: [], modSeq: null };
  const src = await tx.message.findMany({
    where: { id: { in: ids }, NOT: { folderId: targetFolderId } },
    select: { id: true, uid: true, folderId: true, flags: true, flagStatus: true },
    orderBy: [{ uid: 'asc' }],
  });
  // 9.4: new keywords with the move (JMAP, REST, mail rules) keep the follow-up flag in step
  const newFlags = Array.isArray(opts.data?.flags) ? opts.data.flags as string[] : null;
  if (src.length === 0) return { mapping: [], modSeq: null };
  const targetMailboxId = opts.targetMailboxId ?? await mailboxOfFolder(tx, targetFolderId);
  const { firstUid, modSeq } = await allocate(tx, targetMailboxId, src.length);
  const mailboxByFolder = new Map<string, string>();
  for (const folderId of new Set(src.map((m) => m.folderId))) {
    mailboxByFolder.set(folderId, opts.sourceMailboxId ?? await mailboxOfFolder(tx, folderId));
  }
  const mapping: UidMapping[] = [];
  for (const [i, m] of src.entries()) {
    const newUid = firstUid + i;
    // Entering another mailbox is a creation from the target mailbox's point of view.
    const crossMailbox = mailboxByFolder.get(m.folderId) !== targetMailboxId;
    const followUp = newFlags ? followUpAfterKeywords(m, newFlags) : null;
    await tx.message.update({
      where: { id: m.id },
      data: {
        // w3: the creator claim ("own items" of folder permissions) never travels to another mailbox
        ...(followUp ?? {}), ...(crossMailbox ? { createdBy: null } : {}), ...(opts.data ?? {}),
        folderId: targetFolderId, uid: newUid, modSeq, changeKey: modSeq.toString(),
        ...(crossMailbox ? { createdModSeq: modSeq } : {}),
      },
    });
    mapping.push({ id: m.id, oldUid: m.uid, newUid });
  }
  await noteRelocation(tx, targetMailboxId, targetFolderId, modSeq, mailboxByFolder);
  return { mapping, modSeq };
}

/**
 * Bring deleted rows back (v8.1 "Recover deleted items"): expunge tombstones
 * (deletedAt) or retention soft-deletes (softDeletedAt) become live messages in
 * `targetFolderId` again. Like a move they get NEW UIDs from the target mailbox
 * (the old UID was reported as expunged and is never reused), one new modSeq and
 * createdModSeq = modSeq, so IMAP (CONDSTORE/QRESYNC), JMAP Email/changes and the
 * ActiveSync sync see them as new messages. The source mailbox gets a modSeq bump
 * when it differs. Mapping order = ascending old UID.
 */
export async function restoreMessages(
  tx: MessageStoreTx,
  ids: string[],
  targetFolderId: string,
  opts: { targetMailboxId?: string } = {},
): Promise<{ mapping: UidMapping[]; modSeq: bigint | null }> {
  if (ids.length === 0) return { mapping: [], modSeq: null };
  const src = await tx.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, uid: true, folderId: true },
    orderBy: [{ uid: 'asc' }],
  });
  if (src.length === 0) return { mapping: [], modSeq: null };
  const targetMailboxId = opts.targetMailboxId ?? await mailboxOfFolder(tx, targetFolderId);
  const { firstUid, modSeq } = await allocate(tx, targetMailboxId, src.length);
  const mailboxByFolder = new Map<string, string>();
  for (const folderId of new Set(src.map((m) => m.folderId))) mailboxByFolder.set(folderId, await mailboxOfFolder(tx, folderId));
  const mapping: UidMapping[] = [];
  for (const [i, m] of src.entries()) {
    const newUid = firstUid + i;
    await tx.message.update({
      where: { id: m.id },
      data: {
        folderId: targetFolderId, uid: newUid, modSeq, createdModSeq: modSeq, changeKey: modSeq.toString(),
        deletedAt: null, softDeletedAt: null,
      },
    });
    mapping.push({ id: m.id, oldUid: m.uid, newUid });
  }
  await noteRelocation(tx, targetMailboxId, targetFolderId, modSeq, mailboxByFolder);
  return { mapping, modSeq };
}

export interface CopyOpts {
  targetMailboxId?: string;
  /** Override fields on the copies (e.g. flags). */
  data?: Partial<NewMessageData>;
  /** Also duplicate the attachment rows (MinIO objects are shared). Default true. */
  withAttachments?: boolean;
}

/**
 * Fields that identify a row or are derived per copy and must not be duplicated
 * (w3: `createdBy` — a copy is a new item, its creator is set by the caller).
 */
const NON_COPY_FIELDS = new Set(['id', 'folderId', 'uid', 'modSeq', 'createdModSeq', 'changeKey', 'createdAt', 'threadId', 'attachments', 'createdBy']);

/**
 * Copy messages into `targetFolderId` with fresh UIDs (never the source UIDs) and
 * one new modSeq. Mapping order = ascending source UID; `newIds[i]` belongs to `mapping[i]`.
 */
export async function copyMessages(
  tx: MessageStoreTx,
  ids: string[],
  targetFolderId: string,
  opts: CopyOpts = {},
): Promise<{ mapping: Array<UidMapping & { newId: string }>; modSeq: bigint | null }> {
  if (ids.length === 0) return { mapping: [], modSeq: null };
  const withAttachments = opts.withAttachments ?? true;
  const src = await tx.message.findMany({
    where: { id: { in: ids } },
    orderBy: [{ uid: 'asc' }],
    ...(withAttachments ? { include: { attachments: true } } : {}),
  }) as Array<Message & { attachments?: Array<Record<string, unknown>> }>;
  if (src.length === 0) return { mapping: [], modSeq: null };
  const targetMailboxId = opts.targetMailboxId ?? await mailboxOfFolder(tx, targetFolderId);
  const { firstUid, modSeq } = await allocate(tx, targetMailboxId, src.length);
  const mapping: Array<UidMapping & { newId: string }> = [];
  for (const [i, m] of src.entries()) {
    const base: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) if (!NON_COPY_FIELDS.has(k)) base[k] = v;
    const atts = withAttachments ? (m.attachments ?? []) : [];
    const newUid = firstUid + i;
    const overrideFlags = opts.data?.flags;
    const followUp = Array.isArray(overrideFlags) ? followUpAfterKeywords(m, overrideFlags) : null;
    const created = await tx.message.create({
      data: {
        ...(base as NewMessageData),
        ...(followUp ?? {}),
        ...(opts.data ?? {}),
        folderId: targetFolderId,
        uid: newUid,
        modSeq,
        createdModSeq: modSeq,
        changeKey: modSeq.toString(),
        ...(atts.length > 0
          ? {
              attachments: {
                create: atts.map((a) => ({
                  contentId: (a['contentId'] as string | null) ?? null,
                  filename: a['filename'] as string,
                  mimeType: a['mimeType'] as string,
                  size: a['size'] as number,
                  sha256: a['sha256'] as string,
                  storagePath: a['storagePath'] as string,
                  inline: Boolean(a['inline']),
                })),
              },
            }
          : {}),
      },
    });
    mapping.push({ id: m.id, oldUid: m.uid, newUid, newId: created.id });
  }
  noteChange(targetMailboxId, 'messages', modSeq, [targetFolderId]);
  return { mapping, modSeq };
}

/**
 * Startup migration (idempotent): raise every mailbox's highestModSeq to at least
 * max(message.modSeq) and uidNext above max(message.uid). Repairs rows written with
 * `Date.now()` modSeqs or `max(uid)+1` UIDs by pre-message-store code.
 * Returns the number of mailboxes changed.
 */
export async function migrateMailboxCounters(
  db: { $executeRawUnsafe: (sql: string) => Promise<number> },
): Promise<number> {
  return db.$executeRawUnsafe(`
    UPDATE "mailboxes" AS m
       SET "highestModSeq" = GREATEST(m."highestModSeq", s.max_mod),
           "uidNext"       = GREATEST(m."uidNext", s.max_uid + 1)
      FROM (
        SELECT f."mailboxId" AS mailbox_id, MAX(msg."modSeq") AS max_mod, MAX(msg."uid") AS max_uid
          FROM "messages" msg
          JOIN "folders" f ON f."id" = msg."folderId"
         GROUP BY f."mailboxId"
      ) AS s
     WHERE s.mailbox_id = m."id"
       AND (m."highestModSeq" < s.max_mod OR m."uidNext" <= s.max_uid)`);
}
