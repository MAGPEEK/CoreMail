/**
 * MoveItems command ([MS-ASCMD] 2.2.1.12).
 *
 * Moves messages between folders of the caller's own mailbox through the
 * message store (`moveMessages`): the row keeps its id (= EAS ServerId, returned
 * as DstMsgId) and gets a new UID + modSeq in the target, so IMAP/JMAP clients
 * see the move as well. The device's item state follows the move (item-state.ts), so the
 * next Sync neither re-adds the item in the destination nor deletes it in the source.
 * w3: calendar / tasks / notes items move only inside their class (pim/move.ts); a move
 * between classes or between mail and a PIM class is an invalid destination (Status 2).
 */
import { prisma } from '@coremail/storage/prisma';
import { moveMessages } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { encodeWbxml, el, getText, type WbxmlElement } from '../wbxml.js';
import { forgetItems, markKnown } from './item-state.js';
import { HIGHEST_EAS_VERSION, type EasVersion } from '../protocol-version.js';
import { moduleFor } from '../pim/registry.js';
import { movePimItem } from '../pim/move.js';

const log = createLogger('activesync:move-items');

export const MOVE_STATUS = {
  INVALID_SOURCE: '1',
  INVALID_DESTINATION: '2',
  SUCCESS: '3',
  SAME_FOLDER: '4',
  FAILURE: '5',
  LOCKED: '7',
} as const;

const kids = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

async function moveOne(move: WbxmlElement, userId: string, mailboxId: string, deviceRowId: string | null, version: EasVersion): Promise<WbxmlElement> {
  const srcMsgId = getText(move, 'SrcMsgId');
  const srcFldId = getText(move, 'SrcFldId');
  const dstFldId = getText(move, 'DstFldId');
  const response = (status: string, dst?: string) => el('Response', undefined, [
    el('SrcMsgId', srcMsgId),
    el('Status', status),
    ...(dst ? [el('DstMsgId', dst)] : []),
  ]);

  if (!srcMsgId || !srcFldId) return response(MOVE_STATUS.INVALID_SOURCE);
  if (!dstFldId) return response(MOVE_STATUS.INVALID_DESTINATION);
  if (srcFldId === dstFldId) return response(MOVE_STATUS.SAME_FOLDER);
  // w3: calendar / tasks / notes items move inside their class only (pim/move.ts)
  if (moduleFor(srcFldId) || moduleFor(dstFldId)) {
    const r = await movePimItem({ userId, deviceRowId, version, srcCollectionId: srcFldId, dstCollectionId: dstFldId, serverId: srcMsgId });
    if (r.kind === 'moved') return response(MOVE_STATUS.SUCCESS, r.serverId);
    return response(r.kind === 'invalid-source' ? MOVE_STATUS.INVALID_SOURCE : MOVE_STATUS.INVALID_DESTINATION);
  }

  // Both folders must belong to the caller's own mailbox (no cross-mailbox moves).
  const [src, dst] = await Promise.all([
    prisma.folder.findFirst({ where: { id: srcFldId, mailboxId, mailbox: { userId } }, select: { id: true, mailboxId: true } }),
    prisma.folder.findFirst({ where: { id: dstFldId, mailboxId, mailbox: { userId } }, select: { id: true, mailboxId: true } }),
  ]);
  if (!src || src.mailboxId !== mailboxId) return response(MOVE_STATUS.INVALID_SOURCE);
  if (!dst || dst.mailboxId !== mailboxId) return response(MOVE_STATUS.INVALID_DESTINATION);

  const msg = await prisma.message.findFirst({
    where: { id: srcMsgId, folderId: srcFldId, deletedAt: null },
    select: { id: true, folderId: true },
  });
  if (!msg || msg.folderId !== srcFldId) return response(MOVE_STATUS.INVALID_SOURCE);

  try {
    const { mapping, modSeq } = await prisma.$transaction((tx) => moveMessages(tx, [msg.id], dstFldId, {
      targetMailboxId: mailboxId, sourceMailboxId: mailboxId,
    }));
    if (mapping.length !== 1) return response(MOVE_STATUS.INVALID_SOURCE);
    // The device already holds the item in the destination (DstMsgId) at this modSeq:
    // the next Sync of the destination must not Add it again, the source must not Delete it.
    if (deviceRowId && modSeq !== null) {
      await forgetItems(deviceRowId, srcFldId, [msg.id]);
      await markKnown(deviceRowId, dstFldId, [{ serverId: msg.id, modSeq }]);
    }
    return response(MOVE_STATUS.SUCCESS, mapping[0]!.id);
  } catch (err) {
    log.error({ err, userId, srcMsgId }, 'MoveItems failed');
    return response(MOVE_STATUS.LOCKED);
  }
}

export async function handleMoveItems(body: WbxmlElement, userId: string, deviceId?: string, version: EasVersion = HIGHEST_EAS_VERSION): Promise<Buffer> {
  const moves = kids(body).filter((c) => c.name === 'Move');
  const mailbox = await prisma.mailbox.findFirst({ where: { userId }, select: { id: true, userId: true } });
  const device = deviceId
    ? await prisma.activeSyncDevice.findUnique({ where: { userId_deviceId: { userId, deviceId } }, select: { id: true } })
    : null;
  const responses: WbxmlElement[] = [];
  for (const move of moves) {
    if (!mailbox || mailbox.userId !== userId) {
      responses.push(el('Response', undefined, [el('SrcMsgId', getText(move, 'SrcMsgId')), el('Status', MOVE_STATUS.INVALID_SOURCE)]));
      continue;
    }
    responses.push(await moveOne(move, userId, mailbox.id, device?.id ?? null, version));
  }
  return encodeWbxml(el('MoveItems', undefined, responses));
}
