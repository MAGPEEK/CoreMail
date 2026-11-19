/**
 * Sync Options are sticky ([MS-ASCMD] 2.2.3.115.5): a Sync without Options uses the ones
 * the client sent last for that collection. Stored next to the sync key in
 * ActiveSyncDevice.syncKeys under `opts:<collectionId>` (mail and PIM collections).
 */
import type { BodyOptions } from './body.js';

export const OPTIONS_KEY = (collectionId: string) => `opts:${collectionId}`;

export function storedOptions(syncKeys: Record<string, string>, collectionId: string): BodyOptions | null {
  const raw = syncKeys[OPTIONS_KEY(collectionId)];
  if (!raw) return null;
  try { return JSON.parse(raw) as BodyOptions; } catch { return null; }
}

export interface OptionsUpdate {
  /** The options that apply: the request's, else the stored ones. */
  options: BodyOptions | null;
  /** The FilterType changed against the stored options (the device must resync: Status 3). */
  filterChanged: boolean;
  /** `syncKeys` was updated. */
  dirty: boolean;
}

/** Applies the request's Options (null = none sent) to the stored ones in `syncKeys`. */
export function applyRequestOptions(syncKeys: Record<string, string>, collectionId: string, requested: BodyOptions | null): OptionsUpdate {
  const previous = storedOptions(syncKeys, collectionId);
  const filterChanged = !!requested && !!previous && requested.filterType !== previous.filterType;
  let dirty = false;
  if (requested) {
    const json = JSON.stringify(requested);
    if (syncKeys[OPTIONS_KEY(collectionId)] !== json) { syncKeys[OPTIONS_KEY(collectionId)] = json; dirty = true; }
  }
  return { options: requested ?? previous, filterChanged, dirty };
}
