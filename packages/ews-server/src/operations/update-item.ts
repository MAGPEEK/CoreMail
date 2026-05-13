import { prisma } from '@coremail/storage';
import { soapEnvelope, errorResponse } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

export async function updateItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const itemChanges = request['ItemChanges'] as Record<string, unknown> | undefined;
  const itemChange = itemChanges?.['ItemChange'];
  const changes = Array.isArray(itemChange) ? itemChange : itemChange ? [itemChange] : [];

  const results: { id: string; changeKey: string }[] = [];

  for (const change of changes) {
    const changeRecord = change as Record<string, unknown>;
    const itemIdRaw = changeRecord['ItemId'] as Record<string, Record<string, string>> | undefined;
    const messageId = itemIdRaw?.['$']?.['Id'];
    if (!messageId) continue;

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      include: { folder: { include: { mailbox: true } } },
    });

    if (!msg || msg.folder.mailbox.userId !== user.userId) continue;

    const updates = changeRecord['Updates'] as Record<string, unknown> | undefined;
    let newFlags = [...msg.flags];
    const dataToUpdate: Record<string, unknown> = {};

    // SetItemField updates
    const setFields = updates?.['SetItemField'];
    const setList = Array.isArray(setFields) ? setFields : setFields ? [setFields] : [];

    for (const field of setList) {
      const fieldRecord = field as Record<string, unknown>;
      const msgUpdate = fieldRecord['Message'] as Record<string, unknown> | undefined;

      if (msgUpdate?.['IsRead'] !== undefined) {
        const isRead = String(msgUpdate['IsRead']) === 'true';
        if (isRead) {
          newFlags = [...new Set([...newFlags, '\\Seen'])];
        } else {
          newFlags = newFlags.filter((f) => f !== '\\Seen');
        }
        dataToUpdate['flags'] = newFlags;
        dataToUpdate['modSeq'] = BigInt(Date.now());
      }

      if (msgUpdate?.['Flag'] !== undefined) {
        const flag = msgUpdate['Flag'] as Record<string, unknown>;
        const flagStatus = String(flag['FlagStatus'] ?? 'NotFlagged');
        if (flagStatus === 'Flagged') {
          newFlags = [...new Set([...newFlags, '\\Flagged'])];
        } else {
          newFlags = newFlags.filter((f) => f !== '\\Flagged');
        }
        dataToUpdate['flags'] = newFlags;
        dataToUpdate['modSeq'] = BigInt(Date.now());
      }
    }

    if (Object.keys(dataToUpdate).length > 0) {
      await prisma.message.update({
        where: { id: messageId },
        data: dataToUpdate as any,
      });
    }

    results.push({ id: messageId, changeKey: String(Date.now()) });
  }

  return soapEnvelope((body) => {
    const response = body
      .ele('m:UpdateItemResponse')
      .ele('m:ResponseMessages');

    for (const result of results) {
      response
        .ele('m:UpdateItemResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:Items')
        .ele('t:Message')
        .ele('t:ItemId', { Id: result.id, ChangeKey: result.changeKey });
    }

    if (results.length === 0) {
      response
        .ele('m:UpdateItemResponseMessage', { ResponseClass: 'Error' })
        .ele('m:ResponseCode').txt('ErrorInvalidIdEmpty');
    }
  });
}
