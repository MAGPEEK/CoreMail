import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getText, type WbxmlElement } from '../wbxml.js';

// EAS folder type codes
const FOLDER_TYPES: Record<string, string> = {
  INBOX: '2',     // DefaultInbox
  Drafts: '3',    // DefaultDrafts
  Trash: '4',     // DefaultDeleted
  Sent: '5',      // DefaultSent
  Junk: '12',     // DefaultJunk
};

/**
 * FolderSync command — synchronizes folder hierarchy to device
 */
export async function handleFolderSync(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
): Promise<Buffer> {
  const clientSyncKey = getText(body, 'SyncKey');

  // Find mailbox
  const mailbox = await prisma.mailbox.findFirst({
    where: { userId },
    include: {
      folders: {
        select: { id: true, name: true, displayName: true, parentId: true },
      },
    },
  });

  if (!mailbox) {
    return encodeWbxml(el('FolderSync', undefined, [
      el('Status', '9'), // Server error
    ]));
  }

  // Get device for current sync key
  const device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });

  const isInitialSync = clientSyncKey === '0' || !clientSyncKey;
  const newSyncKey = String(Date.now());

  // Save new sync key to device
  if (device) {
    await prisma.activeSyncDevice.update({
      where: { id: device.id },
      data: { folderSyncKey: newSyncKey, lastSyncAt: new Date() },
    });
  }

  const changes: WbxmlElement[] = [];

  if (isInitialSync) {
    // Return all folders on initial sync
    for (const folder of mailbox.folders) {
      const folderType = FOLDER_TYPES[folder.name] ?? '12'; // 12 = user-created mail folder
      changes.push(el('Add', undefined, [
        el('ServerId', folder.id),
        el('ParentId', folder.parentId ?? '0'),
        el('DisplayName', folder.displayName),
        el('Type', folderType),
      ]));
    }
  }
  // Incremental sync: in a full implementation, return only changed folders
  // For now, return empty changes (no server-side folder changes tracked)

  const response: WbxmlElement = el('FolderSync', undefined, [
    el('Status', '1'),
    el('SyncKey', newSyncKey),
    el('Changes', undefined, [
      el('Count', String(changes.length)),
      ...changes,
    ]),
  ]);

  return encodeWbxml(response);
}
