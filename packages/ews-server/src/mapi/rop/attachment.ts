/**
 * Attachment-ROP-Handler (v4.4.0)
 *
 * Implementiert:
 *   - RopGetAttachmentTable    (MS-OXCMSG §2.2.2.1) — Tabelle der Anhänge
 *   - RopOpenAttachment        (MS-OXCMSG §2.2.2.9)
 *   - RopCreateAttachment      (MS-OXCMSG §2.2.2.8)
 *   - RopDeleteAttachment      (MS-OXCMSG §2.2.2.10)
 *   - RopSaveChangesAttachment (MS-OXCMSG §2.2.2.11)
 *
 * Property-Mapping (Prisma Attachment → MAPI):
 *   filename       → PR_ATTACH_FILENAME_W + PR_ATTACH_LONG_FILENAME_W
 *   mimeType       → PR_ATTACH_MIME_TAG_W
 *   size           → PR_ATTACH_SIZE
 *   contentId      → PR_ATTACH_CONTENT_ID_W
 *   storagePath    → opaque MinIO-Key (nicht exposed)
 *
 * Datei-Inhalt wird via RopOpenStream(PR_ATTACH_DATA_BIN) + RopReadStream
 * gelesen (s. stream.ts).
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
 * Antwort: ReturnValue
 *
 * Erstellt ein Table-Object-Handle das die Attachments der parent Message
 * repräsentiert. Der Inhalt wird per SetColumns+QueryRows abgeholt.
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
    parentFolderId: input.object.messageId,   // bei attachments-Tabelle: MessageId
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
 * Antwort: ReturnValue
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
  const attachNum = r.readUint32();           // Index in der Attachments-Liste

  const atts = await prisma.attachment.findMany({
    where: { messageId: input.object.messageId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const att = atts[attachNum];
  if (!att) {
    log.warn({ attachNum, messageId: input.object.messageId }, 'OpenAttachment: Index nicht gefunden');
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
 * Antwort: ReturnValue + AttachmentId(uint32)
 *
 * Legt ein neues Attachment-Handle an, das beim SaveChangesAttachment in die
 * DB + MinIO persistiert wird.
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

  // attachNum = nächster Index
  let attachNum = 0;
  if (input.object.messageId !== null) {
    attachNum = await prisma.attachment.count({
      where: { messageId: input.object.messageId },
    });
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'attachment',
    userId: input.object.userId,
    messageId: input.object.messageId ?? '',  // für Draft mit messageId=null: leer bis SaveChangesMessage
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
      log.warn({ err: e, attId: att.id }, 'DeleteAttachment DB-Delete fehlgeschlagen');
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
 * Persistiert pending-Buffer + pending-Properties in DB+MinIO.
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
    log.warn({ handle: input.handle }, 'SaveChangesAttachment: parent Message noch nicht persistiert');
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

  // SHA256 + MinIO-Upload
  const sha256 = crypto.createHash('sha256').update(pendBuf).digest('hex');
  const storagePath = `attachments/${att.messageId}/${sha256}`;
  try {
    await uploadBuffer(storagePath, pendBuf, mimeType);
  } catch (e) {
    log.error({ err: e, storagePath }, 'SaveChangesAttachment: MinIO-Upload fehlgeschlagen');
    return writeAttError(RopId.SaveChangesAttachment, rop, MapiStatusCode.EC_NOT_SUPPORTED);
  }

  // DB-Insert oder Update
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

  // Handle aktualisieren
  await updateRopObject(sessionToken, input.handle, {
    attachmentId: newId,
    pendingProperties: {},
    pendingBuffer: Buffer.alloc(0),
  } as Partial<RopObject>);

  const w = new MapiWriter();
  w.writeUint8(RopId.SaveChangesAttachment);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ attId: newId, size: pendBuf.length, filename }, 'SaveChangesAttachment persistiert');
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

// ── Re-Export: Attachment-DownloadBuffer-Helper für stream.ts (v4.4.0) ──

/**
 * Liest die Attachment-Bytes aus MinIO via storagePath. Wird von stream.ts
 * für RopOpenStream auf einem Attachment-Handle benutzt.
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
    log.warn({ err: e, attId: attachmentId }, 'loadAttachmentBytes: MinIO-Download fehlgeschlagen');
    return null;
  }
}
