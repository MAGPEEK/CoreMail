/**
 * MoveItems of a PIM item ([MS-ASCMD] 2.2.1.12): only into another collection of the same
 * class (an event into another own calendar). Mail ↔ PIM and calendar ↔ tasks are refused as
 * an invalid destination. The item keeps its ServerId; the device's item state follows the
 * move, so the next Sync neither re-adds it in the destination nor deletes it in the source.
 */
import { forgetItems, markKnown } from '../commands/item-state.js';
import type { EasVersion } from '../protocol-version.js';
import { moduleFor, resolveCollection } from './registry.js';
import { loadPimUser } from './user.js';

export type PimMoveResult = { kind: 'moved'; serverId: string } | { kind: 'invalid-source' } | { kind: 'invalid-destination' };

export interface PimMoveRequest {
  userId: string;
  deviceRowId: string | null;
  version: EasVersion;
  srcCollectionId: string;
  dstCollectionId: string;
  serverId: string;
}

export async function movePimItem(r: PimMoveRequest): Promise<PimMoveResult> {
  const module = moduleFor(r.srcCollectionId);
  if (!module || moduleFor(r.dstCollectionId) !== module || !module.move) return { kind: 'invalid-destination' };
  const [src, dst] = await Promise.all([
    resolveCollection(r.userId, r.srcCollectionId, r.version),
    resolveCollection(r.userId, r.dstCollectionId, r.version),
  ]);
  if (src.status !== 'ok') return { kind: 'invalid-source' };
  if (dst.status !== 'ok') return { kind: 'invalid-destination' };
  const user = await loadPimUser(r.userId);
  if (!user) return { kind: 'invalid-source' };
  const result = await module.move(src.collection, dst.collection, r.serverId, {
    version: r.version, user, now: new Date(), supported: null,
  });
  if (!result.ok) return { kind: 'invalid-source' };
  if (r.deviceRowId) {
    await forgetItems(r.deviceRowId, r.srcCollectionId, [r.serverId]);
    await markKnown(r.deviceRowId, r.dstCollectionId, [{ serverId: result.serverId, modSeq: result.version }]);
  }
  return { kind: 'moved', serverId: result.serverId };
}
