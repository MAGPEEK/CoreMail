/**
 * Superseded draft versions (8.1).
 *
 * Every webmail autosave replaces the draft with a new message (new UID). The
 * previous version must not become a recoverable deleted item and must not
 * keep its objects: autosave would otherwise store a full copy every few
 * seconds and keep it for DELETED_ITEM_RETENTION_DAYS.
 *
 * `supersedeDraftVersion()` expunges the old version through the message store
 * (one modSeq bump: IMAP QRESYNC/CONDSTORE, JMAP /changes and EAS see a normal
 * removal) and strips the row in the same write: storage key, bodies and size
 * cleared, attachment rows deleted, marked with SUPERSEDED_DRAFT_FLAG. Such a
 * tombstone is never listed, restored or counted as a recoverable item; the
 * deleted-items purge hard-deletes it after SUPERSEDED_TOMBSTONE_TTL_MS (it is
 * kept that long only so JMAP /changes can still report it as destroyed — an
 * immediate hard delete forces every JMAP client into a full resync on each
 * autosave).
 *
 * `releaseUnreferencedObjects()` deletes the version's raw and attachment
 * objects once no other row references the same key (raw keys are
 * content-addressed and attachment keys can be shared by copies).
 */
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { touchMessages, type MessageStoreTx } from './message-store.js';
import { deleteObject } from './minio/index.js';
import { DRAFT_FLAG } from './draft.js';

const log = createLogger('storage:draft-versions');

/** Marks a stripped tombstone of a replaced draft version (never recoverable). */
export const SUPERSEDED_DRAFT_FLAG = '$CoreMailSuperseded';
/** How long a superseded-version tombstone stays before the purge removes it. */
export const SUPERSEDED_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SupersededObjects {
  rawKeys: string[];
  attachmentKeys: string[];
}

/**
 * Expunges (modSeq bump) and strips the given draft versions inside `tx`.
 * Returns the object keys they held — pass them to releaseUnreferencedObjects()
 * after the transaction committed.
 */
export async function supersedeDraftVersion(
  tx: MessageStoreTx,
  ids: string[],
  opts: { mailboxId: string; folderId: string; now?: Date },
): Promise<SupersededObjects> {
  if (ids.length === 0) return { rawKeys: [], attachmentKeys: [] };
  const rows = await tx.message.findMany({
    where: { id: { in: ids }, folderId: opts.folderId, deletedAt: null },
    select: { id: true, storagePath: true, attachments: { select: { storagePath: true } } },
  });
  if (rows.length === 0) return { rawKeys: [], attachmentKeys: [] };
  const live = rows.map((r) => r.id);
  await touchMessages(tx, live, {
    deletedAt: opts.now ?? new Date(),
    storagePath: null,
    bodyText: '',
    bodyHtml: '',
    rawSize: 0,
    flags: [DRAFT_FLAG, SUPERSEDED_DRAFT_FLAG],
  }, { mailboxId: opts.mailboxId, where: { folderId: opts.folderId, deletedAt: null } });
  await tx.attachment.deleteMany({ where: { messageId: { in: live } } });
  return {
    rawKeys: [...new Set(rows.map((r) => r.storagePath).filter((k): k is string => !!k))],
    attachmentKeys: [...new Set(rows.flatMap((r) => r.attachments.map((a) => a.storagePath)).filter(Boolean))],
  };
}

/**
 * Deletes each object that no message (raw) or attachment row references any
 * more. Never throws (a leftover object is only wasted space). Returns the
 * keys that were deleted.
 */
export async function releaseUnreferencedObjects(keys: SupersededObjects): Promise<string[]> {
  const deleted: string[] = [];
  const release = async (key: string, refs: () => Promise<number>): Promise<void> => {
    try {
      if ((await refs()) > 0) return;
      await deleteObject(key);
      deleted.push(key);
    } catch (err) {
      log.warn({ err, key }, 'Superseded draft object not released');
    }
  };
  for (const key of new Set(keys.rawKeys)) {
    await release(key, () => prisma.message.count({ where: { storagePath: key } }));
  }
  for (const key of new Set(keys.attachmentKeys)) {
    await release(key, () => prisma.attachment.count({ where: { storagePath: key } }));
  }
  return deleted;
}

/** Hard-deletes superseded-version tombstones older than the TTL. Returns the count. */
export async function purgeSupersededDraftTombstones(now = new Date(), ttlMs = SUPERSEDED_TOMBSTONE_TTL_MS): Promise<number> {
  const r = await prisma.message.deleteMany({
    where: { deletedAt: { lt: new Date(now.getTime() - ttlMs) }, flags: { has: SUPERSEDED_DRAFT_FLAG } },
  });
  return r.count;
}
