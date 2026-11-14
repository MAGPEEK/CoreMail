import { prisma, moveMessages, copyMessages } from '@coremail/storage';
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
  const id = folderId?.['$']?.['Id'];
  if (!id) return null;
  // The target must belong to the caller's mailbox (UIDs are allocated from it).
  const owned = await prisma.folder.findFirst({ where: { id, mailboxId }, select: { id: true } });
  return owned?.id ?? null;
}

export async function moveItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('MoveItem', 'ErrorMailboxNotFound', 'Mailbox not found');

  const toFolderIdRaw = request['ToFolderId'] as Record<string, unknown> | undefined;
  const targetFolderId = await resolveFolderId(toFolderIdRaw, mailbox.id);
  if (!targetFolderId) return errorResponse('MoveItem', 'ErrorFolderNotFound', 'Target folder not found');

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];
  const ids = Array.isArray(itemIdRaw) ? itemIdRaw : itemIdRaw ? [itemIdRaw] : [];

  const results: { id: string; changeKey: string }[] = [];
  for (const item of ids) {
    const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
    if (!id) continue;

    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: mailbox.id } },
    });
    if (!msg) continue;

    // Move = new UID in the target folder + new modSeq (message store)
    const { modSeq } = await prisma.$transaction((tx) => moveMessages(
      tx, [id], targetFolderId, { targetMailboxId: mailbox.id, sourceMailboxId: mailbox.id },
    ));
    results.push({ id, changeKey: String(modSeq ?? msg.modSeq) });
  }

  return soapEnvelope((body) => {
    const response = body.ele('m:MoveItemResponse').ele('m:ResponseMessages');
    for (const r of results) {
      response
        .ele('m:MoveItemResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:Items')
        .ele('t:Message')
        .ele('t:ItemId', { Id: r.id, ChangeKey: r.changeKey });
    }
  });
}

export async function copyItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('CopyItem', 'ErrorMailboxNotFound', 'Mailbox not found');

  const toFolderIdRaw = request['ToFolderId'] as Record<string, unknown> | undefined;
  const targetFolderId = await resolveFolderId(toFolderIdRaw, mailbox.id);
  if (!targetFolderId) return errorResponse('CopyItem', 'ErrorFolderNotFound', 'Target folder not found');

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];
  const ids = Array.isArray(itemIdRaw) ? itemIdRaw : itemIdRaw ? [itemIdRaw] : [];

  const results: { id: string; changeKey: string }[] = [];
  for (const item of ids) {
    const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
    if (!id) continue;

    const msg = await prisma.message.findFirst({
      where: { id, folder: { mailboxId: mailbox.id } },
      select: { id: true },
    });
    if (!msg) continue;

    // Copy with a fresh UID + modSeq (message store); attachment rows are duplicated too.
    const { mapping, modSeq } = await prisma.$transaction((tx) => copyMessages(
      tx, [id], targetFolderId, { targetMailboxId: mailbox.id },
    ));
    const copy = mapping[0];
    if (copy) results.push({ id: copy.newId, changeKey: String(modSeq) });
  }

  return soapEnvelope((body) => {
    const response = body.ele('m:CopyItemResponse').ele('m:ResponseMessages');
    for (const r of results) {
      response
        .ele('m:CopyItemResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError').up()
        .ele('m:Items')
        .ele('t:Message')
        .ele('t:ItemId', { Id: r.id, ChangeKey: r.changeKey });
    }
  });
}
