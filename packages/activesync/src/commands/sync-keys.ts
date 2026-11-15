/**
 * Atomic updates of `ActiveSyncDevice.syncKeys` (8.0.0).
 *
 * `syncKeys` is one JSON object shared by Sync (`<folderId>`, `ack:<folderId>`,
 * `opts:<folderId>`), FolderSync (`folders`) and Ping (`ping`). Writing the whole
 * object back after a read lets overlapping requests of one device (parallel Syncs on
 * different folders, a FolderSync during a Sync, a Ping) put back stale keys of the
 * other request — the next Sync then gets Status 3 and resyncs the folder.
 *
 * Commands therefore only write the keys they changed, merged in one SQL statement
 * (`jsonb || patch`, row-locked by PostgreSQL), so keys of other requests survive.
 */
import { prisma } from '@coremail/storage/prisma';

/** Keys of `after` that are new or differ from `before` (no command deletes keys). */
export function changedSyncKeys(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) {
    if (before[k] !== v) patch[k] = v;
  }
  return patch;
}

/**
 * Merges `patch` into the device's `syncKeys` atomically (top-level keys of the patch
 * replace the stored ones, every other key is kept). `extra` columns (`lastSyncAt`,
 * `folderSyncKey`) are plain single-value columns and go through a normal update.
 */
export async function mergeSyncKeys(
  deviceRowId: string,
  patch: Record<string, string>,
  extra: { lastSyncAt?: Date; folderSyncKey?: string } = {},
): Promise<void> {
  if (Object.keys(patch).length > 0) {
    const json = JSON.stringify(patch);
    // Parameterised tagged template (no string interpolation into SQL). A stored value that
    // is not a JSON object (NULL, legacy garbage) is treated as {} — `||` on an array would append.
    await prisma.$executeRaw`UPDATE "active_sync_devices" SET "syncKeys" = (CASE WHEN jsonb_typeof("syncKeys") = 'object' THEN "syncKeys" ELSE '{}'::jsonb END) || ${json}::jsonb WHERE "id" = ${deviceRowId}`;
  }
  if (extra.lastSyncAt !== undefined || extra.folderSyncKey !== undefined) {
    await prisma.activeSyncDevice.update({
      where: { id: deviceRowId },
      data: {
        ...(extra.lastSyncAt !== undefined ? { lastSyncAt: extra.lastSyncAt } : {}),
        ...(extra.folderSyncKey !== undefined ? { folderSyncKey: extra.folderSyncKey } : {}),
      },
    });
  }
}
