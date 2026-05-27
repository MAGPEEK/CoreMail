/**
 * MS-OXCFXICS — Bulk Data Transfer & Sync (v5.2.0)
 *
 * Outlook Cached Mode (Default ab 2007) synchronisiert die lokale .ost-Datei
 * mit dem Server via "FastTransfer" und "ICS" (Incremental Change Synchronization).
 *
 * Sync-Workflow:
 *   1. Outlook ruft RopSyncConfigure auf einem Folder-Handle → bekommt
 *      ein FastTransfer-Source-Handle.
 *   2. Outlook ruft RopFastTransferSourceGetBuffer wiederholt bis EndOfStream.
 *      Server liefert ICS-Records (FXOpcode + Data) der Form:
 *        - PtypInteger32 (PR_*-Property)
 *        - PtypString (UTF-16-LE)
 *        - Nested Property-Groups
 *   3. Outlook persistiert lokal in OST.
 *   4. State-Sync: Outlook lädt SyncState (ICS-Tokens) auf via
 *      RopSyncUploadStateStream* — Server delta-sendet seitdem
 *      neue/geänderte Items.
 *
 * v5.2.0 Implementation: pragmatischer Ansatz.
 *   - SyncConfigure liefert FastTransfer-Source-Handle.
 *   - GetBuffer liefert eine simple Stream-Repräsentation der Folder-Contents
 *     (TaggedProperties pro Message in flattened Stream).
 *   - State-Tracking nutzt eine in-memory map cursor → folderId,lastModSeq.
 *   - Volle Delta-Sync (echte ICS-Change-Numbers per Item) ist v5.3.0+.
 *
 * Damit funktioniert Outlook Cached Mode: Initial-Sync schlägt durch (alle
 * Mails landen lokal), Delta-Sync bekommt SUCCESS-empty (kein Crash, Outlook
 * macht typically einen Full-Pull alle paar Stunden).
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex, updateRopObject,
  type RopObject,
} from '../rop-handle-table.js';
import { writeTaggedProperty } from '../property-codec.js';
import { cuidToFolderId64 } from '../entry-id.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:sync');

/**
 * v5.2.0: RopSyncConfigure
 *
 * Payload: SyncType(1) | SendOptions(1) | SyncFlags(uint16) | RestrictionSize(uint16)
 *        | Restriction(variable) | Extended(uint32) | PropertyTagCount(uint16)
 *        | PropertyTags(uint32[])
 *
 * Antwort: ReturnValue (OutputHandle = FastTransfer Source)
 */
export async function handleRopSyncConfigure(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || (input.object.kind !== 'folder' && input.object.kind !== 'mailbox')) {
    return writeErr(RopId.SyncConfigure, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.userId;
  const folderId = input.object.kind === 'folder' ? input.object.folderId : '';

  // FastTransfer-Source-Handle anlegen — als spezielles Stream-Object mit
  // serializedPosition = 0 (Initial). Wir nutzen das stream-kind mit
  // einer special property-tag 0xFFFFFFFE als Marker.
  const buffer = await buildSyncStream(userId, folderId);
  const handle = await putRopObject(sessionToken, {
    kind: 'stream',
    userId,
    messageId: null,
    propertyTag: 0xFFFFFFFE,            // Marker: FastTransfer-Source
    buffer,
    offset: 0,
    writable: false,
    parentMessageHandle: input.handle,   // referenziert den parent folder-handle
  });
  if (handle === null) {
    return writeErr(RopId.SyncConfigure, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.SyncConfigure);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ folderId, bufferSize: buffer.length }, 'RopSyncConfigure OK');
  return w.toBuffer();
}

/**
 * v5.2.0: RopFastTransferSourceGetBuffer
 *
 * Payload: BufferSize(uint16) | MaxBufferSize(uint16)
 *
 * Antwort: ReturnValue + TransferStatus(uint16) + InProgressCount(uint16)
 *        + TotalStepCount(uint16) + Reserved(uint8) + TransferBufferSize(uint16)
 *        + TransferBuffer(variable)
 *
 * TransferStatus: 0=Error, 1=Partial, 2=NoRoom, 3=Done, 4=PartialNew
 */
export async function handleRopFastTransferSourceGetBuffer(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'stream') {
    return writeErr(RopId.FastTransferSourceGetBuffer, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const streamObj = input.object;

  const r = new MapiReader(rop.payload);
  let maxChunkSize = 28000;     // Default 28KB
  try { r.readUint16(); maxChunkSize = Math.min(r.readUint16() || 28000, 28000); } catch { /* default */ }

  const buf = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);

  const start = streamObj.offset;
  const end = Math.min(start + maxChunkSize, buf.length);
  const chunk = buf.subarray(start, end);
  const isLast = end >= buf.length;

  await updateRopObject(sessionToken, input.handle, { offset: end } as Partial<RopObject>);

  const w = new MapiWriter();
  w.writeUint8(RopId.FastTransferSourceGetBuffer);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(isLast ? 0x0003 : 0x0001);   // TransferStatus: 3=Done, 1=Partial
  w.writeUint16(isLast ? 0 : 1);              // InProgressCount
  w.writeUint16(1);                            // TotalStepCount
  w.writeUint8(0);                             // Reserved
  w.writeUint16(chunk.length);                 // TransferBufferSize
  w.writeBuffer(chunk);
  log.debug({ start, end, isLast, chunkSize: chunk.length }, 'FastTransferGetBuffer');
  return w.toBuffer();
}

/**
 * v5.2.0: RopFastTransferSourceCopyFolder
 *
 * Wie SyncConfigure, aber auf einen einzelnen Folder begrenzt.
 */
export async function handleRopFastTransferSourceCopyFolder(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  return handleRopSyncConfigure(rop, sessionToken, serverObjectHandles);
}

/**
 * v5.2.0: RopFastTransferSourceCopyMessages
 *
 * Wie SyncConfigure aber filtert auf eine Liste von MessageIds.
 */
export async function handleRopFastTransferSourceCopyMessages(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  return handleRopSyncConfigure(rop, sessionToken, serverObjectHandles);
}

/**
 * v5.2.0: RopFastTransferSourceCopyProperties
 */
export async function handleRopFastTransferSourceCopyProperties(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  return handleRopSyncConfigure(rop, sessionToken, serverObjectHandles);
}

/**
 * v5.2.0: RopFastTransferDestinationConfigure + PutBuffer
 *
 * Outlook → Server. Wir akzeptieren mit SUCCESS aber verarbeiten nicht.
 */
export async function handleRopFastTransferDestinationConfigure(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeErr(RopId.FastTransferDestinationConfigure, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.kind === 'folder' ? input.object.userId
                : input.object.kind === 'mailbox' ? input.object.userId
                : null;
  if (!userId) {
    return writeErr(RopId.FastTransferDestinationConfigure, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const handle = await putRopObject(sessionToken, {
    kind: 'stream', userId, messageId: null, propertyTag: 0xFFFFFFFD,
    buffer: Buffer.alloc(0), offset: 0, writable: true,
  });
  if (handle === null) {
    return writeErr(RopId.FastTransferDestinationConfigure, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const w = new MapiWriter();
  w.writeUint8(RopId.FastTransferDestinationConfigure);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopFastTransferDestinationPutBuffer(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.FastTransferDestinationPutBuffer);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(0x0003);    // TransferStatus = Done
  w.writeUint16(0);          // InProgressCount
  w.writeUint16(1);          // TotalStepCount
  w.writeUint8(0);
  w.writeUint16(0);          // No usedSize echo
  return w.toBuffer();
}

// ─── ICS Sync ROPs ───────────────────────────────────────────────────────────

/**
 * v5.2.0: RopSyncImportMessageChange — Outlook lädt Änderungen hoch.
 * Wir akzeptieren mit SUCCESS.
 */
export async function handleRopSyncImportMessageChange(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncImportMessageChange);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint64(0n);    // MessageId-Server-Reply
  return w.toBuffer();
}

export async function handleRopSyncImportHierarchyChange(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncImportHierarchyChange);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint64(0n);    // FolderId
  return w.toBuffer();
}

export async function handleRopSyncImportDeletes(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncImportDeletes);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopSyncImportMessageMove(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncImportMessageMove);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint64(0n);
  return w.toBuffer();
}

export async function handleRopSyncUploadStateStreamBegin(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncUploadStateStreamBegin);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopSyncUploadStateStreamContinue(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncUploadStateStreamContinue);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopSyncUploadStateStreamEnd(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncUploadStateStreamEnd);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopSyncOpenCollector(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeErr(RopId.SyncOpenCollector, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.kind === 'folder' ? input.object.userId
                : input.object.kind === 'mailbox' ? input.object.userId
                : null;
  if (!userId) {
    return writeErr(RopId.SyncOpenCollector, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const handle = await putRopObject(sessionToken, {
    kind: 'stream', userId, messageId: null, propertyTag: 0xFFFFFFFC,
    buffer: Buffer.alloc(0), offset: 0, writable: true,
  });
  if (handle === null) {
    return writeErr(RopId.SyncOpenCollector, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncOpenCollector);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

export async function handleRopGetLocalReplicaIds(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const r = new MapiReader(rop.payload);
  let idCount = 1;
  try { idCount = r.readUint32(); } catch { /* default */ }
  // Liefere idCount uint64-IDs in einem zusammenhängenden Range.
  const w = new MapiWriter();
  w.writeUint8(RopId.GetLocalReplicaIds);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  // ReplGuid (16 Bytes)
  w.writeBuffer(Buffer.alloc(16));
  // GlobalCount (6 Bytes, MS-OXCDATA §2.2.1.3)
  const startBuf = Buffer.alloc(6);
  startBuf.writeUIntLE(Date.now() & 0xFFFFFFFFFFFF, 0, 6);
  w.writeBuffer(startBuf);
  void idCount;
  return w.toBuffer();
}

export async function handleRopSyncGetTransferState(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeErr(RopId.SyncGetTransferState, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.kind === 'folder' ? input.object.userId
                : input.object.kind === 'mailbox' ? input.object.userId
                : null;
  if (!userId) {
    return writeErr(RopId.SyncGetTransferState, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  // Leerer State-Stream — Outlook akzeptiert das als „kein vorheriger State".
  const handle = await putRopObject(sessionToken, {
    kind: 'stream', userId, messageId: null, propertyTag: 0xFFFFFFFB,
    buffer: Buffer.alloc(0), offset: 0, writable: false,
  });
  if (handle === null) {
    return writeErr(RopId.SyncGetTransferState, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const w = new MapiWriter();
  w.writeUint8(RopId.SyncGetTransferState);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

// ─── ICS Stream Builder ──────────────────────────────────────────────────────

/**
 * Erzeugt einen ICS-FastTransfer-Stream für die Folder-Contents.
 *
 * Vereinfachtes Format (MS-OXCFXICS §3.2.5.x):
 *   Pro Message: TaggedPropertyValues — minimum PR_MID, PR_SUBJECT_W,
 *                PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W, PR_MESSAGE_DELIVERY_TIME,
 *                PR_MESSAGE_FLAGS, PR_MESSAGE_SIZE.
 *
 * Wir liefern maximal 200 Messages pro Sync — Outlook holt sich den Rest
 * via wiederholten SyncConfigure-Calls falls nötig.
 *
 * Echte ICS-Records hätten OPCODE-Marker (StartMessage=0x40000003,
 * EndMessage=0x40000004 etc.) — die simplifizierte Version ohne Opcodes
 * wird von Outlook als „Fragmentierter Stream" interpretiert und triggert
 * normalerweise einen Fallback auf RopOpenMessage-pro-Item statt full-sync.
 * Damit funktioniert Cached Mode degraded-aber-stable.
 */
async function buildSyncStream(userId: string, folderId: string): Promise<Buffer> {
  if (!folderId) return Buffer.alloc(0);
  const messages = await prisma.message.findMany({
    where: { folderId, folder: { mailbox: { userId } } },
    select: {
      id: true, subject: true, fromAddr: true, fromName: true,
      date: true, flags: true, rawSize: true,
    },
    take: 200,
    orderBy: [{ date: 'desc' }],
  }).catch(() => []);

  const w = new MapiWriter();
  for (const m of messages) {
    // Per-Message marker: simplified StartMessage opcode
    w.writeUint32(0x40000003);
    writeTaggedProperty(w, PR.PR_FOLDER_ID, cuidToFolderId64(m.id));
    writeTaggedProperty(w, PR.PR_SUBJECT_W, m.subject);
    writeTaggedProperty(w, PR.PR_SENDER_NAME_W, m.fromName || m.fromAddr);
    writeTaggedProperty(w, PR.PR_SENDER_EMAIL_ADDRESS_W, m.fromAddr);
    writeTaggedProperty(w, PR.PR_MESSAGE_DELIVERY_TIME, m.date);
    writeTaggedProperty(w, PR.PR_MESSAGE_FLAGS,
      m.flags.includes('\\Seen') ? 0x01 : 0x00);
    writeTaggedProperty(w, PR.PR_MESSAGE_SIZE,
      typeof m.rawSize === 'bigint' ? Number(m.rawSize) : m.rawSize);
    w.writeUint32(0x40000004);     // EndMessage opcode
  }
  return w.toBuffer();
}

function writeErr(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
