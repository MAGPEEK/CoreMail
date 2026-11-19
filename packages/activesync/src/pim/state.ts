/**
 * Change detection of the PIM classes. Their items carry no mailbox modSeq: what changed
 * is the difference between the items now (id + version = updatedAt) and what the device
 * holds according to its item state (commands/item-state.ts — the same committed / pending
 * rows, acknowledgement keys and retry rules as mail; `modSeq` holds the item version).
 *
 *   Add     an item in the FilterType window the device does not hold
 *   Change  an item the device holds at another version
 *   Delete  an item the device holds that is gone (deleted, moved, purged)
 */
import { prisma } from '@coremail/storage/prisma';
import type { PimItemState } from './types.js';

export interface PimDiff {
  adds: string[];
  changes: string[];
  deletes: string[];
}

/** The difference between the current items and the ones the device holds (pure). */
export function diffItems(current: readonly PimItemState[], held: ReadonlyMap<string, bigint>): PimDiff {
  const out: PimDiff = { adds: [], changes: [], deletes: [] };
  const present = new Set<string>();
  for (const item of current) {
    present.add(item.serverId);
    const version = held.get(item.serverId);
    if (version === undefined) { if (item.inFilter) out.adds.push(item.serverId); } else if (version !== item.version) out.changes.push(item.serverId);
  }
  for (const id of held.keys()) if (!present.has(id)) out.deletes.push(id);
  return out;
}

export const diffSize = (d: PimDiff): number => d.adds.length + d.changes.length + d.deletes.length;

/**
 * What the device holds once it acknowledges `pendingKey`: its committed rows overlaid with
 * the rows the response of that key sent (a Delete drops the item). Without `pendingKey`:
 * the committed rows only.
 */
export async function heldItems(deviceRowId: string, collectionId: string, pendingKey?: string): Promise<Map<string, bigint>> {
  const keys = pendingKey ? ['', pendingKey] : [''];
  const rows = await prisma.activeSyncItem.findMany({
    where: { deviceRowId, collectionId, pendingKey: { in: keys } },
    select: { serverId: true, modSeq: true, pendingKey: true },
  });
  const held = new Map<string, bigint>();
  for (const r of rows) if (r.pendingKey === '' && r.modSeq !== null) held.set(r.serverId, r.modSeq);
  for (const r of rows) {
    if (r.pendingKey === '') continue;
    if (r.modSeq === null) held.delete(r.serverId); else held.set(r.serverId, r.modSeq);
  }
  return held;
}
