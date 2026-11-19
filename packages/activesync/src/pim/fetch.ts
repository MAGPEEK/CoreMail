/**
 * ItemOperations Fetch of a PIM item ([MS-ASCMD] 2.2.1.10): the same properties as a Sync
 * Add; without BodyPreference the whole body (that is the point of Fetch).
 */
import type { WbxmlElement } from '../wbxml.js';
import type { BodyOptions } from '../commands/body.js';
import type { EasVersion } from '../protocol-version.js';
import { resolveCollection } from './registry.js';
import { pimBodyPreference } from './sync.js';
import { loadPimUser } from './user.js';

export interface FetchedPimItem { className: string; properties: WbxmlElement[] }

/** Null when the collection or item is not the user's (or the class is switched off). */
export async function fetchPimItem(
  userId: string, collectionId: string, serverId: string, options: BodyOptions | null, version: EasVersion,
): Promise<FetchedPimItem | null> {
  const resolved = await resolveCollection(userId, collectionId, version);
  if (resolved.status !== 'ok') return null;
  const [row] = await resolved.module.load(resolved.collection, [serverId]);
  const user = row ? await loadPimUser(userId) : null;
  if (!row || !user) return null;
  const bodyPref = options && options.prefs.length > 0 ? pimBodyPreference(options) : { type: 1 as const, allOrNone: false };
  return { className: resolved.module.className, properties: resolved.module.render(row, { version, bodyPref, user }) };
}
