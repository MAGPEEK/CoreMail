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

export async function syncFolderHierarchy(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('SyncFolderHierarchy', 'ErrorMailboxNotFound', 'Mailbox not found');

  const folders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: {
      id: true,
      name: true,
      parentId: true,
      totalCount: true,
      unreadCount: true,
      changeKey: true,
    },
  });

  // Sync state is a timestamp — in production use change tracking
  const syncState = String(Date.now());

  return soapEnvelope((body) => {
    const response = body
      .ele('m:SyncFolderHierarchyResponse')
      .ele('m:ResponseMessages')
      .ele('m:SyncFolderHierarchyResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt('NoError');
    response.ele('m:SyncState').txt(syncState);
    response.ele('m:IncludesLastFolderInRange').txt('true');

    const changes = response.ele('m:Changes');

    for (const folder of folders) {
      const create = changes.ele('t:Create');
      const folderEle = create.ele('t:Folder');
      folderEle.ele('t:FolderId', { Id: folder.id, ChangeKey: folder.changeKey || '1' });
      folderEle.ele('t:DisplayName').txt(folder.name);
      folderEle.ele('t:TotalCount').txt(String(folder.totalCount));
      folderEle.ele('t:UnreadCount').txt(String(folder.unreadCount));

      if (folder.parentId) {
        folderEle.ele('t:ParentFolderId', { Id: folder.parentId, ChangeKey: '1' });
      }
    }
  });
}

export async function syncFolderItems(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const folderIdRaw = request['SyncFolderId'] as Record<string, unknown> | undefined;
  const distinguishedId = folderIdRaw?.['DistinguishedFolderId'] as
    | Record<string, Record<string, string>>
    | undefined;
  const folderId = folderIdRaw?.['FolderId'] as
    | Record<string, Record<string, string>>
    | undefined;

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('SyncFolderItems', 'ErrorMailboxNotFound', 'Mailbox not found');

  let folder;
  if (distinguishedId) {
    const name = WELL_KNOWN_FOLDERS[distinguishedId['$']?.['Id']?.toLowerCase() ?? ''] ?? 'INBOX';
    folder = await prisma.folder.findFirst({ where: { mailboxId: mailbox.id, name } });
  } else if (folderId) {
    folder = await prisma.folder.findFirst({
      where: { id: folderId['$']?.['Id'], mailboxId: mailbox.id },
    });
  }

  if (!folder) return errorResponse('SyncFolderItems', 'ErrorFolderNotFound', 'Folder not found');

  const maxChanges = parseInt(String(request['MaxChangesReturned'] ?? '512'), 10);

  const messages = await prisma.message.findMany({
    where: { folderId: folder.id },
    orderBy: { modSeq: 'desc' },
    take: maxChanges,
    select: {
      id: true,
      modSeq: true,
      flags: true,
      subject: true,
      date: true,
      deletedAt: true,
    },
  });

  const syncState = String(Date.now());

  return soapEnvelope((body) => {
    const response = body
      .ele('m:SyncFolderItemsResponse')
      .ele('m:ResponseMessages')
      .ele('m:SyncFolderItemsResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt('NoError');
    response.ele('m:SyncState').txt(syncState);
    response.ele('m:IncludesLastItemInRange').txt('true');

    const changes = response.ele('m:Changes');

    for (const msg of messages) {
      if (msg.deletedAt) {
        changes
          .ele('t:Delete')
          .ele('t:ItemId', { Id: msg.id, ChangeKey: String(msg.modSeq) });
      } else {
        const create = changes.ele('t:Create');
        create
          .ele('t:Message')
          .ele('t:ItemId', { Id: msg.id, ChangeKey: String(msg.modSeq) }).up()
          .ele('t:Subject').txt(msg.subject ?? '').up()
          .ele('t:IsRead').txt(msg.flags.includes('\\Seen') ? 'true' : 'false').up()
          .ele('t:DateTimeReceived').txt(msg.date.toISOString());
      }
    }
  });
}
