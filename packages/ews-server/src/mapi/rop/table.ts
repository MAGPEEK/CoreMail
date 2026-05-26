/**
 * Table-ROP-Handler (v4.1.0)
 *
 * Implementiert:
 *   - RopSetColumns   (MS-OXCTABL §2.2.2.2) — wählt Spalten der Tabelle
 *   - RopQueryRows    (MS-OXCTABL §2.2.2.7) — holt Zeilen
 *   - RopGetRowCount  — gibt Anzahl Zeilen zurück
 *   - RopRelease      (MS-OXCROPS §2.2.15.3) — schließt Object
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, makePropTag, PropType } from '../rop-types.js';
import { writePropertyRow } from '../property-codec.js';
import {
  releaseRopObject, resolveHandleIndex,
} from '../rop-handle-table.js';
import { cuidToFolderId64 } from '../entry-id.js';
import type { RopRequest } from '../rop-codec.js';
import type { RopObject } from '../rop-handle-table.js';

const log = createLogger('mapi:rop:table');

/**
 * RopSetColumns
 *
 * Speichert die gewählten PropertyTags im Table-Object für nachfolgende
 * QueryRows. v4.1.0: persistieren wir in der Session-State HandleTable.
 */
export async function handleRopSetColumns(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'table') {
    return writeError(RopId.SetColumns, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  r.readUint8(); // TableFlags
  const tagCount = r.readUint16();
  const columns: number[] = [];
  for (let i = 0; i < tagCount; i++) {
    columns.push(r.readUint32());
  }

  // Columns in der Handle-Table speichern (mutate + persist)
  const updated: RopObject = { ...input.object, columns };
  await persistHandle(sessionToken, input.handle, updated);

  log.debug({ tableHandle: input.handle, columnCount: columns.length }, 'RopSetColumns');

  // Response: TableStatus (0 = complete)
  const w = new MapiWriter();
  w.writeUint8(RopId.SetColumns);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0); // TableStatus = TBLSTAT_COMPLETE
  return w.toBuffer();
}

/**
 * RopQueryRows
 */
export async function handleRopQueryRows(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'table') {
    return writeError(RopId.QueryRows, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  r.readUint8();        // QueryRowsFlags
  r.readUint8();        // ForwardRead
  const rowCount = r.readUint16();

  const tableObj = input.object;
  if (tableObj.kind !== 'table') {
    return writeError(RopId.QueryRows, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const columns = tableObj.columns ?? defaultHierarchyColumns();

  // Rows aus DB laden (je nach tableType)
  let rows: Map<number, unknown>[] = [];
  if (tableObj.tableType === 'hierarchy') {
    const folders = await prisma.folder.findMany({
      where: {
        mailbox: { userId: tableObj.userId },
        parentId: tableObj.parentFolderId === '' ? null : tableObj.parentFolderId,
      },
      select: { id: true, name: true, displayName: true, totalCount: true, unreadCount: true,
                createdAt: true },
      take: rowCount,
    }).catch(() => []);
    rows = folders.map((f) => folderToPropRow({ ...f, updatedAt: f.createdAt }, tableObj.parentFolderId));
  } else if (tableObj.tableType === 'contents') {
    const messages = await prisma.message.findMany({
      where: { folderId: tableObj.parentFolderId },
      select: { id: true, subject: true, fromAddr: true, fromName: true, date: true,
                rawSize: true, flags: true },
      take: rowCount,
      orderBy: [{ date: 'desc' }],
    }).catch(() => []);
    rows = messages.map((m) => messageToPropRow(m));
  }

  // Response zusammenbauen
  const w = new MapiWriter();
  w.writeUint8(RopId.QueryRows);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0); // Origin = BOOKMARK_BEGINNING
  w.writeUint16(rows.length); // RowCount
  for (const row of rows) {
    writePropertyRow(w, columns, row);
  }
  return w.toBuffer();
}

/**
 * RopGetRowCount
 */
export async function handleRopGetRowCount(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'table') {
    return writeError(RopId.GetRowCount, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const tableObj = input.object;
  let count = 0;
  if (tableObj.tableType === 'hierarchy') {
    count = await prisma.folder.count({
      where: {
        mailbox: { userId: tableObj.userId },
        parentId: tableObj.parentFolderId === '' ? null : tableObj.parentFolderId,
      },
    }).catch(() => 0);
  } else {
    count = await prisma.message.count({
      where: { folderId: tableObj.parentFolderId },
    }).catch(() => 0);
  }
  const w = new MapiWriter();
  w.writeUint8(RopId.GetRowCount);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(count);
  return w.toBuffer();
}

/**
 * RopRelease — schließt ein Object.
 */
export async function handleRopRelease(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (input) {
    await releaseRopObject(sessionToken, input.handle);
  }
  // RopRelease hat keine Response (MS-OXCROPS §2.2.15.3)
  // — wir geben einen leeren Buffer zurück (Dispatcher ignoriert das).
  return Buffer.alloc(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultHierarchyColumns(): number[] {
  return [
    PR.PR_DISPLAY_NAME_W,
    PR.PR_FOLDER_ID,
    PR.PR_CONTENT_COUNT,
    PR.PR_CONTENT_UNREAD,
    PR.PR_SUBFOLDERS,
  ];
}

interface FolderRecord {
  id: string;
  name: string;
  displayName: string;
  totalCount: number;
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function folderToPropRow(f: FolderRecord, _parentFolderId: string): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_DISPLAY_NAME_W, f.displayName);
  m.set(PR.PR_FOLDER_ID, cuidToFolderId64(f.id));
  m.set(PR.PR_CONTENT_COUNT, f.totalCount);
  m.set(PR.PR_CONTENT_UNREAD, f.unreadCount);
  m.set(PR.PR_SUBFOLDERS, false);
  m.set(PR.PR_CONTAINER_CLASS_W, 'IPF.Note');
  m.set(PR.PR_LAST_MODIFICATION_TIME, f.updatedAt);
  m.set(PR.PR_CREATION_TIME, f.createdAt);
  return m;
}

interface MessageRecord {
  id: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  date: Date;
  rawSize: number | bigint;
  flags: string[];
}

function messageToPropRow(msg: MessageRecord): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, msg.subject);
  m.set(PR.PR_SENDER_NAME_W, msg.fromName || msg.fromAddr);
  m.set(PR.PR_SENDER_EMAIL_ADDRESS_W, msg.fromAddr);
  m.set(PR.PR_MESSAGE_DELIVERY_TIME, msg.date);
  m.set(PR.PR_MESSAGE_SIZE, typeof msg.rawSize === 'bigint' ? Number(msg.rawSize) : msg.rawSize);
  m.set(PR.PR_MESSAGE_FLAGS, msg.flags.includes('\\Seen') ? 0x01 : 0x00);
  return m;
}

function writeError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.inputHandleIndex ?? rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

// Suppress unused-import warnings for tags we'll need in later phases.
void makePropTag; void PropType;

/**
 * Persistiert ein Object zurück in die Session-HandleTable (für Updates wie
 * RopSetColumns die das Object mutieren).
 */
async function persistHandle(token: string, handle: number, obj: RopObject): Promise<void> {
  const { getRedisClient } = await import('@coremail/core');
  const redis = getRedisClient();
  const KEY = `mapi:session:${token}`;
  const raw = await redis.get(KEY);
  if (!raw) return;
  const state = JSON.parse(raw);
  state.handleTable[handle] = obj;
  state.lastSeen = Date.now();
  await redis.set(KEY, JSON.stringify(state), 'EX', 600);
}
