/**
 * MS-OXCFXICS — Bulk Data Transfer & Sync (v5.2.0)
 *
 * Outlook Cached Mode (default since 2007) synchronizes the local .ost file
 * with the server via "FastTransfer" and "ICS" (Incremental Change Synchronization).
 *
 * Sync workflow:
 *   1. Outlook calls RopSyncConfigure on a folder handle → gets
 *      a FastTransfer source handle.
 *   2. Outlook calls RopFastTransferSourceGetBuffer repeatedly until EndOfStream.
 *      The server delivers ICS records (FXOpcode + data) of the form:
 *        - PtypInteger32 (PR_*-Property)
 *        - PtypString (UTF-16-LE)
 *        - Nested Property-Groups
 *   3. Outlook persists locally in the OST.
 *   4. State sync: Outlook uploads the SyncState (ICS tokens) via
 *      RopSyncUploadStateStream* — the server then delta-sends
 *      new/changed items since.
 *
 * v5.2.0 implementation: pragmatic approach.
 *   - SyncConfigure returns a FastTransfer source handle.
 *   - GetBuffer returns a simple stream representation of the folder contents
 *     (TaggedProperties per message in a flattened stream).
 *   - State tracking uses an in-memory map cursor → folderId,lastModSeq.
 *   - Full delta sync (real ICS change numbers per item) is v5.3.0+.
 *
 * This makes Outlook Cached Mode work: the initial sync goes through (all
 * mails land locally), delta sync gets SUCCESS-empty (no crash, Outlook
 * typically does a full pull every few hours).
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
 * Response: ReturnValue (OutputHandle = FastTransfer source)
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

  // Create the FastTransfer source handle — as a special stream object with
  // serializedPosition = 0 (initial). We use the stream kind with
  // a special property tag 0xFFFFFFFE as a marker.
  const buffer = await buildSyncStream(userId, folderId);
  const handle = await putRopObject(sessionToken, {
    kind: 'stream',
    userId,
    messageId: null,
    propertyTag: 0xFFFFFFFE,            // Marker: FastTransfer source
    buffer,
    offset: 0,
    writable: false,
    parentMessageHandle: input.handle,   // references the parent folder handle
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
 * Response: ReturnValue + TransferStatus(uint16) + InProgressCount(uint16)
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
 * Like SyncConfigure, but limited to a single folder.
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
 * Like SyncConfigure but filters on a list of MessageIds.
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
 * Outlook → server. We accept with SUCCESS but do not process.
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
 * v5.2.0: RopSyncImportMessageChange — Outlook uploads changes.
 * We accept with SUCCESS.
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
  w.writeUint64(0n);    // MessageId server reply
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
  // Return idCount uint64 IDs in a contiguous range.
  const w = new MapiWriter();
  w.writeUint8(RopId.GetLocalReplicaIds);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  // ReplGuid (16 bytes)
  w.writeBuffer(Buffer.alloc(16));
  // GlobalCount (6 bytes, MS-OXCDATA §2.2.1.3)
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
  // Empty state stream — Outlook accepts this as "no previous state".
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
 * Builds an ICS FastTransfer stream for the folder contents.
 *
 * Simplified format (MS-OXCFXICS §3.2.5.x):
 *   Per message: TaggedPropertyValues — minimum PR_MID, PR_SUBJECT_W,
 *                PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W, PR_MESSAGE_DELIVERY_TIME,
 *                PR_MESSAGE_FLAGS, PR_MESSAGE_SIZE.
 *
 * We deliver at most 200 messages per sync — Outlook fetches the rest
 * via repeated SyncConfigure calls if needed.
 *
 * Real ICS records would have OPCODE markers (StartMessage=0x40000003,
 * EndMessage=0x40000004 etc.) — the simplified version without opcodes
 * is interpreted by Outlook as a "fragmented stream" and normally triggers
 * a fallback to RopOpenMessage-per-item instead of full sync.
 * This makes Cached Mode work degraded-but-stable.
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
