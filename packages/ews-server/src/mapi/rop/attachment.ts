/**
 * Attachment ROP handler (v4.4.0)
 *
 * Implements:
 *   - RopGetAttachmentTable    (MS-OXCMSG §2.2.2.1) — table of attachments
 *   - RopOpenAttachment        (MS-OXCMSG §2.2.2.9)
 *   - RopCreateAttachment      (MS-OXCMSG §2.2.2.8)
 *   - RopDeleteAttachment      (MS-OXCMSG §2.2.2.10)
 *   - RopSaveChangesAttachment (MS-OXCMSG §2.2.2.11)
 *
 * Property mapping (Prisma Attachment → MAPI):
 *   filename       → PR_ATTACH_FILENAME_W + PR_ATTACH_LONG_FILENAME_W
 *   mimeType       → PR_ATTACH_MIME_TAG_W
 *   size           → PR_ATTACH_SIZE
 *   contentId      → PR_ATTACH_CONTENT_ID_W
 *   storagePath    → opaque MinIO key (not exposed)
 *
 * File content is read via RopOpenStream(PR_ATTACH_DATA_BIN) + RopReadStream
 * (see stream.ts).
 */

import { prisma, uploadBuffer, downloadBuffer } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex, updateRopObject,
  type RopObject,
} from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';
import crypto from 'node:crypto';

const log = createLogger('mapi:rop:attachment');

/**
 * v4.4.0: RopGetAttachmentTable
 *
 * Payload: TableFlags(uint8)
 *
 * Response: ReturnValue
 *
 * Creates a table object handle representing the attachments of the parent
 * message. The content is fetched via SetColumns+QueryRows.
 */
export async function handleRopGetAttachmentTable(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeAttError(RopId.GetAttachmentTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (input.object.messageId === null) {
    return writeAttError(RopId.GetAttachmentTable, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'table',
    userId: input.object.userId,
    tableType: 'attachments',
    parentFolderId: input.object.messageId,   // for the attachments table: MessageId
  });
  if (handle === null) {
    return writeAttError(RopId.GetAttachmentTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.GetAttachmentTable);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.debug({ messageId: input.object.messageId, handle }, 'GetAttachmentTable OK');
  return w.toBuffer();
}

/**
 * v4.4.0: RopOpenAttachment
 *
 * Payload: OpenAttachmentFlags(uint8) | AttachmentId(uint32)
 *
 * Response: ReturnValue
 */
export async function handleRopOpenAttachment(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeAttError(RopId.OpenAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (input.object.messageId === null) {
    return writeAttError(RopId.OpenAttachment, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const r = new MapiReader(rop.payload);
  r.readUint8();                              // OpenAttachmentFlags
  const attachNum = r.readUint32();           // index in the attachments list

  const atts = await prisma.attachment.findMany({
    where: { messageId: input.object.messageId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const att = atts[attachNum];
  if (!att) {
    log.warn({ attachNum, messageId: input.object.messageId }, 'OpenAttachment: index not found');
    return writeAttError(RopId.OpenAttachment, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'attachment',
    userId: input.object.userId,
    messageId: input.object.messageId,
    attachmentId: att.id,
    attachNum,
  });
  if (handle === null) {
    return writeAttError(RopId.OpenAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.OpenAttachment);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.debug({ attachmentId: att.id, attachNum }, 'OpenAttachment OK');
  return w.toBuffer();
}

/**
 * v4.4.0: RopCreateAttachment
 *
 * Response: ReturnValue + AttachmentId(uint32)
 *
 * Creates a new attachment handle that is persisted to DB + MinIO on
 * SaveChangesAttachment.
 */
export async function handleRopCreateAttachment(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeAttError(RopId.CreateAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // attachNum = next index
  let attachNum = 0;
  if (input.object.messageId !== null) {
    attachNum = await prisma.attachment.count({
      where: { messageId: input.object.messageId },
    });
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'attachment',
    userId: input.object.userId,
    messageId: input.object.messageId ?? '',  // for a draft with messageId=null: empty until SaveChangesMessage
    attachmentId: null,
    attachNum,
    pendingProperties: {},
    pendingBuffer: Buffer.alloc(0),
  });
  if (handle === null) {
    return writeAttError(RopId.CreateAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.CreateAttachment);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(attachNum);                   // AttachmentId == attachNum
  log.info({ attachNum, handle }, 'CreateAttachment OK');
  return w.toBuffer();
}

/**
 * v4.4.0: RopDeleteAttachment
 *
 * Payload: AttachmentId(uint32)
 */
export async function handleRopDeleteAttachment(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeAttError(RopId.DeleteAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (input.object.messageId === null) {
    return writeAttError(RopId.DeleteAttachment, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const r = new MapiReader(rop.payload);
  const attachNum = r.readUint32();

  const atts = await prisma.attachment.findMany({
    where: { messageId: input.object.messageId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const att = atts[attachNum];
  if (att) {
    try {
      await prisma.attachment.delete({ where: { id: att.id } });
    } catch (e) {
      log.warn({ err: e, attId: att.id }, 'DeleteAttachment DB delete failed');
    }
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.DeleteAttachment);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ attachNum, messageId: input.object.messageId }, 'DeleteAttachment OK');
  return w.toBuffer();
}

/**
 * v4.4.0: RopSaveChangesAttachment
 *
 * Persists pending buffer + pending properties to DB+MinIO.
 */
export async function handleRopSaveChangesAttachment(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'attachment') {
    return writeAttError(RopId.SaveChangesAttachment, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const att = input.object;
  if (!att.messageId) {
    log.warn({ handle: input.handle }, 'SaveChangesAttachment: parent message not yet persisted');
    return writeAttError(RopId.SaveChangesAttachment, rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }

  const props = att.pendingProperties ?? {};
  const filename = String(props[String(PR.PR_ATTACH_LONG_FILENAME_W)]
                       ?? props[String(PR.PR_ATTACH_FILENAME_W)]
                       ?? props[String(PR.PR_DISPLAY_NAME_W)]
                       ?? `attachment-${att.attachNum}.bin`);
  const mimeType = String(props[String(PR.PR_ATTACH_MIME_TAG_W)] ?? 'application/octet-stream');
  const contentId = props[String(PR.PR_ATTACH_CONTENT_ID_W)];
  const pendBuf = Buffer.isBuffer(att.pendingBuffer)
    ? att.pendingBuffer
    : Buffer.from((att.pendingBuffer as unknown as { data: number[] })?.data ?? []);

  // SHA256 + MinIO upload
  const sha256 = crypto.createHash('sha256').update(pendBuf).digest('hex');
  const storagePath = `attachments/${att.messageId}/${sha256}`;
  try {
    await uploadBuffer(storagePath, pendBuf, mimeType);
  } catch (e) {
    log.error({ err: e, storagePath }, 'SaveChangesAttachment: MinIO upload failed');
    return writeAttError(RopId.SaveChangesAttachment, rop, MapiStatusCode.EC_NOT_SUPPORTED);
  }

  // DB insert or update
  let newId: string;
  if (att.attachmentId === null) {
    const created = await prisma.attachment.create({
      data: {
        messageId: att.messageId,
        filename,
        mimeType,
        size: pendBuf.length,
        sha256,
        storagePath,
        ...(contentId ? { contentId: String(contentId) } : {}),
      },
      select: { id: true },
    });
    newId = created.id;
  } else {
    await prisma.attachment.update({
      where: { id: att.attachmentId },
      data: {
        filename, mimeType, size: pendBuf.length, sha256, storagePath,
        ...(contentId ? { contentId: String(contentId) } : {}),
      },
    });
    newId = att.attachmentId;
  }

  // Update handle
  await updateRopObject(sessionToken, input.handle, {
    attachmentId: newId,
    pendingProperties: {},
    pendingBuffer: Buffer.alloc(0),
  } as Partial<RopObject>);

  const w = new MapiWriter();
  w.writeUint8(RopId.SaveChangesAttachment);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ attId: newId, size: pendBuf.length, filename }, 'SaveChangesAttachment persisted');
  return w.toBuffer();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeAttError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

// ── Re-export: attachment download-buffer helper for stream.ts (v4.4.0) ──

/**
 * Reads the attachment bytes from MinIO via storagePath. Used by stream.ts
 * for RopOpenStream on an attachment handle.
 */
export async function loadAttachmentBytes(attachmentId: string): Promise<Buffer | null> {
  const att = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { storagePath: true },
  });
  if (!att?.storagePath) return null;
  try {
    return await downloadBuffer(att.storagePath);
  } catch (e) {
    log.warn({ err: e, attId: attachmentId }, 'loadAttachmentBytes: MinIO download failed');
    return null;
  }
}
