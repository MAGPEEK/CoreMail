/**
 * Folder-Operations-Handler (v4.4.0)
 *
 * Implementiert:
 *   - RopDeleteMessages      (MS-OXCMSG §2.2.3.3)
 *   - RopMoveCopyMessages    (MS-OXCMSG §2.2.7.1)
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import { resolveHandleIndex } from '../rop-handle-table.js';
import { cuidToFolderId64 } from '../entry-id.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:folder-ops');

/**
 * v4.4.0: RopDeleteMessages
 *
 * Payload: WantAsynchronous(uint8) | NotifyNonRead(uint8)
 *        | MessageIdCount(uint16) | MessageIds(uint64[])
 *
 * Antwort: ReturnValue + PartialCompletion(uint8)
 */
export async function handleRopDeleteMessages(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'folder') {
    return writeFopError(RopId.DeleteMessages, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const folderId = input.object.folderId;
  const userId = input.object.userId;

  const r = new MapiReader(rop.payload);
  r.readUint8();                                 // WantAsynchronous
  r.readUint8();                                 // NotifyNonRead
  const idCount = r.readUint16();
  const ids64: bigint[] = [];
  for (let i = 0; i < idCount; i++) {
    ids64.push(r.readUint64());
  }

  // Messages auflösen über 64-bit Hash
  const messages = await prisma.message.findMany({
    where: { folderId, folder: { mailbox: { userId } } },
    select: { id: true },
  });
  const targets = messages.filter((m) => ids64.includes(cuidToFolderId64(m.id)));
  let deleted = 0;
  let partial = false;
  for (const t of targets) {
    try {
      await prisma.message.delete({ where: { id: t.id } });
      deleted++;
    } catch (e) {
      log.warn({ err: e, msgId: t.id }, 'DeleteMessages: einzelnes Delete fehlgeschlagen');
      partial = true;
    }
  }
  // Folder-Counter aktualisieren
  if (deleted > 0) {
    try {
      await prisma.folder.update({
        where: { id: folderId },
        data: { totalCount: { decrement: deleted } },
      });
    } catch (e) {
      log.warn({ err: e }, 'DeleteMessages: Folder-Counter-Update fehlgeschlagen');
    }
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.DeleteMessages);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(partial ? 1 : 0);
  log.info({ deleted, requested: idCount, partial }, 'RopDeleteMessages OK');
  return w.toBuffer();
}

/**
 * v4.4.0: RopMoveCopyMessages
 *
 * Payload: WantAsynchronous(uint8) | WantCopy(uint8)
 *        | MessageIdCount(uint16) | MessageIds(uint64[])
 *
 * Source = inputHandleIndex (folder), Destination = outputHandleIndex (folder).
 *
 * Antwort: ReturnValue + PartialCompletion(uint8)
 */
export async function handleRopMoveCopyMessages(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const src = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!src || src.object.kind !== 'folder') {
    return writeFopError(RopId.MoveCopyMessages, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const dst = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.outputHandleIndex);
  if (!dst || dst.object.kind !== 'folder') {
    return writeFopError(RopId.MoveCopyMessages, rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }
  const srcFolderId = src.object.folderId;
  const dstFolderId = dst.object.folderId;
  const userId = src.object.userId;

  const r = new MapiReader(rop.payload);
  r.readUint8();                                 // WantAsynchronous
  const wantCopy = r.readUint8() !== 0;          // 0 = move, 1 = copy
  const idCount = r.readUint16();
  const ids64: bigint[] = [];
  for (let i = 0; i < idCount; i++) {
    ids64.push(r.readUint64());
  }

  const messages = await prisma.message.findMany({
    where: { folderId: srcFolderId, folder: { mailbox: { userId } } },
    select: { id: true },
  });
  const targets = messages.filter((m) => ids64.includes(cuidToFolderId64(m.id)));
  let moved = 0;
  let partial = false;
  for (const t of targets) {
    try {
      if (wantCopy) {
        // Copy: vollständigen Record duplizieren (Mailbox-UID-Increment)
        const orig = await prisma.message.findUnique({ where: { id: t.id } });
        if (orig) {
          const { id: _id, createdAt: _c, ...rest } = orig;
          await prisma.message.create({ data: { ...rest, folderId: dstFolderId } });
        }
      } else {
        await prisma.message.update({
          where: { id: t.id },
          data: { folderId: dstFolderId },
        });
      }
      moved++;
    } catch (e) {
      log.warn({ err: e, msgId: t.id, copy: wantCopy }, 'MoveCopyMessages: einzelner Op fehlgeschlagen');
      partial = true;
    }
  }

  // Folder-Counter
  if (moved > 0) {
    try {
      await prisma.folder.update({
        where: { id: dstFolderId },
        data: { totalCount: { increment: moved } },
      });
      if (!wantCopy) {
        await prisma.folder.update({
          where: { id: srcFolderId },
          data: { totalCount: { decrement: moved } },
        });
      }
    } catch (e) {
      log.warn({ err: e }, 'MoveCopyMessages: Folder-Counter-Update fehlgeschlagen');
    }
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.MoveCopyMessages);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(partial ? 1 : 0);
  log.info({ moved, copy: wantCopy, partial, requested: idCount }, 'RopMoveCopyMessages OK');
  return w.toBuffer();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeFopError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
