/**
 * Per-device ActiveSync item state (`ActiveSyncItem`): which ServerIds a device holds in a
 * collection and the message modSeq it holds them at.
 *
 *  - committed rows (`pendingKey = ''`): what the device acknowledged;
 *  - pending rows (`pendingKey = <SyncKey>`): what the response that issued that SyncKey
 *    sent (Add/Change → modSeq, Delete → null). The device acknowledges a response by
 *    presenting its SyncKey in the next Sync — then the pending rows become committed.
 *    Presenting the previous key (a retried request after a lost response) discards them,
 *    so the same changes are sent again ([MS-ASCMD] Sync: the server must resend).
 *
 * The SyncKeys live in `ActiveSyncDevice.syncKeys`: `<collectionId>` = last issued key,
 * `ack:<collectionId>` = last acknowledged key. A key that is neither → Status 3.
 *
 * Sync uses the committed state to send `Change` (not `Add`) for items the device has,
 * to skip items whose current modSeq the device already holds (its own Read change, its
 * own MoveItems), and to send `Delete` for known items that left the collection.
 */
import { prisma } from '@coremail/storage/prisma';

export const ACK_KEY = (collectionId: string) => `ack:${collectionId}`;

export interface KnownItem { serverId: string; modSeq: bigint }

/** Committed state of the given ServerIds (all of the collection when `ids` is omitted). */
export async function knownItems(deviceRowId: string, collectionId: string, ids?: string[]): Promise<Map<string, bigint>> {
  if (ids && ids.length === 0) return new Map();
  const rows = await prisma.activeSyncItem.findMany({
    where: { deviceRowId, collectionId, pendingKey: '', ...(ids ? { serverId: { in: ids } } : {}) },
    select: { serverId: true, modSeq: true },
  });
  return new Map(rows.filter((r) => r.modSeq !== null).map((r) => [r.serverId, r.modSeq as bigint]));
}

/** The device holds these items at these modSeqs (replaces their committed rows). */
export async function markKnown(deviceRowId: string, collectionId: string, items: KnownItem[]): Promise<void> {
  if (items.length === 0) return;
  await prisma.activeSyncItem.deleteMany({
    where: { deviceRowId, collectionId, pendingKey: '', serverId: { in: items.map((i) => i.serverId) } },
  });
  await prisma.activeSyncItem.createMany({
    data: items.map((i) => ({ deviceRowId, collectionId, serverId: i.serverId, pendingKey: '', modSeq: i.modSeq })),
  });
}

/** The device no longer holds these items in the collection (committed and pending rows). */
export async function forgetItems(deviceRowId: string, collectionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.activeSyncItem.deleteMany({ where: { deviceRowId, collectionId, serverId: { in: ids } } });
}

/** Forget the whole collection (SyncKey 0). */
export async function resetCollection(deviceRowId: string, collectionId: string): Promise<void> {
  await prisma.activeSyncItem.deleteMany({ where: { deviceRowId, collectionId } });
}

/** Changes sent in the response that issues `syncKey` (modSeq null = Delete). */
export async function recordPending(deviceRowId: string, collectionId: string, syncKey: string, items: Array<{ serverId: string; modSeq: bigint | null }>): Promise<void> {
  if (items.length === 0) return;
  await prisma.activeSyncItem.createMany({
    data: items.map((i) => ({ deviceRowId, collectionId, serverId: i.serverId, pendingKey: syncKey, modSeq: i.modSeq })),
  });
}

async function commitPending(deviceRowId: string, collectionId: string, syncKey: string): Promise<void> {
  const pending = await prisma.activeSyncItem.findMany({
    where: { deviceRowId, collectionId, pendingKey: syncKey },
    select: { serverId: true, modSeq: true },
  });
  if (pending.length > 0) {
    await prisma.activeSyncItem.deleteMany({
      where: { deviceRowId, collectionId, pendingKey: '', serverId: { in: pending.map((p) => p.serverId) } },
    });
    const kept = pending.filter((p) => p.modSeq !== null);
    if (kept.length > 0) {
      await prisma.activeSyncItem.createMany({
        data: kept.map((p) => ({ deviceRowId, collectionId, serverId: p.serverId, pendingKey: '', modSeq: p.modSeq })),
      });
    }
  }
  await discardPending(deviceRowId, collectionId);
}

async function discardPending(deviceRowId: string, collectionId: string): Promise<void> {
  await prisma.activeSyncItem.deleteMany({ where: { deviceRowId, collectionId, pendingKey: { not: '' } } });
}

/**
 * Bring the item state in line with the SyncKey the device presents (non-priming key).
 * `syncKeys` is updated in place (`ack:<collectionId>`). Returns false for a key that is
 * neither the issued nor the acknowledged one (→ Status 3).
 *
 * Devices synced before v7.1 have no `ack:` entry: their state is rebuilt from the
 * folder (every live message below the key — that is what the old Sync had sent).
 */
export async function acknowledgeSyncKey(
  deviceRowId: string,
  collectionId: string,
  clientKey: string,
  syncKeys: Record<string, string>,
): Promise<boolean> {
  const ack = syncKeys[ACK_KEY(collectionId)];
  const issued = syncKeys[collectionId];
  if (ack === undefined) {
    if (!/^\d{1,20}$/.test(clientKey)) return false;
    const existing = await knownItems(deviceRowId, collectionId);
    const rows = await prisma.message.findMany({
      where: { folderId: collectionId, deletedAt: null, modSeq: { lt: BigInt(clientKey) } },
      select: { id: true, modSeq: true },
    });
    await discardPending(deviceRowId, collectionId);
    const missing = rows.filter((r) => !existing.has(r.id));
    if (missing.length > 0) {
      await prisma.activeSyncItem.createMany({
        data: missing.map((r) => ({ deviceRowId, collectionId, serverId: r.id, pendingKey: '', modSeq: r.modSeq })),
      });
    }
    syncKeys[ACK_KEY(collectionId)] = clientKey;
    return true;
  }
  if (clientKey === ack) {
    await discardPending(deviceRowId, collectionId);
    return true;
  }
  if (issued !== undefined && clientKey === issued) {
    await commitPending(deviceRowId, collectionId, clientKey);
    syncKeys[ACK_KEY(collectionId)] = clientKey;
    return true;
  }
  return false;
}
