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
 * This module has no runtime imports on purpose: it only talks to the
 * transaction client it is given (also makes it trivial to fake in tests).
 *
 * Migration: rows written before v6.x may carry `Date.now()`-sized modSeqs and
 * (internal-notify) UIDs ≥ uidNext. The first allocation per mailbox and process
 * raises the counters to max(message.modSeq) / max(message.uid) + 1, see
 * {@link ensureCounterFloor} and {@link migrateMailboxCounters}.
 */
import type { Prisma, Message } from '@prisma/client';

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
    created.push(await tx.message.create({
      data: { changeKey: modSeq.toString(), ...data, folderId, uid: firstUid + i, modSeq },
    }));
  }
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

/** Group message ids by their mailbox (one lookup unless the caller passes mailboxId). */
async function byMailbox(tx: MessageStoreTx, ids: string[], opts: ScopeOpts): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  if (opts.mailboxId) { out.set(opts.mailboxId, [...ids]); return out; }
  const rows = await tx.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, folder: { select: { mailboxId: true } } },
  });
  for (const r of rows) {
    const list = out.get(r.folder.mailboxId) ?? [];
    list.push(r.id);
    out.set(r.folder.mailboxId, list);
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
  for (const [mailboxId, list] of await byMailbox(tx, ids, opts)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    await tx.message.updateMany({
      where: { ...(opts.where ?? {}), id: { in: list } },
      data: { ...data, modSeq, changeKey: modSeq.toString() },
    });
    result.set(mailboxId, modSeq);
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
  for (const [mailboxId, list] of await byMailbox(tx, [...flagsById.keys()], opts)) {
    const modSeq = await nextModSeq(tx, mailboxId);
    for (const id of list) {
      const flags = flagsById.get(id)!;
      await tx.message.update({ where: { id }, data: { flags, modSeq, changeKey: modSeq.toString() } });
      out.push({ id, flags, modSeq });
    }
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
    select: { id: true, uid: true, folderId: true },
    orderBy: [{ uid: 'asc' }],
  });
  if (src.length === 0) return { mapping: [], modSeq: null };
  const targetMailboxId = opts.targetMailboxId ?? await mailboxOfFolder(tx, targetFolderId);
  const { firstUid, modSeq } = await allocate(tx, targetMailboxId, src.length);
  const mapping: UidMapping[] = [];
  for (const [i, m] of src.entries()) {
    const newUid = firstUid + i;
    await tx.message.update({
      where: { id: m.id },
      data: { ...(opts.data ?? {}), folderId: targetFolderId, uid: newUid, modSeq, changeKey: modSeq.toString() },
    });
    mapping.push({ id: m.id, oldUid: m.uid, newUid });
  }
  const sourceMailboxes = new Set<string>();
  if (opts.sourceMailboxId) sourceMailboxes.add(opts.sourceMailboxId);
  else for (const folderId of new Set(src.map((m) => m.folderId))) sourceMailboxes.add(await mailboxOfFolder(tx, folderId));
  for (const mbx of sourceMailboxes) if (mbx !== targetMailboxId) await nextModSeq(tx, mbx);
  return { mapping, modSeq };
}

export interface CopyOpts {
  targetMailboxId?: string;
  /** Override fields on the copies (e.g. flags). */
  data?: Partial<NewMessageData>;
  /** Also duplicate the attachment rows (MinIO objects are shared). Default true. */
  withAttachments?: boolean;
}

/** Fields that identify a row or are derived per copy and must not be duplicated. */
const NON_COPY_FIELDS = new Set(['id', 'folderId', 'uid', 'modSeq', 'changeKey', 'createdAt', 'threadId', 'attachments']);

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
    const created = await tx.message.create({
      data: {
        ...(base as NewMessageData),
        ...(opts.data ?? {}),
        folderId: targetFolderId,
        uid: newUid,
        modSeq,
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
