import { prisma } from '@coremail/storage/prisma';
import { setFlags, expunge, moveMessages, ensureCounterFloor, loadRawMessage } from '@coremail/storage';
import { encodeWbxml, el, pel, getText, getChild, CP, type WbxmlElement } from '../wbxml.js';
import { loadSyncWindow, isPrimingSyncKey, parseWindowSize, PRIMING_SYNC_KEY, type SyncWindowDb } from './sync-window.js';
import {
  parseBodyOptions, chooseBodyPreference, buildEmailProperties, filterCutoff, EAS_ATTACHMENT_SELECT,
  type BodyOptions, type BodyPreference, type EasAttachment, type EasMessage, type LoadRaw,
} from './body.js';
import { createLogger } from '@coremail/core';
import { ACK_KEY, acknowledgeSyncKey, forgetItems, knownItems, markKnown, recordPending, resetCollection } from './item-state.js';
import { changedSyncKeys, mergeSyncKeys } from './sync-keys.js';

/** [MS-ASCMD] Sync status values used here. */
export const SYNC_STATUS = {
  SUCCESS: '1',
  INVALID_SYNC_KEY: '3',
  PROTOCOL_ERROR: '4',
  OBJECT_NOT_FOUND: '8',
  INCOMPLETE_REQUEST: '13',
} as const;

/** Response collection for a SyncKey-0 request: new key, Status 1, no Commands. */
export function primingCollection(collectionId: string): WbxmlElement {
  return el('Collection', undefined, [
    el('Class', 'Email'),
    el('SyncKey', PRIMING_SYNC_KEY),
    el('CollectionId', collectionId),
    el('Status', SYNC_STATUS.SUCCESS),
  ]);
}

/** Answer to a Sync without body: the client must send the full request ([MS-ASCMD] Status 13). */
export function emptySyncResponse(): Buffer {
  return encodeWbxml(el('Sync', undefined, [el('Status', SYNC_STATUS.INCOMPLETE_REQUEST)]));
}

/** Original octets for MIME bodies (Type 4) — never the attachment rows of the Sync row. */
export const defaultLoadRaw: LoadRaw = (msg) => {
  const { attachments: _ignored, ...source } = msg;
  return loadRawMessage(source);
};

export interface SyncDeps {
  loadRaw?: LoadRaw;
  now?: () => Date;
}

const log = createLogger('activesync:sync');

/**
 * ApplicationData of one Add (8.0.0). A missing or unreadable raw object (BodyPreference 4
 * = MIME, S/MIME) must not fail the whole Sync with HTTP 500 — the client would retry
 * forever and never get past that folder. Fallback: the stored HTML/text body (no object
 * store access). Only when that fails too is the item left out of this response (logged;
 * it is not recorded as sent).
 */
export async function addProperties(
  msg: EasMessage, pref: BodyPreference, loadRaw: LoadRaw, ctx: { userId: string; collectionId: string },
): Promise<WbxmlElement[] | null> {
  try {
    return await buildEmailProperties(msg, pref, loadRaw);
  } catch (err) {
    log.warn({ err, userId: ctx.userId, collectionId: ctx.collectionId, messageId: msg.id, bodyType: pref.type },
      'EAS Sync: message body not readable — falling back to the stored text/HTML body');
  }
  const fallback: BodyPreference = {
    type: msg.bodyHtml ? 2 : 1,
    allOrNone: pref.allOrNone,
    ...(pref.truncationSize !== undefined ? { truncationSize: pref.truncationSize } : {}),
    ...(pref.preview !== undefined ? { preview: pref.preview } : {}),
  };
  const noRaw: LoadRaw = async () => { throw new Error('raw message not readable'); };
  try {
    return await buildEmailProperties({ ...msg, smimeMeta: null }, fallback, noRaw);
  } catch (err) {
    log.error({ err, userId: ctx.userId, collectionId: ctx.collectionId, messageId: msg.id },
      'EAS Sync: message skipped — properties could not be built');
    return null;
  }
}

/**
 * Sync Options are sticky ([MS-ASCMD] 2.2.3.115.5): a Sync without Options uses the
 * ones the client sent last for that collection. Stored next to the sync key in
 * ActiveSyncDevice.syncKeys under `opts:<collectionId>`.
 */
const OPTIONS_KEY = (collectionId: string) => `opts:${collectionId}`;

export function storedOptions(syncKeys: Record<string, string>, collectionId: string): BodyOptions | null {
  const raw = syncKeys[OPTIONS_KEY(collectionId)];
  if (!raw) return null;
  try { return JSON.parse(raw) as BodyOptions; } catch { return null; }
}

async function attachmentsByMessage(ids: string[]): Promise<Map<string, EasAttachment[]>> {
  const map = new Map<string, EasAttachment[]>();
  if (ids.length === 0) return map;
  const rows = await prisma.attachment.findMany({
    where: { messageId: { in: ids } },
    orderBy: { createdAt: 'asc' },
    select: EAS_ATTACHMENT_SELECT,
  });
  for (const r of rows) {
    const list = map.get(r.messageId) ?? [];
    list.push({ id: r.id, filename: r.filename, mimeType: r.mimeType, size: r.size, contentId: r.contentId, inline: r.inline });
    map.set(r.messageId, list);
  }
  return map;
}

const collectionStatus = (collectionId: string, syncKey: string, status: string) => el('Collection', undefined, [
  el('Class', 'Email'),
  el('SyncKey', syncKey),
  el('CollectionId', collectionId),
  el('Status', status),
]);

interface ClientCommandContext {
  deviceRowId: string | null;
  collectionId: string;
  folderName: string;
  mailboxId: string;
  /** airsync:DeletesAsMoves — absent = 1 ([MS-ASCMD]: deleted items go to Deleted Items). */
  deletesAsMoves: boolean;
}

/**
 * Client Change (Read flag) and Delete. Every change bumps the mailbox modSeq through the
 * message store, so IMAP CONDSTORE / JMAP clients see it too; the device's item state is
 * updated so the change is not echoed back in the response.
 */
async function applyClientCommands(commands: WbxmlElement, ctx: ClientCommandContext): Promise<void> {
  const { deviceRowId, collectionId, mailboxId } = ctx;
  for (const cmd of commands.children ?? []) {
    if (typeof cmd === 'string') continue;
    const serverId = getText(cmd, 'ServerId');
    if (!serverId) continue;

    if (cmd.name === 'Change') {
      const appData = getChild(cmd, 'ApplicationData');
      const readEl = appData ? getChild(appData, 'Read') : undefined;
      if (!readEl) continue;
      const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId, deletedAt: null } });
      if (!msg) continue;
      const flags = readEl.text === '1'
        ? [...msg.flags.filter((f: string) => f !== '\\Seen'), '\\Seen']
        : msg.flags.filter((f: string) => f !== '\\Seen');
      const updated = await prisma.$transaction((tx) => setFlags(tx, [{ id: serverId, flags }], { mailboxId }));
      const modSeq = Array.isArray(updated) ? updated[0]?.modSeq : undefined;
      if (deviceRowId && modSeq !== undefined) await markKnown(deviceRowId, collectionId, [{ serverId, modSeq }]);
    } else if (cmd.name === 'Delete') {
      const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId, deletedAt: null } });
      if (msg) {
        const trash = ctx.deletesAsMoves && ctx.folderName !== 'Trash'
          ? await prisma.folder.findFirst({ where: { mailboxId, name: 'Trash' }, select: { id: true } })
          : null;
        if (trash) {
          await prisma.$transaction((tx) => moveMessages(tx, [serverId], trash.id, { targetMailboxId: mailboxId, sourceMailboxId: mailboxId }));
        } else {
          await prisma.$transaction((tx) => expunge(tx, [serverId], { mailboxId }));
        }
      }
      if (deviceRowId) await forgetItems(deviceRowId, collectionId, [serverId]);
    }
  }
}

/**
 * Known ServerIds that left the collection: expunged or moved in the modSeq range
 * [since, upper), plus items whose row no longer exists at all (tombstones removed by the
 * deleted-items purge, other hard deletes — no modSeq marks those). The returned ids get a
 * `Delete`; its commit removes their item-state rows.
 */
export async function departedItems(
  deviceRowId: string, mailboxId: string, collectionId: string, since: bigint, upper: bigint,
  opts: { includeVanished?: boolean } = {},
): Promise<string[]> {
  const out = new Set<string>();
  if (since < upper) {
    const candidates = await prisma.message.findMany({
      where: {
        folder: { mailboxId },
        modSeq: { gte: since, lt: upper },
        OR: [{ deletedAt: { not: null } }, { folderId: { not: collectionId } }],
      },
      select: { id: true },
    });
    if (candidates.length > 0) {
      for (const id of (await knownItems(deviceRowId, collectionId, candidates.map((c) => c.id))).keys()) out.add(id);
    }
  }
  if (opts.includeVanished !== false) for (const id of await vanishedItems(deviceRowId, collectionId)) out.add(id);
  return [...out];
}

const VANISHED_CHUNK = 1000;

/** Committed ServerIds of the collection whose message row no longer exists (purged). */
export async function vanishedItems(deviceRowId: string, collectionId: string): Promise<string[]> {
  const ids = [...(await knownItems(deviceRowId, collectionId)).keys()];
  const gone: string[] = [];
  for (let i = 0; i < ids.length; i += VANISHED_CHUNK) {
    const chunk = ids.slice(i, i + VANISHED_CHUNK);
    const present = new Set((await prisma.message.findMany({ where: { id: { in: chunk } }, select: { id: true } })).map((r) => r.id));
    for (const id of chunk) if (!present.has(id)) gone.push(id);
  }
  return gone;
}

/**
 * Sync command — bidirectional sync of folder contents.
 *
 * Server → client: `Add` for items the device does not hold, `Change` (Read state) for
 * items it holds at an older modSeq, `Delete` for items it holds that were expunged or
 * moved out of the collection; items it already holds at their current modSeq (its own
 * changes) are not sent. FilterType limits `Add` to the age window.
 */
export async function handleSync(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  deps: SyncDeps = {},
): Promise<Buffer> {
  const loadRaw = deps.loadRaw ?? defaultLoadRaw;
  const now = deps.now ?? (() => new Date());
  const collections = getChild(body, 'Collections');
  if (!collections) {
    return encodeWbxml(el('Sync', undefined, [el('Status', SYNC_STATUS.PROTOCOL_ERROR)]));
  }

  const device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  const deviceRowId = device?.id ?? null;
  const storedSyncKeys: Record<string, string> = { ...((device?.syncKeys as Record<string, string> | null) ?? {}) };
  const syncKeys: Record<string, string> = { ...storedSyncKeys };
  let syncKeysDirty = false;
  // Sync-level WindowSize applies to every collection without its own
  const requestWindow = getText(body, 'WindowSize') || undefined;

  const responseCollections: WbxmlElement[] = [];

  for (const child of collections.children ?? []) {
    if (typeof child === 'string' || child.name !== 'Collection') continue;

    const collectionId = getText(child, 'CollectionId');
    const clientSyncKey = getText(child, 'SyncKey');
    const commands = getChild(child, 'Commands');

    // Verify folder belongs to user
    const folder = await prisma.folder.findFirst({
      where: { id: collectionId, mailbox: { userId } },
    });
    if (!folder) {
      responseCollections.push(collectionStatus(collectionId, clientSyncKey, SYNC_STATUS.OBJECT_NOT_FOUND));
      continue;
    }

    // Body options: from this request, else the sticky ones of the last request.
    const requestOptions = parseBodyOptions(child);
    const previousOptions = storedOptions(syncKeys, collectionId);
    // A changed FilterType changes which items the device holds → resync (Status 3).
    const filterChanged = !!requestOptions && !!previousOptions && requestOptions.filterType !== previousOptions.filterType;
    if (requestOptions) {
      const json = JSON.stringify(requestOptions);
      if (syncKeys[OPTIONS_KEY(collectionId)] !== json) { syncKeys[OPTIONS_KEY(collectionId)] = json; syncKeysDirty = true; }
    }
    const bodyOptions = requestOptions ?? storedOptions(syncKeys, collectionId);

    // SyncKey 0: prime the state only (no Commands) — see PRIMING_SYNC_KEY.
    if (isPrimingSyncKey(clientSyncKey)) {
      syncKeys[collectionId] = PRIMING_SYNC_KEY;
      syncKeys[ACK_KEY(collectionId)] = PRIMING_SYNC_KEY;
      syncKeysDirty = true;
      if (deviceRowId) await resetCollection(deviceRowId, collectionId);
      responseCollections.push(primingCollection(collectionId));
      continue;
    }

    if (filterChanged) {
      responseCollections.push(collectionStatus(collectionId, '0', SYNC_STATUS.INVALID_SYNC_KEY));
      continue;
    }

    // The key must be the last issued (acknowledges that response) or the last
    // acknowledged one (retry after a lost response); anything else → Status 3.
    if (deviceRowId) {
      const ok = await acknowledgeSyncKey(deviceRowId, collectionId, clientSyncKey, syncKeys);
      syncKeysDirty = true;
      if (!ok) {
        responseCollections.push(collectionStatus(collectionId, '0', SYNC_STATUS.INVALID_SYNC_KEY));
        continue;
      }
    }

    const mailboxId = folder.mailboxId;
    if (commands) {
      await applyClientCommands(commands, {
        deviceRowId, collectionId, mailboxId, folderName: folder.name,
        deletesAsMoves: getText(child, 'DeletesAsMoves') !== '0',
      });
    }

    // Legacy rows may carry Date.now()-sized modSeqs: lift the counter first so the
    // window bound below covers them (one-time per mailbox and process).
    await ensureCounterFloor(prisma, mailboxId);

    // Delta selection on the mailbox modSeq counter (the sync key is a modSeq bound).
    const window = await loadSyncWindow(prisma as unknown as SyncWindowDb, {
      mailboxId, folderId: collectionId, clientSyncKey,
      windowSize: parseWindowSize(getText(child, 'WindowSize') || requestWindow),
    });
    if (window.status === 'invalid') {
      // Status 3: invalid synchronization key → client restarts with SyncKey 0
      responseCollections.push(collectionStatus(collectionId, '0', SYNC_STATUS.INVALID_SYNC_KEY));
      continue;
    }
    const { messages, newSyncKey, moreAvailable } = window;
    syncKeys[collectionId] = newSyncKey;
    syncKeysDirty = true;

    const known = deviceRowId ? await knownItems(deviceRowId, collectionId, messages.map((m) => m.id)) : new Map<string, bigint>();
    const cutoff = filterCutoff(bodyOptions?.filterType, now());
    const adds = messages.filter((m) => !known.has(m.id) && !(cutoff && m.date < cutoff));
    const changes = messages.filter((m) => { const k = known.get(m.id); return k !== undefined && k < m.modSeq; });
    const departed = deviceRowId
      ? await departedItems(deviceRowId, mailboxId, collectionId, BigInt(clientSyncKey), BigInt(newSyncKey), { includeVanished: false })
      : [];
    // Purged rows: no modSeq marks them, so the SyncKey may not change — the Delete is
    // sent and the item-state rows are removed right away (not via the pending state).
    const vanished = deviceRowId ? (await vanishedItems(deviceRowId, collectionId)).filter((id) => !departed.includes(id)) : [];
    const deletes = [...departed, ...vanished];

    const attachments = await attachmentsByMessage(adds.map((m) => m.id));
    const serverCommands: WbxmlElement[] = [];
    const skipped = new Set<string>();
    for (const row of adds) {
      const { modSeq: _modSeq, ...cols } = row;
      const msg: EasMessage = { ...cols, attachments: attachments.get(row.id) ?? [] };
      const pref = chooseBodyPreference(bodyOptions, msg);
      const props = await addProperties(msg, pref, loadRaw, { userId, collectionId });
      if (!props) { skipped.add(msg.id); continue; }
      serverCommands.push(el('Add', undefined, [
        el('ServerId', msg.id),
        el('ApplicationData', undefined, props),
      ]));
    }
    for (const row of changes) {
      serverCommands.push(el('Change', undefined, [
        el('ServerId', row.id),
        el('ApplicationData', undefined, [pel(CP.Email, 'Read', row.flags.includes('\\Seen') ? '1' : '0')]),
      ]));
    }
    for (const id of deletes) serverCommands.push(el('Delete', undefined, [el('ServerId', id)]));

    if (deviceRowId) {
      await recordPending(deviceRowId, collectionId, newSyncKey, [
        ...[...adds.filter((m) => !skipped.has(m.id)), ...changes].map((m) => ({ serverId: m.id, modSeq: m.modSeq })),
        ...departed.map((id) => ({ serverId: id, modSeq: null })),
      ]);
      await forgetItems(deviceRowId, collectionId, vanished);
    }

    responseCollections.push(el('Collection', undefined, [
      el('Class', 'Email'),
      el('SyncKey', newSyncKey),
      el('CollectionId', collectionId),
      el('Status', SYNC_STATUS.SUCCESS),
      ...(moreAvailable ? [el('MoreAvailable', '')] : []),
      ...(serverCommands.length > 0 ? [el('Commands', undefined, serverCommands)] : []),
    ]));
  }

  if (device && syncKeysDirty) {
    // 8.0.0: only the keys this request changed, merged atomically — a parallel Sync of
    // another folder, a FolderSync or a Ping keeps its own keys (no stale write-back).
    await mergeSyncKeys(device.id, changedSyncKeys(storedSyncKeys, syncKeys), { lastSyncAt: new Date() });
  }

  return encodeWbxml(el('Sync', undefined, [
    el('Collections', undefined, responseCollections),
  ]));
}
