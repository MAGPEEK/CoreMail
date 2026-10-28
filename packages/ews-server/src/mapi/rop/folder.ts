/**
 * Folder ROP handler (v4.1.0)
 *
 * Implements:
 *   - RopOpenFolder          (MS-OXCFOLD §2.2.1.1)
 *   - RopGetHierarchyTable   (MS-OXCFOLD §2.2.1.13)
 *   - RopGetContentsTable    (MS-OXCFOLD §2.2.1.14) — stub (returns an empty table)
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex,
} from '../rop-handle-table.js';
import { cuidToFolderId64 } from '../entry-id.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:folder');

/**
 * RopOpenFolder
 */
export async function handleRopOpenFolder(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  // Input: mailbox or folder handle
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeOpenFolderError(rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Parse payload: FolderId (uint64) + OpenModeFlags (uint8)
  const r = new MapiReader(rop.payload);
  const folderId64 = r.readUint64();
  // const openModeFlags = r.readUint8(); // currently ignored

  // Look up the folder in the DB — we match via the 64-bit hash
  const userId = input.object.kind === 'mailbox'
    ? input.object.userId
    : input.object.kind === 'folder'
    ? input.object.userId
    : null;
  if (!userId) {
    return writeOpenFolderError(rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }

  const folders = await prisma.folder.findMany({
    where: {
      mailbox: { userId },
    },
    select: { id: true, name: true, displayName: true, totalCount: true, unreadCount: true,
              parentId: true },
  });
  let folder = folders.find((f) => cuidToFolderId64(f.id) === folderId64) as
    | { id: string; name: string } | undefined;

  // v4.6.0: Also match virtual PIM folders
  if (!folder) {
    const vf = VIRTUAL_FOLDERS.find((v) => cuidToFolderId64(v.id) === folderId64);
    if (vf) folder = { id: vf.id, name: vf.name };
  }

  if (!folder) {
    log.warn({ folderId64: folderId64.toString(16), userId }, 'RopOpenFolder: Folder nicht gefunden');
    return writeOpenFolderError(rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Register the folder handle in the table (v4.6.0: containerClass added dynamically)
  const handle = await putRopObject(sessionToken, {
    kind: 'folder',
    userId,
    folderId: folder.id,
    folderName: folder.name,
  });
  if (handle === null) {
    return writeOpenFolderError(rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response (MS-OXCFOLD §2.2.1.1.2):
  //   RopId(1), OutputHandleIndex(1), ReturnValue(4), HasRules(1), IsGhosted(1)
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenFolder);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0); // HasRules
  w.writeUint8(0); // IsGhosted
  return w.toBuffer();
}

/**
 * v4.6.0: Virtual PIM folders. CoreMail does NOT store Calendar/Contacts/Tasks
 * as mailbox folders (separate Prisma models), but Outlook MAPI needs
 * them as folder entries in the hierarchy table so the user sees them.
 *
 * We synthesize them with fixed "virtual-*" IDs and auto-generate their
 * property rows. OpenFolder on a virtual ID detects this and creates a
 * folder handle with a special folderName that is evaluated by
 * QueryRows.
 */
export const VIRTUAL_FOLDERS = [
  { id: 'virtual-calendar',   name: 'Kalender',  displayName: 'Kalender',  containerClass: 'IPF.Appointment' },
  { id: 'virtual-contacts',   name: 'Kontakte',  displayName: 'Kontakte',  containerClass: 'IPF.Contact' },
  { id: 'virtual-tasks',      name: 'Aufgaben',  displayName: 'Aufgaben',  containerClass: 'IPF.Task' },
  { id: 'virtual-notes',      name: 'Notizen',   displayName: 'Notizen',   containerClass: 'IPF.StickyNote' },
] as const;

export function isVirtualFolderId(id: string): boolean {
  return id.startsWith('virtual-');
}

/**
 * v4.6.0: Maps a folder name to an Outlook MAPI container class.
 *
 * Outlook uses PR_CONTAINER_CLASS_W (0x3613001F) to detect the folder type —
 * from it follow the icon, the default view (mail/calendar/contacts),
 * and the editor behavior. Values (MS-OXOSFLD §2.2.3):
 *   "IPF.Note"        — mail (default)
 *   "IPF.Appointment" — calendar
 *   "IPF.Contact"     — contacts
 *   "IPF.Task"        — tasks
 *   "IPF.StickyNote"  — notes
 *   "IPF.Journal"     — journal
 *
 * We match both the English and the German standard names case-insensitively
 * (Outlook checks the class string, not the folder name).
 */
export function containerClassFor(folderName: string): string {
  const n = folderName.toLowerCase();
  if (n === 'calendar' || n === 'kalender')               return 'IPF.Appointment';
  if (n === 'contacts' || n === 'kontakte')               return 'IPF.Contact';
  if (n === 'tasks'    || n === 'aufgaben')               return 'IPF.Task';
  if (n === 'notes'    || n === 'notizen')                return 'IPF.StickyNote';
  if (n === 'journal'  || n === 'journal')                return 'IPF.Journal';
  return 'IPF.Note';                                       // Default: Mail
}

function writeOpenFolderError(rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenFolder);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

/**
 * RopGetHierarchyTable: creates a table object over the subfolders.
 */
export async function handleRopGetHierarchyTable(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || (input.object.kind !== 'mailbox' && input.object.kind !== 'folder')) {
    return writeTableError(RopId.GetHierarchyTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.userId;
  const parentFolderId = input.object.kind === 'folder' ? input.object.folderId : '';

  // Count direct subfolders (+ virtual PIM folders at root level)
  let rowCount = await prisma.folder.count({
    where: {
      mailbox: { userId },
      parentId: parentFolderId === '' ? null : parentFolderId,
    },
  }).catch(() => 0);
  // v4.6.0: Count virtual folders only at root level (mailbox handle)
  if (parentFolderId === '') {
    rowCount += VIRTUAL_FOLDERS.length;
  }

  const tableHandle = await putRopObject(sessionToken, {
    kind: 'table', userId, tableType: 'hierarchy', parentFolderId,
  });
  if (tableHandle === null) {
    return writeTableError(RopId.GetHierarchyTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response: RopId, OutputHandleIndex, ReturnValue, RowCount
  const w = new MapiWriter();
  w.writeUint8(RopId.GetHierarchyTable);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(rowCount);
  return w.toBuffer();
}

/**
 * RopGetContentsTable: mail list in the folder. v4.1.0 stub (rowCount = 0).
 * Full implementation in v4.2.0.
 */
export async function handleRopGetContentsTable(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'folder') {
    return writeTableError(RopId.GetContentsTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // v4.6.0: Virtual folders → their own counts
  let rowCount = 0;
  if (isVirtualFolderId(input.object.folderId)) {
    switch (input.object.folderId) {
      case 'virtual-calendar':
        rowCount = await prisma.calendarEvent.count({
          where: { calendar: { userId: input.object.userId } },
        }).catch(() => 0);
        break;
      case 'virtual-contacts':
        rowCount = await prisma.contact.count({
          where: { userId: input.object.userId },
        }).catch(() => 0);
        break;
      case 'virtual-tasks':
        rowCount = await prisma.task.count({
          where: { userId: input.object.userId },
        }).catch(() => 0);
        break;
      case 'virtual-notes':
        rowCount = await prisma.note.count({
          where: { userId: input.object.userId },
        }).catch(() => 0);
        break;
    }
  } else {
    rowCount = await prisma.message.count({
      where: { folderId: input.object.folderId },
    }).catch(() => 0);
  }

  const tableHandle = await putRopObject(sessionToken, {
    kind: 'table', userId: input.object.userId,
    tableType: 'contents', parentFolderId: input.object.folderId,
  });
  if (tableHandle === null) {
    return writeTableError(RopId.GetContentsTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.GetContentsTable);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(rowCount);
  return w.toBuffer();
}

function writeTableError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
