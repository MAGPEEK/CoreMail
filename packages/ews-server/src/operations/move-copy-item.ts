import { getPrisma } from '@coremail/storage';
import { soapEnvelope, errorResponse } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

const WELL_KNOWN_FOLDERS: Record<string, string> = {
  inbox: 'INBOX',
  deleteditems: 'Trash',
  sentitems: 'Sent',
  drafts: 'Drafts',
  junkemail: 'Junk',
};

async function resolveFolderId(
  folderIdRaw: Record<string, unknown> | undefined,
  mailboxId: string,
): Promise<string | null> {
  if (!folderIdRaw) return null;
  const prisma = getPrisma();

  const distinguishedId = folderIdRaw['DistinguishedFolderId'] as
    | Record<string, Record<string, string>>
    | undefined;
  if (distinguishedId) {
    const name = WELL_KNOWN_FOLDERS[distinguishedId['$']?.['Id']?.toLowerCase() ?? ''] ?? 'INBOX';
    const folder = await prisma.folder.findFirst({ where: { mailboxId, name } });
    return folder?.id ?? null;
  }

  const folderId = folderIdRaw['FolderId'] as
    | Record<string, Record<string, string>>
    | undefined;
  return folderId?.['$']?.['Id'] ?? null;
}

export async function moveItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('MoveItem', 'ErrorMailboxNotFound', 'Mailbox not found');

  const toFolderIdRaw = request['ToFolderId'] as Record<string, unknown> | undefined;
  const targetFolderId = await resolveFolderId(toFolderIdRaw, mailbox.id);
  if (!targetFolderId) return errorResponse('MoveItem', 'ErrorFolderNotFound', 'Target folder not found');

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];
  const ids = Array.isArray(itemIdRaw) ? itemIdRaw : itemIdRaw ? [itemIdRaw] : [];

  const results: { id: string }[] = [];
  for (const item of ids) {
    const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
    if (!id) continue;

    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: mailbox.id } },
    });
    if (!msg) continue;

    await prisma.message.update({ where: { id }, data: { folderId: targetFolderId } });
    results.push({ id });
  }

  return soapEnvelope((body) => {
    const response = body.ele('m:MoveItemResponse').ele('m:ResponseMessages');
    for (const r of results) {
      response
        .ele('m:MoveItemResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:Items')
        .ele('t:Message')
        .ele('t:ItemId', { Id: r.id, ChangeKey: String(Date.now()) });
    }
  });
}

export async function copyItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('CopyItem', 'ErrorMailboxNotFound', 'Mailbox not found');

  const toFolderIdRaw = request['ToFolderId'] as Record<string, unknown> | undefined;
  const targetFolderId = await resolveFolderId(toFolderIdRaw, mailbox.id);
  if (!targetFolderId) return errorResponse('CopyItem', 'ErrorFolderNotFound', 'Target folder not found');

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];
  const ids = Array.isArray(itemIdRaw) ? itemIdRaw : itemIdRaw ? [itemIdRaw] : [];

  const results: { id: string }[] = [];
  for (const item of ids) {
    const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
    if (!id) continue;

    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: mailbox.id } },
      include: { attachments: true },
    });
    if (!msg) continue;

    const updatedMailbox = await prisma.mailbox.update({
      where: { id: mailbox.id },
      data: { uidNext: { increment: 1 } },
    });

    const newMsg = await prisma.message.create({
      data: {
        folderId: targetFolderId,
        uid: updatedMailbox.uidNext - 1,
        modSeq: BigInt(Date.now()),
        flags: msg.flags,
        subject: msg.subject,
        fromAddr: msg.fromAddr,
        toAddrs: msg.toAddrs,
        ccAddrs: msg.ccAddrs,
        date: msg.date,
        bodyText: msg.bodyText,
        bodyHtml: msg.bodyHtml,
        rawSize: msg.rawSize,
        storagePath: msg.storagePath,
      },
    });

    results.push({ id: newMsg.id });
  }

  return soapEnvelope((body) => {
    const response = body.ele('m:CopyItemResponse').ele('m:ResponseMessages');
    for (const r of results) {
      response
        .ele('m:CopyItemResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:Items')
        .ele('t:Message')
        .ele('t:ItemId', { Id: r.id, ChangeKey: String(Date.now()) });
    }
  });
}
