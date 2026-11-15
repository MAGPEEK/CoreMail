import { prisma } from '@coremail/storage/prisma';
import { setFlags, expunge, ensureCounterFloor, loadRawMessage } from '@coremail/storage';
import { encodeWbxml, el, getText, getChild, type WbxmlElement } from '../wbxml.js';
import { loadSyncWindow, isPrimingSyncKey, parseWindowSize, PRIMING_SYNC_KEY, type SyncWindowDb } from './sync-window.js';
import {
  parseBodyOptions, chooseBodyPreference, buildEmailProperties, EAS_ATTACHMENT_SELECT,
  type BodyOptions, type EasAttachment, type EasMessage, type LoadRaw,
} from './body.js';

/** Response collection for a SyncKey-0 request: new key, Status 1, no Commands. */
export function primingCollection(collectionId: string): WbxmlElement {
  return el('Collection', undefined, [
    el('Class', 'Email'),
    el('SyncKey', PRIMING_SYNC_KEY),
    el('CollectionId', collectionId),
    el('Status', '1'),
  ]);
}

/** Original octets for MIME bodies (Type 4) — never the attachment rows of the Sync row. */
export const defaultLoadRaw: LoadRaw = (msg) => {
  const { attachments: _ignored, ...source } = msg;
  return loadRawMessage(source);
};

export interface SyncDeps {
  loadRaw?: LoadRaw;
}

/**
 * Sync Options are sticky ([MS-ASCMD] 2.2.3.115.5): a Sync without Options uses the
 * ones the client sent last for that collection. Stored next to the sync key in
 * ActiveSyncDevice.syncKeys under `opts:<collectionId>`.
 */
const OPTIONS_KEY = (collectionId: string) => `opts:${collectionId}`;

function storedOptions(syncKeys: Record<string, string>, collectionId: string): BodyOptions | null {
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

/**
 * Sync command — bidirectional sync of folder contents
 */
export async function handleSync(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
  deps: SyncDeps = {},
): Promise<Buffer> {
  const loadRaw = deps.loadRaw ?? defaultLoadRaw;
  const collections = getChild(body, 'Collections');
  if (!collections) {
    return encodeWbxml(el('Sync', undefined, [el('Status', '4')]));
  }

  const device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  const syncKeys: Record<string, string> = { ...((device?.syncKeys as Record<string, string> | null) ?? {}) };
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
      responseCollections.push(el('Collection', undefined, [
        el('Class', 'Email'),
        el('SyncKey', clientSyncKey),
        el('CollectionId', collectionId),
        el('Status', '8'), // object not found
      ]));
      continue;
    }

    // Body options: from this request, else the sticky ones of the last request.
    const requestOptions = parseBodyOptions(child);
    if (requestOptions) {
      const json = JSON.stringify(requestOptions);
      if (syncKeys[OPTIONS_KEY(collectionId)] !== json) { syncKeys[OPTIONS_KEY(collectionId)] = json; syncKeysDirty = true; }
    }
    const bodyOptions = requestOptions ?? storedOptions(syncKeys, collectionId);

    // SyncKey 0: prime the state only (no Commands) — see PRIMING_SYNC_KEY.
    if (isPrimingSyncKey(clientSyncKey)) {
      syncKeys[collectionId] = PRIMING_SYNC_KEY;
      syncKeysDirty = true;
      responseCollections.push(primingCollection(collectionId));
      continue;
    }

    // Process client commands (Read, Delete) — every change bumps the mailbox
    // modSeq through the message store, so other clients (IMAP CONDSTORE, JMAP)
    // see it as well.
    const mailboxId = folder.mailboxId;
    if (commands) {
      for (const cmd of commands.children ?? []) {
        if (typeof cmd === 'string') continue;

        if (cmd.name === 'Change') {
          const serverId = getText(cmd, 'ServerId');
          const appData = getChild(cmd, 'ApplicationData');
          const readEl = appData ? getChild(appData, 'Read') : undefined;
          if (readEl) {
            const readFlag = readEl.text ?? '';
            const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId } });
            if (msg) {
              const flags = readFlag === '1'
                ? [...msg.flags.filter((f: string) => f !== '\\Seen'), '\\Seen']
                : msg.flags.filter((f: string) => f !== '\\Seen');
              await prisma.$transaction((tx) => setFlags(tx, [{ id: serverId, flags }], { mailboxId }));
            }
          }
        } else if (cmd.name === 'Delete') {
          const serverId = getText(cmd, 'ServerId');
          const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId } });
          if (msg) {
            await prisma.$transaction((tx) => expunge(tx, [serverId], { mailboxId }));
          }
        }
      }
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
      responseCollections.push(el('Collection', undefined, [
        el('Class', 'Email'),
        el('SyncKey', '0'),
        el('CollectionId', collectionId),
        el('Status', '3'),
      ]));
      continue;
    }
    const { messages, newSyncKey, moreAvailable } = window;
    syncKeys[collectionId] = newSyncKey;
    syncKeysDirty = true;

    const attachments = await attachmentsByMessage(messages.map((m) => m.id));
    const serverCommands: WbxmlElement[] = [];
    for (const row of messages) {
      const { modSeq: _modSeq, ...cols } = row;
      const msg: EasMessage = { ...cols, attachments: attachments.get(row.id) ?? [] };
      const pref = chooseBodyPreference(bodyOptions, msg);
      serverCommands.push(el('Add', undefined, [
        el('ServerId', msg.id),
        el('ApplicationData', undefined, await buildEmailProperties(msg, pref, loadRaw)),
      ]));
    }

    responseCollections.push(el('Collection', undefined, [
      el('Class', 'Email'),
      el('SyncKey', newSyncKey),
      el('CollectionId', collectionId),
      el('Status', '1'),
      ...(moreAvailable ? [el('MoreAvailable', '')] : []),
      ...(serverCommands.length > 0 ? [el('Commands', undefined, serverCommands)] : []),
    ]));
  }

  if (device && syncKeysDirty) {
    await prisma.activeSyncDevice.update({
      where: { id: device.id },
      data: { syncKeys, lastSyncAt: new Date() },
    });
  }

  return encodeWbxml(el('Sync', undefined, [
    el('Collections', undefined, responseCollections),
  ]));
}
