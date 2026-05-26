/**
 * Folder-ROP-Handler (v4.1.0)
 *
 * Implementiert:
 *   - RopOpenFolder          (MS-OXCFOLD §2.2.1.1)
 *   - RopGetHierarchyTable   (MS-OXCFOLD §2.2.1.13)
 *   - RopGetContentsTable    (MS-OXCFOLD §2.2.1.14) — Stub (returnt leere Tabelle)
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
  // Input: Mailbox- oder Folder-Handle
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeOpenFolderError(rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Payload parsen: FolderId (uint64) + OpenModeFlags (uint8)
  const r = new MapiReader(rop.payload);
  const folderId64 = r.readUint64();
  // const openModeFlags = r.readUint8(); // aktuell ignoriert

  // Folder im DB suchen — wir matchen über den 64-Bit-Hash
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
  const folder = folders.find((f) => cuidToFolderId64(f.id) === folderId64);
  if (!folder) {
    log.warn({ folderId64: folderId64.toString(16), userId }, 'RopOpenFolder: Folder nicht gefunden');
    return writeOpenFolderError(rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Folder-Handle in der Tabelle eintragen
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

function writeOpenFolderError(rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenFolder);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

/**
 * RopGetHierarchyTable: erstellt ein Table-Object über die Sub-Folder.
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

  // Zähle direkte Sub-Folder
  const rowCount = await prisma.folder.count({
    where: {
      mailbox: { userId },
      parentId: parentFolderId === '' ? null : parentFolderId,
    },
  }).catch(() => 0);

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
 * RopGetContentsTable: Mail-Liste im Folder. v4.1.0 Stub (rowCount = 0).
 * Volle Implementation in v4.2.0.
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

  // Zähle Messages — aber sie werden in v4.1.0 noch nicht via QueryRows
  // ausgeliefert. Outlook sieht eine "Tabelle mit N Zeilen", QueryRows
  // returnt aber leere Rows. v4.2.0 füllt es auf.
  const rowCount = await prisma.message.count({
    where: { folderId: input.object.folderId },
  }).catch(() => 0);

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
