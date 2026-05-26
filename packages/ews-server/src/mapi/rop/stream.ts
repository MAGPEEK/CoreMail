/**
 * Stream-ROP-Handler (v4.2.0 + v4.3.0)
 *
 * v4.2.0: RopOpenStream, RopReadStream, RopGetStreamSize
 * v4.3.0: RopWriteStream, RopCommitStream
 *
 * Stream-Object hält einen In-Memory-Buffer pro geöffnetem Property.
 * Bei OpenStream lädt der Server den vollständigen Property-Value aus DB/MinIO
 * in den Buffer; ReadStream gibt Chunks zurück; offset wird inkrementiert.
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, getPropType, PropType } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex, getRopObject,
} from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';
import { getRedisClient } from '@coremail/core';

const log = createLogger('mapi:rop:stream');

const MAX_STREAM_CHUNK_BYTES = 30_000;     // Outlook erwartet Chunks ≤ 32KB

/** v4.2.0: RopOpenStream */
export async function handleRopOpenStream(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  const propertyTag = r.readUint32();
  r.readUint8();                        // OpenModeFlags

  // Lade den Property-Value aus DB
  const msg = await prisma.message.findUnique({
    where: { id: input.object.messageId },
    select: { bodyText: true, bodyHtml: true, subject: true },
  });
  if (!msg) {
    return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Map PropertyTag → Property-Value
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
    default:
      log.warn({ propertyTag: propertyTag.toString(16) }, 'OpenStream: unbekannter PropertyTag');
      return writeStreamError(RopId.OpenStream, rop, MapiStatusCode.EC_NOT_SUPPORTED);
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'stream',
    userId: input.object.userId,
    messageId: input.object.messageId,
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

  // Buffer aus Session laden — die JSON-Serialisierung hat Buffer in
  // base64-Strings konvertiert, wir restaurieren das hier.
  const streamBuffer = Buffer.isBuffer(streamObj.buffer)
    ? streamObj.buffer
    : Buffer.from((streamObj.buffer as unknown as { data: number[] }).data ?? []);
  const chunkStart = streamObj.offset;
  const chunkEnd = Math.min(chunkStart + requestedBytes, streamBuffer.length);
  const chunk = streamBuffer.subarray(chunkStart, chunkEnd);

  // offset persistieren
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

// ── v4.3.0 STUBS ─────────────────────────────────────────────────────────────

export async function handleRopWriteStream(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  return writeStreamError(RopId.WriteStream, rop, MapiStatusCode.EC_NOT_SUPPORTED);
}

export async function handleRopCommitStream(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  return writeStreamError(RopId.CommitStream, rop, MapiStatusCode.EC_NOT_SUPPORTED);
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
