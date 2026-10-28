/**
 * Stream ROP handler (v4.2.0 + v4.3.0)
 *
 * v4.2.0: RopOpenStream, RopReadStream, RopGetStreamSize
 * v4.3.0: RopWriteStream, RopCommitStream
 *
 * The stream object holds an in-memory buffer per opened property.
 * On OpenStream the server loads the complete property value from DB/MinIO
 * into the buffer; ReadStream returns chunks; the offset is incremented.
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, getPropType, PropType } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex, getRopObject, updateRopObject,
  type RopObject,
} from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';
import { getRedisClient } from '@coremail/core';

const log = createLogger('mapi:rop:stream');

const MAX_STREAM_CHUNK_BYTES = 30_000;     // Outlook expects chunks ≤ 32KB

/** v4.2.0+v4.4.0: RopOpenStream on a message or attachment */
export async function handleRopOpenStream(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  const propertyTag = r.readUint32();
  const openMode = r.readUint8();        // 0=ReadOnly, 1=ReadWrite, 2=Create
  const writable = openMode !== 0;

  // ── v4.4.0: Attachment stream (PR_ATTACH_DATA_BIN) ─────────────────────
  if (input.object.kind === 'attachment') {
    const att = input.object;
    let buffer: Buffer = Buffer.alloc(0);
    if (att.attachmentId !== null && propertyTag === PR.PR_ATTACH_DATA_BIN) {
      const { loadAttachmentBytes } = await import('./attachment.js');
      buffer = (await loadAttachmentBytes(att.attachmentId)) ?? Buffer.alloc(0);
    } else if (writable) {
      // RopCreateAttachment workflow: empty buffer for Outlook to write
      buffer = Buffer.isBuffer(att.pendingBuffer)
        ? att.pendingBuffer
        : Buffer.from((att.pendingBuffer as unknown as { data: number[] })?.data ?? []);
    }

    const handle = await putRopObject(sessionToken, {
      kind: 'stream',
      userId: att.userId,
      messageId: att.messageId || null,
      propertyTag,
      buffer,
      offset: 0,
      writable,
      parentMessageHandle: input.handle,    // we use the same field for the attachment parent too
    });
    if (handle === null) {
      return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
    }
    const w = new MapiWriter();
    w.writeUint8(RopId.OpenStream);
    w.writeUint8(rop.outputHandleIndex ?? 0);
    w.writeUint32(MapiStatusCode.SUCCESS);
    w.writeUint32(buffer.length);
    log.debug({ kind: 'attachment', writable, size: buffer.length, handle }, 'RopOpenStream(att) OK');
    return w.toBuffer();
  }

  // ── Message stream (v4.2.0+v4.3.0) ─────────────────────────────────────
  if (input.object.kind !== 'message') {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  // v4.3.0: Allow a stream on a draft (messageId === null) for write-compose
  if (input.object.messageId === null) {
    const handle = await putRopObject(sessionToken, {
      kind: 'stream',
      userId: input.object.userId,
      messageId: null,
      propertyTag,
      buffer: Buffer.alloc(0),
      offset: 0,
      writable,
      parentMessageHandle: input.handle,
    });
    if (handle === null) {
      return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
    }
    const w = new MapiWriter();
    w.writeUint8(RopId.OpenStream);
    w.writeUint8(rop.outputHandleIndex ?? 0);
    w.writeUint32(MapiStatusCode.SUCCESS);
    w.writeUint32(0);
    return w.toBuffer();
  }
  const messageId: string = input.object.messageId;

  // Load the property value from the DB
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: { bodyText: true, bodyHtml: true, subject: true },
  });
  if (!msg) {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Map PropertyTag → property value
  let buffer: Buffer;
  switch (propertyTag) {
    case PR.PR_BODY_W:
      buffer = encodeUtf16Le(msg.bodyText ?? '');
      break;
    case PR.PR_HTML:
      buffer = Buffer.from(msg.bodyHtml ?? '', 'utf-8');
      break;
    case PR.PR_SUBJECT_W:
      buffer = encodeUtf16Le(msg.subject ?? '');
      break;
    case PR.PR_RTF_COMPRESSED: {
      // v5.2.0: Deliver the RTF body via PR_RTF_COMPRESSED (MS-OXRTFCP).
      // Outlook prefers RTF when both HTML+RTF are set. We build
      // a minimal RTF from HTML/text and wrap it in the MELA uncompressed
      // format — Outlook accepts it without CRC validation.
      const { htmlOrTextToRtfCompressed } = await import('../rtf-compress.js');
      buffer = htmlOrTextToRtfCompressed(msg.bodyHtml ?? '', msg.bodyText ?? '');
      break;
    }
    default:
      log.warn({ propertyTag: propertyTag.toString(16) }, 'OpenStream: unknown PropertyTag');
      return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_NOT_SUPPORTED);
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'stream',
    userId: input.object.userId,
    messageId,
    propertyTag,
    buffer,
    offset: 0,
  });
  if (handle === null) {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response: RopId, OutputHandleIndex, ReturnValue, StreamSize (uint32)
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenStream);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(buffer.length);
  log.debug({ propertyTag: propertyTag.toString(16), size: buffer.length, handle }, 'RopOpenStream');
  return w.toBuffer();
}

/** v4.2.0: RopReadStream */
export async function handleRopReadStream(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'stream') {
    return writeStreamError(RopId.ReadStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  let requestedBytes = r.readUint16();
  if (requestedBytes === 0xBABE) {
    requestedBytes = Math.min(r.readUint32(), MAX_STREAM_CHUNK_BYTES);
  }
  requestedBytes = Math.min(requestedBytes, MAX_STREAM_CHUNK_BYTES);

  const streamObj = input.object;
  if (streamObj.kind !== 'stream') {
    return writeStreamError(RopId.ReadStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Load buffer from the session — JSON serialization converted the Buffer
  // into base64 strings, we restore it here.
  const streamBuffer = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);
  const chunkStart = streamObj.offset;
  const chunkEnd = Math.min(chunkStart + requestedBytes, streamBuffer.length);
  const chunk = streamBuffer.subarray(chunkStart, chunkEnd);

  // persist offset
  await updateStreamOffset(sessionToken, input.handle, chunkEnd);

  const w = new MapiWriter();
  w.writeUint8(RopId.ReadStream);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(chunk.length);
  w.writeBuffer(chunk);
  return w.toBuffer();
}

/** v4.2.0: RopGetStreamSize */
export async function handleRopGetStreamSize(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'stream') {
    return writeStreamError(RopId.GetStreamSize, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const streamObj = input.object;
  if (streamObj.kind !== 'stream') {
    return writeStreamError(RopId.GetStreamSize, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const streamBuffer = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);
  const w = new MapiWriter();
  w.writeUint8(RopId.GetStreamSize);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(streamBuffer.length);
  return w.toBuffer();
}

// ── v4.3.0 — Stream write for compose ────────────────────────────────────────

/**
 * v4.3.0: RopWriteStream
 *
 * Payload: DataSize(uint16) | Data(variable)
 *
 * Response: ReturnValue + WrittenBytes(uint16)
 *
 * Appends Data to the stream buffer (at the current offset). Outlook calls
 * WriteStream repeatedly for long bodies — we accumulate until CommitStream.
 */
export async function handleRopWriteStream(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'stream') {
    return writeStreamError(RopId.WriteStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const streamObj = input.object;

  const r = new MapiReader(rop.payload);
  const dataSize = r.readUint16();
  const data = r.readBuffer(dataSize);

  // Existing buffer (may be JSON-decoded)
  const existing = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);

  // Insert data at the offset (typically = buffer end)
  let merged: Buffer;
  if (streamObj.offset === existing.length) {
    merged = Buffer.concat([existing, data]);
  } else if (streamObj.offset < existing.length) {
    // Overwrite-in-place + Extension
    const before = existing.subarray(0, streamObj.offset);
    const tailEnd = streamObj.offset + data.length;
    const after = tailEnd < existing.length ? existing.subarray(tailEnd) : Buffer.alloc(0);
    merged = Buffer.concat([before, data, after]);
  } else {
    // Offset beyond the buffer — pad with null bytes
    const pad = Buffer.alloc(streamObj.offset - existing.length);
    merged = Buffer.concat([existing, pad, data]);
  }

  await updateRopObject(sessionToken, input.handle, {
    buffer: merged,
    offset: streamObj.offset + data.length,
  } as Partial<RopObject>);

  const w = new MapiWriter();
  w.writeUint8(RopId.WriteStream);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(data.length);
  log.debug({ written: data.length, totalSize: merged.length, handle: input.handle }, 'RopWriteStream OK');
  return w.toBuffer();
}

/**
 * v4.3.0: RopCommitStream
 *
 * Response: ReturnValue
 *
 * Writes the accumulated stream buffer into the parent message — either into
 * the persisted Prisma message (for a stream on a saved
 * message) or into the draft's `pendingProperties` (for a stream on a
 * draft message). Mapping PropertyTag → DB field:
 *   PR_BODY_W      → bodyText (UTF-16-LE-Decode)
 *   PR_HTML        → bodyHtml (UTF-8)
 *   PR_SUBJECT_W   → subject  (UTF-16-LE-Decode)
 */
export async function handleRopCommitStream(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'stream') {
    return writeStreamError(RopId.CommitStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const streamObj = input.object;

  const buf = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);

  // Decode depending on the property tag
  let stringValue: string | null = null;
  let binaryValue: Buffer | null = null;
  switch (streamObj.propertyTag) {
    case PR.PR_BODY_W:
    case PR.PR_SUBJECT_W:
      stringValue = decodeUtf16Le(buf);
      break;
    case PR.PR_HTML:
      binaryValue = buf;
      break;
    default:
      log.warn({ tag: streamObj.propertyTag.toString(16) }, 'CommitStream: unknown property tag — skipping persist');
      // SUCCESS anyway so Outlook does not hang
      break;
  }

  // If the parent is a saved message: direct DB update
  if (streamObj.messageId !== null) {
    const dataPatch: Record<string, unknown> = {};
    if (streamObj.propertyTag === PR.PR_BODY_W) dataPatch['bodyText'] = stringValue;
    if (streamObj.propertyTag === PR.PR_SUBJECT_W) dataPatch['subject'] = stringValue;
    if (streamObj.propertyTag === PR.PR_HTML) dataPatch['bodyHtml'] = binaryValue?.toString('utf-8') ?? '';
    if (Object.keys(dataPatch).length > 0) {
      try {
        await prisma.message.update({
          where: { id: streamObj.messageId },
          data: dataPatch as never,
        });
      } catch (e) {
        log.warn({ err: e, msgId: streamObj.messageId }, 'CommitStream DB update failed');
      }
    }
  } else if (streamObj.parentMessageHandle !== undefined) {
    // Draft stream → write into the parent message handle's pendingProperties
    // (or attachment stream → pendingBuffer)
    const parent = await getRopObject(sessionToken, streamObj.parentMessageHandle);
    if (parent && parent.kind === 'message') {
      const pending = { ...(parent.pendingProperties ?? {}) };
      pending[String(streamObj.propertyTag)] = stringValue ?? binaryValue?.toString('utf-8') ?? '';
      await updateRopObject(sessionToken, streamObj.parentMessageHandle, {
        pendingProperties: pending,
      } as Partial<RopObject>);
    } else if (parent && parent.kind === 'attachment') {
      // v4.4.0: Attachment data stream → into pendingBuffer
      if (streamObj.propertyTag === PR.PR_ATTACH_DATA_BIN) {
        await updateRopObject(sessionToken, streamObj.parentMessageHandle, {
          pendingBuffer: buf,
        } as Partial<RopObject>);
      } else {
        // other properties (filename, MIME) → pendingProperties
        const pending = { ...(parent.pendingProperties ?? {}) };
        pending[String(streamObj.propertyTag)] = stringValue ?? binaryValue?.toString('utf-8') ?? '';
        await updateRopObject(sessionToken, streamObj.parentMessageHandle, {
          pendingProperties: pending,
        } as Partial<RopObject>);
      }
    }
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.CommitStream);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.debug({ tag: streamObj.propertyTag.toString(16), size: buf.length }, 'RopCommitStream OK');
  return w.toBuffer();
}

function decodeUtf16Le(buf: Buffer): string {
  if (buf.length === 0) return '';
  // Trim trailing UTF-16-LE null terminator
  let end = buf.length;
  if (end >= 2 && buf[end - 1] === 0 && buf[end - 2] === 0) end -= 2;
  return buf.subarray(0, end).toString('utf16le');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function encodeUtf16Le(s: string): Buffer {
  const b = Buffer.allocUnsafe(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b.writeUInt16LE(s.charCodeAt(i), i * 2);
  }
  return b;
}

void getPropType; void PropType; // future use

function writeStreamError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

async function updateStreamOffset(token: string, handle: number, offset: number): Promise<void> {
  const redis = getRedisClient();
  const KEY = `mapi:session:${token}`;
  const raw = await redis.get(KEY);
  if (!raw) return;
  const state = JSON.parse(raw);
  const obj = state.handleTable[handle];
  if (obj && obj.kind === 'stream') {
    obj.offset = offset;
    state.lastSeen = Date.now();
    await redis.set(KEY, JSON.stringify(state), 'EX', 600);
  }
}

void getRopObject;  // referenced for future
