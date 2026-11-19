/**
 * GetItemEstimate of a PIM collection: the number of Add / Change / Delete commands the next
 * Sync(s) with the presented SyncKey would send — the same difference as pim/sync.ts, against
 * what the device holds once that key is acknowledged (the issued key commits the pending
 * rows of its response, the acknowledged key does not).
 */
import { ACK_KEY } from '../commands/item-state.js';
import { isPrimingSyncKey } from '../commands/sync-window.js';
import type { EasVersion } from '../protocol-version.js';
import { resolveCollection } from './registry.js';
import { diffItems, diffSize, heldItems } from './state.js';

export type PimEstimate =
  | { status: 'ok'; estimate: number }
  | { status: 'invalid-collection' }
  | { status: 'not-primed' }
  | { status: 'invalid-key' };

export interface PimEstimateRequest {
  userId: string;
  deviceRowId: string | null;
  version: EasVersion;
  syncKeys: Record<string, string>;
  collectionId: string;
  clientSyncKey: string;
  filterType: number | undefined;
  now: Date;
}

export async function estimatePimCollection(r: PimEstimateRequest): Promise<PimEstimate> {
  const resolved = await resolveCollection(r.userId, r.collectionId, r.version);
  if (resolved.status !== 'ok') return { status: 'invalid-collection' };
  if (isPrimingSyncKey(r.clientSyncKey)) return { status: 'not-primed' };
  if (!r.deviceRowId) {
    const states = await resolved.module.states(resolved.collection, r.filterType, r.now);
    return { status: 'ok', estimate: states.filter((s) => s.inFilter).length };
  }
  const issued = r.syncKeys[r.collectionId];
  const ack = r.syncKeys[ACK_KEY(r.collectionId)];
  let held: Map<string, bigint>;
  if (ack !== undefined && r.clientSyncKey === ack) held = await heldItems(r.deviceRowId, r.collectionId);
  else if (ack !== undefined && r.clientSyncKey === issued) held = await heldItems(r.deviceRowId, r.collectionId, issued);
  else return { status: 'invalid-key' };
  const states = await resolved.module.states(resolved.collection, r.filterType, r.now, new Set(held.keys()));
  return { status: 'ok', estimate: diffSize(diffItems(states, held)) };
}
