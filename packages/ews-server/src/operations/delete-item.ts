import { prisma } from '@coremail/storage';
import { soapEnvelope } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

type DeleteType = 'HardDelete' | 'SoftDelete' | 'MoveToDeletedItems';

export async function deleteItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const deleteType = ((request['$'] as Record<string, string> | undefined)?.['DeleteType'] ??
    'MoveToDeletedItems') as DeleteType;

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];
  const ids: string[] = [];

  const rawList = Array.isArray(itemIdRaw) ? itemIdRaw : itemIdRaw ? [itemIdRaw] : [];
  for (const item of rawList) {
    const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
    if (id) ids.push(id);
  }

  const results: Array<{ id: string; success: boolean }> = [];

  for (const id of ids) {
    const msg = await prisma.message.findUnique({
      where: { id },
      include: { folder: { include: { mailbox: { include: { user: true } } } } },
    });

    if (!msg || msg.folder.mailbox.userId !== user.userId) {
      results.push({ id, success: false });
      continue;
    }

    if (deleteType === 'HardDelete') {
      await prisma.message.delete({ where: { id } });
    } else if (deleteType === 'SoftDelete') {
      await prisma.message.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } else {
      // MoveToDeletedItems: find Trash folder and move
      const trashFolder = await prisma.folder.findFirst({
        where: { mailboxId: msg.folder.mailboxId, name: 'Trash' },
      });
      if (trashFolder) {
        await prisma.message.update({
          where: { id },
          data: { folderId: trashFolder.id },
        });
        await prisma.folder.update({
          where: { id: trashFolder.id },
          data: { totalCount: { increment: 1 } },
        });
      } else {
        await prisma.message.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
      }
    }

    await prisma.folder.update({
      where: { id: msg.folderId },
      data: { totalCount: { decrement: 1 } },
    }).catch(() => undefined);

    results.push({ id, success: true });
  }

  return soapEnvelope((body) => {
    const response = body
      .ele('m:DeleteItemResponse')
      .ele('m:ResponseMessages');

    for (const result of results) {
      if (result.success) {
        response
          .ele('m:DeleteItemResponseMessage', { ResponseClass: 'Success' })
          .ele('m:ResponseCode').txt('NoError');
      } else {
        response
          .ele('m:DeleteItemResponseMessage', { ResponseClass: 'Error' })
          .ele('m:ResponseCode').txt('ErrorItemNotFound')
          .up()
          .ele('m:MessageText').txt('Item not found or access denied');
      }
    }
  });
}
