/**
 * Ping on PIM collections: a collection has changes when the items differ from what the
 * device holds once it acknowledges the last response (its issued SyncKey) — so changes made
 * before the Ping started are reported at once and the device's own writes are not. Each poll
 * first compares the cheap fingerprint (count + newest change) and computes the difference
 * only when it moved.
 */
import type { EasVersion } from '../protocol-version.js';
import { resolveCollection } from './registry.js';
import { diffItems, diffSize, heldItems } from './state.js';
import type { PimClassModule, PimCollection } from './types.js';

export interface PimWatch {
  collectionId: string;
  module: PimClassModule;
  collection: PimCollection;
  filterType: number | undefined;
  /** Fingerprint at the last check (null before the first). */
  fingerprint: string | null;
}

/** Watches for the requested PIM collections; null when one is not the user's / switched off (Ping Status 7). */
export async function pimWatches(
  userId: string, ids: string[], version: EasVersion, filterTypeOf: (collectionId: string) => number | undefined,
): Promise<PimWatch[] | null> {
  const out: PimWatch[] = [];
  for (const id of ids) {
    const r = await resolveCollection(userId, id, version);
    if (r.status !== 'ok') return null;
    out.push({ collectionId: id, module: r.module, collection: r.collection, filterType: filterTypeOf(id), fingerprint: null });
  }
  return out;
}

/** Has the collection changes for the device? `issuedKey`: the SyncKey the device got last. */
export async function pimChanged(w: PimWatch, deviceRowId: string | null, issuedKey: string | undefined, now: Date): Promise<boolean> {
  const fingerprint = await w.module.fingerprint(w.collection);
  if (fingerprint === w.fingerprint) return false;
  const first = w.fingerprint === null;
  w.fingerprint = fingerprint;
  // without an item state (no device, never synced): changes after the Ping started
  if (!deviceRowId || issuedKey === undefined) return !first;
  const held = await heldItems(deviceRowId, w.collectionId, issuedKey);
  return diffSize(diffItems(await w.module.states(w.collection, w.filterType, now), held)) > 0;
}
