/**
 * Recover deleted items (v8.1, Exchange "Recoverable Items").
 *
 * Every user deletion that removes a message from its folder (IMAP EXPUNGE,
 * JMAP Email/set destroy, EAS Delete, POP3 DELE, MWA "delete" in the Trash,
 * emptying the Trash/Junk) leaves a soft-delete tombstone (message-store
 * expunge(): deletedAt set, row + raw object + attachments kept). Tombstones
 * stay recoverable for DELETED_ITEM_RETENTION_DAYS (default 30, the 8.0
 * documented window and Exchange's maximum) and are then
 * removed by the background purge. Items the Managed Folder Assistant moved to
 * "Recoverable Items/Deletions" (retention action DELETE_AND_ALLOW_RECOVERY)
 * are listed and restorable as well; their expiry stays with the MFA.
 *
 * Restore goes through message-store restoreMessages(): new UIDs and a new
 * modSeq, so IMAP/JMAP/EAS see the items as new messages.
 *
 * Raw message and attachment objects are content-addressed and never removed
 * by the object-storage cleaner (it only expires temporary prefixes), so the
 * content of a tombstone stays available for the whole retention window.
 * Purging removes the database rows, the ActiveSync item state of the purged
 * ids, and then the raw/attachment objects no other row references any more
 * (purge-objects.ts; DELETED_ITEM_PURGE_OBJECTS=delete|dry-run|off).
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { restoreMessages, nextModSeq } from './message-store.js';
import { invalidateUsage, type QuotaOwner } from './mailbox-quota.js';
import { SUPERSEDED_DRAFT_FLAG, purgeSupersededDraftTombstones } from './draft-versions.js';
import { purgeCandidateKeys, deleteUnreferencedObjects, type ObjectPurgeDeps, type ObjectPurgeMode } from './purge-objects.js';

const log = createLogger('storage:recoverable');

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 30 days: 8.0 documented a 30-day window for deleted items, so a shorter
 * default would purge items deleted 15–30 days ago on the first start after
 * the upgrade. 30 is also Exchange's maximum deleted item retention.
 */
export const DEFAULT_DELETED_ITEM_RETENTION_DAYS = 30;
export const RECOVERABLE_ROOT = 'Recoverable Items';
export const RECOVERABLE_DELETIONS = 'Recoverable Items/Deletions';
/** Folders a restore never targets by default (restored items go to INBOX instead). */
const NO_RESTORE_TARGET = new Set(['Trash']);

/**
 * DELETED_ITEM_RETENTION_DAYS: whole days a deleted item stays recoverable.
 * 0 = keep tombstones forever (no automatic purge — the pre-8.1 behaviour).
 * Invalid values fall back to 30.
 */
export function deletedItemRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env['DELETED_ITEM_RETENTION_DAYS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DELETED_ITEM_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : DEFAULT_DELETED_ITEM_RETENTION_DAYS;
}

/** Pure: items deleted before this instant are past the retention (null = never). */
export function retentionCutoff(now: Date, days: number): Date | null {
  return days > 0 ? new Date(now.getTime() - days * DAY_MS) : null;
}

export type RecoverableKind = 'deleted' | 'retention';

export interface RecoverableItem {
  id: string;
  kind: RecoverableKind;
  subject: string;
  fromAddr: string;
  fromName: string;
  date: Date;
  deletedAt: Date;
  /** When the item will be purged (null = kept until purged by hand). */
  expiresAt: Date | null;
  folderId: string;
  folderName: string;
  folderDisplayName: string;
  rawSize: number;
}

/** Where-clause: recoverable items of a mailbox (tombstones within the retention + MFA deletions). */
function recoverableWhere(mailboxId: string, now: Date, days: number) {
  const cutoff = retentionCutoff(now, days);
  return {
    folder: { mailboxId },
    OR: [
      { deletedAt: cutoff ? { gte: cutoff } : { not: null } },
      { deletedAt: null, folder: { name: RECOVERABLE_DELETIONS } },
    ],
    // 8.1: replaced webmail draft versions are not deleted items
    NOT: { flags: { has: SUPERSEDED_DRAFT_FLAG } },
  };
}

export interface ListOpts {
  now?: Date;
  days?: number;
  limit?: number;
  /** Case-insensitive substring of subject or sender. */
  search?: string;
}

/** Recoverable items of a mailbox, most recently deleted first. */
export async function listRecoverableItems(mailboxId: string, opts: ListOpts = {}): Promise<{ items: RecoverableItem[]; total: number; retentionDays: number }> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? deletedItemRetentionDays();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const base = recoverableWhere(mailboxId, now, days);
  const q = opts.search?.trim();
  const where = q
    ? { AND: [base, { OR: [
        { subject: { contains: q, mode: 'insensitive' as const } },
        { fromAddr: { contains: q, mode: 'insensitive' as const } },
        { fromName: { contains: q, mode: 'insensitive' as const } },
      ] }] }
    : base;
  const [rows, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: [
        { deletedAt: { sort: 'desc', nulls: 'last' } },
        { softDeletedAt: { sort: 'desc', nulls: 'last' } },
        { date: 'desc' },
      ],
      take: limit,
      select: {
        id: true, subject: true, fromAddr: true, fromName: true, date: true, rawSize: true,
        deletedAt: true, softDeletedAt: true, createdAt: true, folderId: true,
        folder: { select: { name: true, displayName: true } },
      },
    }),
    prisma.message.count({ where }),
  ]);
  const items = rows.map((r): RecoverableItem => {
    const kind: RecoverableKind = r.deletedAt ? 'deleted' : 'retention';
    const deletedAt = r.deletedAt ?? r.softDeletedAt ?? r.createdAt;
    return {
      id: r.id, kind, subject: r.subject, fromAddr: r.fromAddr, fromName: r.fromName, date: r.date,
      deletedAt,
      expiresAt: days > 0 ? new Date(deletedAt.getTime() + days * DAY_MS) : null,
      folderId: r.folderId, folderName: r.folder.name, folderDisplayName: r.folder.displayName, rawSize: r.rawSize,
    };
  });
  return { items, total, retentionDays: days };
}

async function ownerOfMailbox(mailboxId: string): Promise<QuotaOwner | null> {
  const m = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { userId: true, sharedBoxId: true } });
  if (m?.userId) return { kind: 'user', id: m.userId };
  if (m?.sharedBoxId) return { kind: 'shared', id: m.sharedBoxId };
  return null;
}

/** Recomputes totalCount/unreadCount of folders from their live rows. */
export async function refreshFolderCounters(folderIds: Iterable<string>): Promise<void> {
  for (const id of new Set(folderIds)) {
    const [total, read] = await Promise.all([
      prisma.message.count({ where: { folderId: id, deletedAt: null } }),
      prisma.message.count({ where: { folderId: id, deletedAt: null, flags: { has: '\\Seen' } } }),
    ]);
    await prisma.folder.update({ where: { id }, data: { totalCount: total, unreadCount: Math.max(0, total - read) } })
      .catch(() => undefined);
  }
}

export interface RestoreResult {
  restored: Array<{ id: string; folderId: string; uid: number }>;
  /** Ids that are not recoverable items of this mailbox (unknown, live, expired). */
  notFound: string[];
}

/**
 * Restores recoverable items of `mailboxId` into `targetFolderId`, or — without
 * one — into the folder they were deleted from, INBOX when that was the Trash or
 * the item came from Recoverable Items (retention).
 */
export async function restoreRecoverableItems(
  mailboxId: string,
  ids: string[],
  opts: { targetFolderId?: string; now?: Date; days?: number } = {},
): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? deletedItemRetentionDays();
  const unique = [...new Set(ids)];
  const rows = await prisma.message.findMany({
    where: { AND: [{ id: { in: unique } }, recoverableWhere(mailboxId, now, days)] },
    select: { id: true, folderId: true, deletedAt: true, folder: { select: { name: true } } },
  });
  const found = new Set(rows.map((r) => r.id));
  const notFound = unique.filter((id) => !found.has(id));
  if (rows.length === 0) return { restored: [], notFound };

  const folders = await prisma.folder.findMany({ where: { mailboxId }, select: { id: true, name: true } });
  const inbox = folders.find((f) => f.name === 'INBOX') ?? folders.find((f) => f.name === 'Inbox');
  let explicit: string | null = null;
  if (opts.targetFolderId) {
    const f = folders.find((x) => x.id === opts.targetFolderId);
    if (!f || f.name.startsWith(RECOVERABLE_ROOT)) throw new RangeError('invalid target folder');
    explicit = f.id;
  }
  const byTarget = new Map<string, string[]>();
  for (const r of rows) {
    const own = r.deletedAt && !NO_RESTORE_TARGET.has(r.folder.name) && !r.folder.name.startsWith(RECOVERABLE_ROOT)
      ? r.folderId : null;
    const target = explicit ?? own ?? inbox?.id;
    if (!target) throw new Error('mailbox has no INBOX');
    const list = byTarget.get(target) ?? [];
    list.push(r.id);
    byTarget.set(target, list);
  }

  const restored: RestoreResult['restored'] = [];
  await prisma.$transaction(async (tx) => {
    // Lock the mailbox counters first (row lock until commit): a concurrent
    // restore or purge of the same items waits, and the re-check below sees
    // its result — no 500 for a purged row, no second UID for a restored one.
    await nextModSeq(tx, mailboxId);
    const still = new Set((await tx.message.findMany({
      where: { AND: [{ id: { in: rows.map((r) => r.id) } }, recoverableWhere(mailboxId, now, days)] },
      select: { id: true },
    })).map((r) => r.id));
    for (const [target, list] of byTarget) {
      const live = list.filter((id) => still.has(id));
      for (const id of list) if (!still.has(id)) notFound.push(id);
      if (live.length === 0) continue;
      const { mapping } = await restoreMessages(tx, live, target, { targetMailboxId: mailboxId });
      for (const m of mapping) restored.push({ id: m.id, folderId: target, uid: m.newUid });
    }
  });
  await refreshFolderCounters([...byTarget.keys(), ...rows.map((r) => r.folderId)]);
  const owner = await ownerOfMailbox(mailboxId);
  if (owner) invalidateUsage(owner);
  log.info({ mailboxId, restored: restored.length }, 'Deleted items restored');
  return { restored, notFound };
}

/**
 * Permanently removes recoverable items of a mailbox (user "Purge" or an admin).
 * `ids` undefined = every recoverable item of the mailbox. Returns the number removed.
 */
export async function purgeRecoverableItems(
  mailboxId: string,
  ids?: string[],
  opts: { objects?: { mode?: ObjectPurgeMode; deps?: ObjectPurgeDeps } } = {},
): Promise<number> {
  // Purge also reaches tombstones past the retention that the job did not remove yet.
  const recoverable = {
    folder: { mailboxId },
    OR: [{ deletedAt: { not: null } }, { deletedAt: null, folder: { name: RECOVERABLE_DELETIONS } }],
  };
  const where = { ...recoverable, ...(ids ? { id: { in: [...new Set(ids)] } } : {}) };
  const rows = await prisma.message.findMany({ where, select: PURGE_SELECT });
  if (rows.length === 0) return 0;
  let removed = 0;
  await prisma.$transaction(async (tx) => {
    await nextModSeq(tx, mailboxId); // serialises with a concurrent restore
    // Re-checked in the delete: an item restored meanwhile is live again and stays.
    removed = (await tx.message.deleteMany({ where: { AND: [{ id: { in: rows.map((r) => r.id) } }, recoverable] } })).count;
  });
  const liveFolders = rows.filter((r) => r.deletedAt === null).map((r) => r.folderId);
  if (liveFolders.length > 0) await refreshFolderCounters(liveFolders);
  await afterPurge(rows, opts.objects);
  log.info({ mailboxId, purged: removed }, 'Recoverable items purged');
  return removed;
}

const PURGE_SELECT = {
  id: true, folderId: true, deletedAt: true, storagePath: true,
  attachments: { select: { storagePath: true } },
} as const;

/**
 * After rows are hard-deleted: forget their ActiveSync item state (devices
 * still get a Delete — Sync reports vanished ServerIds) and remove the objects
 * no other row references. Never throws.
 */
async function afterPurge(
  rows: ReadonlyArray<{ id: string; storagePath: string | null; attachments: ReadonlyArray<{ storagePath: string | null }> }>,
  objects: { mode?: ObjectPurgeMode; deps?: ObjectPurgeDeps } = {},
): Promise<void> {
  // Only ids whose row is really gone (a restored row keeps its state).
  const ids = rows.map((r) => r.id);
  let gone = ids;
  try {
    const present = new Set((await prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
    gone = ids.filter((id) => !present.has(id));
  } catch (err) {
    log.warn({ err }, 'Purge follow-up: row check failed — item state and objects kept');
    return;
  }
  if (gone.length === 0) return;
  try {
    await prisma.activeSyncItem.deleteMany({ where: { serverId: { in: gone } } });
  } catch (err) {
    log.warn({ err }, 'Purge follow-up: ActiveSync item state not cleaned');
  }
  const goneSet = new Set(gone);
  await deleteUnreferencedObjects(purgeCandidateKeys(rows.filter((r) => goneSet.has(r.id))), objects);
}

/**
 * Background purge: removes tombstones deleted before the retention cutoff, in
 * batches. Tombstones are invisible to every protocol already, so no modSeq is
 * allocated (QRESYNC reports unknown UIDs as vanished anyway; JMAP counts only
 * live rows). Returns the number of rows removed.
 */
export async function purgeExpiredDeletedItems(opts: {
  now?: Date; days?: number; batchSize?: number; maxBatches?: number;
  objects?: { mode?: ObjectPurgeMode; deps?: ObjectPurgeDeps };
} = {}): Promise<number> {
  const days = opts.days ?? deletedItemRetentionDays();
  // 8.1: tombstones of replaced draft versions go after a day, whatever the retention
  const superseded = await purgeSupersededDraftTombstones(opts.now ?? new Date());
  if (superseded > 0) log.info({ purged: superseded }, 'Superseded draft versions purged');
  const cutoff = retentionCutoff(opts.now ?? new Date(), days);
  if (!cutoff) return superseded;
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 1000;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await prisma.message.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: PURGE_SELECT,
      take: batchSize,
    });
    if (batch.length === 0) break;
    const r = await prisma.message.deleteMany({ where: { id: { in: batch.map((b) => b.id) }, deletedAt: { lt: cutoff } } });
    total += r.count;
    // Per batch: orphaned ActiveSync item state + unreferenced objects.
    await afterPurge(batch, opts.objects);
    if (batch.length < batchSize) break;
  }
  if (total > 0) log.info({ purged: total, retentionDays: days }, 'Expired deleted items purged');
  return total + superseded;
}

export const DELETED_ITEMS_PURGE_LOCK_KEY = 'storage:deleted-items-purge:lock';
export const DELETED_ITEMS_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Minimal Redis surface (ioredis-compatible). */
export interface PurgeRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

/** One locked run across all processes: null when another process ran in this interval. */
export async function runLockedDeletedItemsPurge(
  redis: PurgeRedis,
  opts: { lockTtlMs?: number; now?: Date; days?: number } = {},
): Promise<number | null> {
  const got = await redis.set(DELETED_ITEMS_PURGE_LOCK_KEY, randomUUID(), 'PX', opts.lockTtlMs ?? DELETED_ITEMS_PURGE_INTERVAL_MS - 60_000, 'NX');
  if (got !== 'OK') return null;
  return purgeExpiredDeletedItems({ ...(opts.now ? { now: opts.now } : {}), ...(opts.days !== undefined ? { days: opts.days } : {}) });
}

/** Starts the hourly purge (no-op handle when DELETED_ITEM_RETENTION_DAYS=0). */
export function startDeletedItemsPurger(redis: PurgeRedis, opts: { intervalMs?: number; initialDelayMs?: number } = {}): { stop(): void } {
  if (deletedItemRetentionDays() === 0) {
    log.info('DELETED_ITEM_RETENTION_DAYS=0 — deleted items are kept until purged by hand');
    return { stop: () => undefined };
  }
  const interval = opts.intervalMs ?? DELETED_ITEMS_PURGE_INTERVAL_MS;
  const tick = async (): Promise<void> => {
    try {
      await runLockedDeletedItemsPurge(redis, { lockTtlMs: Math.max(60_000, interval - 60_000) });
    } catch (err) {
      log.warn({ err }, 'Deleted items purge failed');
    }
  };
  const first = setTimeout(() => void tick(), opts.initialDelayMs ?? 5 * 60_000);
  const timer = setInterval(() => void tick(), interval);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
