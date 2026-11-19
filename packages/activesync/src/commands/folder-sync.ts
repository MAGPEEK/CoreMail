import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';
import { encodeWbxml, el, getText, type WbxmlElement } from '../wbxml.js';
import { mergeSyncKeys } from './sync-keys.js';
import { HIGHEST_EAS_VERSION, type EasVersion } from '../protocol-version.js';
import { moduleFor, pimFolders } from '../pim/registry.js';

const log = createLogger('activesync:folder-sync');

// EAS folder type codes ([MS-ASCMD] FolderSync Type)
const FOLDER_TYPES: Record<string, string> = {
  INBOX: '2',     // Default Inbox
  Drafts: '3',    // Default Drafts
  Trash: '4',     // Default Deleted Items
  Sent: '5',      // Default Sent Items
};
const USER_MAIL_FOLDER = '12'; // user-created mail folder (Junk, Archive, own folders)

/** [MS-ASCMD] FolderSync status values. */
export const FOLDER_SYNC_STATUS = { SUCCESS: '1', SERVER_ERROR: '6', INVALID_SYNC_KEY: '9' } as const;

/** Folder snapshot entry: [parentId, displayName, type]. */
type FolderEntry = [string, string, string];
type Snapshot = Record<string, FolderEntry>;
/** Stored in ActiveSyncDevice.syncKeys under SNAPSHOT_KEY: snapshot for the current and the previous key. */
interface FolderState { key: string; folders: Snapshot; prevKey?: string; prevFolders?: Snapshot }
const SNAPSHOT_KEY = 'folders';

function readState(syncKeys: Record<string, string>): FolderState | null {
  try {
    const s = JSON.parse(syncKeys[SNAPSHOT_KEY] ?? 'null') as FolderState | null;
    return s && typeof s.key === 'string' && s.folders && typeof s.folders === 'object' ? s : null;
  } catch { return null; }
}

function nextKey(key: string): string {
  return /^\d{1,20}$/.test(key) ? (BigInt(key) + 1n).toString() : '1';
}

/** Only the mail folders of a snapshot (what FolderSync announced before the PIM classes). */
function mailOnly(snapshot: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([id]) => !moduleFor(id)));
}

/**
 * The hierarchy as FolderSync announces it: the mailbox folders plus the folders of the PIM
 * classes the user has in this version (w3: calendars, tasks, notes). Null without a mailbox;
 * throws when the webmail policy cannot be read.
 */
export async function currentHierarchy(userId: string, version: EasVersion): Promise<Snapshot | null> {
  const mailbox = await prisma.mailbox.findFirst({
    where: { userId },
    include: { folders: { select: { id: true, name: true, displayName: true, parentId: true } } },
  });
  if (!mailbox) return null;
  const current: Snapshot = {};
  for (const f of mailbox.folders) {
    current[f.id] = [f.parentId ?? '0', f.displayName, FOLDER_TYPES[f.name] ?? USER_MAIL_FOLDER];
  }
  for (const f of await pimFolders(userId, version)) current[f.serverId] = ['0', f.displayName, f.type];
  return current;
}

const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, entry]) => b[id]?.join('\0') === entry.join('\0'));

/**
 * Ping: has the hierarchy changed since the snapshot the device got with its last FolderSync
 * ([MS-ASCMD] Ping Status 7)? False without a snapshot (devices synced before v7.1), and when
 * the hierarchy cannot be read now (the next Ping asks again).
 */
export async function hierarchyChanged(userId: string, syncKeys: Record<string, string>, version: EasVersion): Promise<boolean> {
  const state = readState(syncKeys);
  if (!state) return false;
  const current = await currentHierarchy(userId, version).catch((err: unknown) => {
    log.warn({ err, userId }, 'EAS Ping: folder hierarchy not readable — not compared');
    return null;
  });
  return current !== null && !sameSnapshot(state.folders, current);
}

/**
 * FolderSync command — the folder hierarchy of the user's mailbox and PIM classes.
 *
 * SyncKey 0: every folder as Add. Otherwise the key must be the current one (or the
 * previous one — a retry after a lost response), else Status 9 and the device starts over;
 * the response carries the Add/Update/Delete changes since the snapshot of that key. The
 * snapshot is kept per device in `ActiveSyncDevice.syncKeys`.
 */
export async function handleFolderSync(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  version: EasVersion = HIGHEST_EAS_VERSION,
): Promise<Buffer> {
  const clientSyncKey = getText(body, 'SyncKey');
  const status = (s: string) => encodeWbxml(el('FolderSync', undefined, [el('Status', s)]));

  let current: Snapshot | null;
  try {
    current = await currentHierarchy(userId, version);
  } catch (err) {
    log.error({ err, userId }, 'EAS FolderSync: webmail policy not readable');
    return status(FOLDER_SYNC_STATUS.SERVER_ERROR);
  }
  if (!current) return status(FOLDER_SYNC_STATUS.SERVER_ERROR);

  const device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  const syncKeys: Record<string, string> = { ...((device?.syncKeys as Record<string, string> | null) ?? {}) };
  const isInitialSync = clientSyncKey === '0' || !clientSyncKey;

  let base: Snapshot;
  let state = readState(syncKeys);
  if (isInitialSync) {
    base = {};
  } else if (state && clientSyncKey === state.key) {
    base = state.folders;
  } else if (state && state.prevKey !== undefined && clientSyncKey === state.prevKey && state.prevFolders) {
    base = state.prevFolders;
  } else if (!state && device && clientSyncKey === device.folderSyncKey) {
    // device synced before v7.1: no snapshot yet — it holds the mail folders as they are now
    base = mailOnly(current);
    state = { key: clientSyncKey, folders: base };
  } else {
    return status(FOLDER_SYNC_STATUS.INVALID_SYNC_KEY);
  }

  const changes: WbxmlElement[] = [];
  const entry = (id: string, [parentId, displayName, type]: FolderEntry) => [
    el('ServerId', id), el('ParentId', parentId), el('DisplayName', displayName), el('Type', type),
  ];
  for (const [id, now] of Object.entries(current)) {
    const before = base[id];
    if (!before) changes.push(el('Add', undefined, entry(id, now)));
    else if (before.join('\0') !== now.join('\0')) changes.push(el('Update', undefined, entry(id, now)));
  }
  for (const id of Object.keys(base)) {
    if (!current[id]) changes.push(el('Delete', undefined, [el('ServerId', id)]));
  }

  // New key when something is sent (or on the initial sync), and when the device presented
  // the previous key: the stored snapshot must become the one the device holds — else Ping
  // would compare against a hierarchy the device never got and answer Status 7 forever.
  // Otherwise the key stays.
  const answeredKey = isInitialSync || changes.length > 0 || (state !== null && clientSyncKey !== state.key)
    ? nextKey(state?.key ?? device?.folderSyncKey ?? '0')
    : clientSyncKey;
  if (device) {
    const newState: FolderState = answeredKey === clientSyncKey && state
      ? state
      : { key: answeredKey, folders: current, ...(isInitialSync ? {} : { prevKey: clientSyncKey, prevFolders: base }) };
    // 8.0.0: merge only the snapshot key atomically — never write back Sync/Ping keys
    // read before (a Sync running in parallel would lose its issued SyncKey).
    await mergeSyncKeys(device.id, { [SNAPSHOT_KEY]: JSON.stringify(newState) }, { folderSyncKey: newState.key, lastSyncAt: new Date() });
  }

  return encodeWbxml(el('FolderSync', undefined, [
    el('Status', FOLDER_SYNC_STATUS.SUCCESS),
    el('SyncKey', answeredKey),
    el('Changes', undefined, [el('Count', String(changes.length)), ...changes]),
  ]));
}
