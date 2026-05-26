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
import { containerClassFor, VIRTUAL_FOLDERS } from './folder.js';
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

    // v4.6.0: Virtuelle PIM-Folder auf Root-Ebene injizieren
    if (tableObj.parentFolderId === '' && rows.length < rowCount) {
      for (const vf of VIRTUAL_FOLDERS) {
        rows.push(virtualFolderToPropRow(vf, tableObj.userId));
        if (rows.length >= rowCount) break;
      }
    }
  } else if (tableObj.tableType === 'contents') {
    // v4.6.0: Virtuelle PIM-Folder
    if (tableObj.parentFolderId.startsWith('virtual-')) {
      rows = await loadVirtualContents(tableObj.parentFolderId, tableObj.userId, rowCount);
    } else {
      const messages = await prisma.message.findMany({
        where: { folderId: tableObj.parentFolderId },
        select: { id: true, subject: true, fromAddr: true, fromName: true, date: true,
                  rawSize: true, flags: true },
        take: rowCount,
        orderBy: [{ date: 'desc' }],
      }).catch(() => []);
      rows = messages.map((m) => messageToPropRow(m));
    }
  } else if (tableObj.tableType === 'attachments') {
    // v4.4.0: parentFolderId enthält tatsächlich die MessageId
    const attachments = await prisma.attachment.findMany({
      where: { messageId: tableObj.parentFolderId },
      select: { id: true, filename: true, mimeType: true, size: true, contentId: true,
                inline: true, createdAt: true },
      take: rowCount,
      orderBy: [{ createdAt: 'asc' }],
    }).catch(() => []);
    rows = attachments.map((a, idx) => attachmentToPropRow(a, idx));
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
  } else if (tableObj.tableType === 'attachments') {
    count = await prisma.attachment.count({
      where: { messageId: tableObj.parentFolderId },
    }).catch(() => 0);
  } else if (tableObj.parentFolderId.startsWith('virtual-')) {
    // v4.6.0: Virtuelle PIM-Contents-Counts
    switch (tableObj.parentFolderId) {
      case 'virtual-calendar':
        count = await prisma.calendarEvent.count({ where: { calendar: { userId: tableObj.userId } } }).catch(() => 0);
        break;
      case 'virtual-contacts':
        count = await prisma.contact.count({ where: { userId: tableObj.userId } }).catch(() => 0);
        break;
      case 'virtual-tasks':
        count = await prisma.task.count({ where: { userId: tableObj.userId } }).catch(() => 0);
        break;
      case 'virtual-notes':
        count = await prisma.note.count({ where: { userId: tableObj.userId } }).catch(() => 0);
        break;
    }
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
  m.set(PR.PR_CONTAINER_CLASS_W, containerClassFor(f.name));
  m.set(PR.PR_LAST_MODIFICATION_TIME, f.updatedAt);
  m.set(PR.PR_CREATION_TIME, f.createdAt);
  return m;
}

/**
 * v4.6.0: Property-Row für virtuelle PIM-Folder (Calendar/Contacts/Tasks/Notes).
 */
function virtualFolderToPropRow(
  vf: { id: string; name: string; displayName: string; containerClass: string },
  _userId: string,
): Map<number, unknown> {
  const now = new Date();
  const m = new Map<number, unknown>();
  m.set(PR.PR_DISPLAY_NAME_W, vf.displayName);
  m.set(PR.PR_FOLDER_ID, cuidToFolderId64(vf.id));
  m.set(PR.PR_CONTENT_COUNT, 0);     // wird per QueryRows on-demand bestimmt
  m.set(PR.PR_CONTENT_UNREAD, 0);
  m.set(PR.PR_SUBFOLDERS, false);
  m.set(PR.PR_CONTAINER_CLASS_W, vf.containerClass);
  m.set(PR.PR_LAST_MODIFICATION_TIME, now);
  m.set(PR.PR_CREATION_TIME, now);
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

interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  createdAt: Date;
}

function attachmentToPropRow(a: AttachmentRecord, idx: number): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_ATTACH_NUM, idx);
  m.set(PR.PR_ATTACH_LONG_FILENAME_W, a.filename);
  m.set(PR.PR_ATTACH_FILENAME_W, a.filename);
  m.set(PR.PR_DISPLAY_NAME_W, a.filename);
  m.set(PR.PR_ATTACH_MIME_TAG_W, a.mimeType);
  m.set(PR.PR_ATTACH_SIZE, a.size);
  m.set(PR.PR_ATTACH_METHOD, 1);  // afByValue (Inline-Daten via OpenStream)
  if (a.contentId) m.set(PR.PR_ATTACH_CONTENT_ID_W, a.contentId);
  return m;
}

// ── v4.6.0 — Virtuelle PIM-Folder Contents-Loader ───────────────────────────

async function loadVirtualContents(
  virtualId: string,
  userId: string,
  rowCount: number,
): Promise<Map<number, unknown>[]> {
  switch (virtualId) {
    case 'virtual-calendar': {
      const events = await prisma.calendarEvent.findMany({
        where: { calendar: { userId } },
        select: { id: true, summary: true, description: true, location: true,
                  dtStart: true, dtEnd: true, organizer: true, allDay: true },
        take: rowCount,
        orderBy: [{ dtStart: 'desc' }],
      }).catch(() => []);
      return events.map((e) => calendarEventToPropRow(e));
    }
    case 'virtual-contacts': {
      const contacts = await prisma.contact.findMany({
        where: { userId },
        select: { id: true, displayName: true, email: true, phone: true,
                  company: true, jobTitle: true },
        take: rowCount,
        orderBy: [{ displayName: 'asc' }],
      }).catch(() => []);
      return contacts.map((c) => contactToPropRow(c));
    }
    case 'virtual-tasks': {
      const tasks = await prisma.task.findMany({
        where: { userId },
        select: { id: true, subject: true, body: true, dueDate: true,
                  completedAt: true, priority: true, createdAt: true, status: true },
        take: rowCount,
        orderBy: [{ createdAt: 'desc' }],
      }).catch(() => []);
      return tasks.map((t) => taskToPropRow({
        id: t.id, subject: t.subject, body: t.body,
        dueDate: t.dueDate,
        completed: t.completedAt !== null || t.status === 'COMPLETED',
        priority: parseInt(t.priority, 10) || 0,
        createdAt: t.createdAt,
      }));
    }
    case 'virtual-notes': {
      const notes = await prisma.note.findMany({
        where: { userId },
        select: { id: true, subject: true, body: true, createdAt: true,
                  updatedAt: true },
        take: rowCount,
        orderBy: [{ updatedAt: 'desc' }],
      }).catch(() => []);
      return notes.map((n) => noteToPropRow(n));
    }
  }
  return [];
}

function calendarEventToPropRow(e: {
  id: string; summary: string; description: string; location: string;
  dtStart: Date; dtEnd: Date; organizer: string | null; allDay: boolean;
}): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, e.summary);
  m.set(PR.PR_BODY_W, e.description);
  m.set(PR.PR_MESSAGE_CLASS_W, 'IPM.Appointment');
  m.set(PR.PR_MESSAGE_DELIVERY_TIME, e.dtStart);
  m.set(PR.PR_CLIENT_SUBMIT_TIME, e.dtStart);
  m.set(PR.PR_CREATION_TIME, e.dtStart);
  m.set(PR.PR_LAST_MODIFICATION_TIME, e.dtEnd);
  m.set(PR.PR_MESSAGE_SIZE, (e.summary.length + e.description.length) * 2);
  m.set(PR.PR_MESSAGE_FLAGS, 0x01);  // Read
  return m;
}

function contactToPropRow(c: {
  id: string; displayName: string; email: string; phone: string;
  company: string; jobTitle: string;
}): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, c.displayName);
  m.set(PR.PR_DISPLAY_NAME_W, c.displayName);
  m.set(PR.PR_SENDER_NAME_W, c.displayName);
  m.set(PR.PR_SENDER_EMAIL_ADDRESS_W, c.email);
  m.set(PR.PR_MESSAGE_CLASS_W, 'IPM.Contact');
  return m;
}

function taskToPropRow(t: {
  id: string; subject: string; body: string; dueDate: Date | null;
  completed: boolean; priority: number | null; createdAt: Date;
}): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, t.subject);
  m.set(PR.PR_BODY_W, t.body);
  m.set(PR.PR_MESSAGE_CLASS_W, 'IPM.Task');
  m.set(PR.PR_PRIORITY, t.priority ?? 0);
  m.set(PR.PR_MESSAGE_FLAGS, t.completed ? 0x01 : 0x00);
  m.set(PR.PR_MESSAGE_DELIVERY_TIME, t.dueDate ?? t.createdAt);
  m.set(PR.PR_CREATION_TIME, t.createdAt);
  return m;
}

function noteToPropRow(n: {
  id: string; subject: string; body: string; createdAt: Date; updatedAt: Date;
}): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, n.subject);
  m.set(PR.PR_BODY_W, n.body);
  m.set(PR.PR_MESSAGE_CLASS_W, 'IPM.StickyNote');
  m.set(PR.PR_CREATION_TIME, n.createdAt);
  m.set(PR.PR_LAST_MODIFICATION_TIME, n.updatedAt);
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
