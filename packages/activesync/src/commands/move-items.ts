/**
 * MoveItems command ([MS-ASCMD] 2.2.1.12).
 *
 * Moves messages between folders of the caller's own mailbox through the
 * message store (`moveMessages`): the row keeps its id (= EAS ServerId, returned
 * as DstMsgId) and gets a new UID + modSeq in the target, so IMAP/JMAP clients
 * see the move as well.
 */
import { prisma } from '@coremail/storage/prisma';
import { moveMessages } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { encodeWbxml, el, getText, type WbxmlElement } from '../wbxml.js';

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

async function moveOne(move: WbxmlElement, userId: string, mailboxId: string): Promise<WbxmlElement> {
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
    const { mapping } = await prisma.$transaction((tx) => moveMessages(tx, [msg.id], dstFldId, {
      targetMailboxId: mailboxId, sourceMailboxId: mailboxId,
    }));
    if (mapping.length !== 1) return response(MOVE_STATUS.INVALID_SOURCE);
    return response(MOVE_STATUS.SUCCESS, mapping[0]!.id);
  } catch (err) {
    log.error({ err, userId, srcMsgId }, 'MoveItems failed');
    return response(MOVE_STATUS.LOCKED);
  }
}

export async function handleMoveItems(body: WbxmlElement, userId: string): Promise<Buffer> {
  const moves = kids(body).filter((c) => c.name === 'Move');
  const mailbox = await prisma.mailbox.findFirst({ where: { userId }, select: { id: true, userId: true } });
  const responses: WbxmlElement[] = [];
  for (const move of moves) {
    if (!mailbox || mailbox.userId !== userId) {
      responses.push(el('Response', undefined, [el('SrcMsgId', getText(move, 'SrcMsgId')), el('Status', MOVE_STATUS.INVALID_SOURCE)]));
      continue;
    }
    responses.push(await moveOne(move, userId, mailbox.id));
  }
  return encodeWbxml(el('MoveItems', undefined, responses));
}
