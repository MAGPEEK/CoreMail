import { prisma } from '@coremail/storage';
import { soapEnvelope, errorResponse } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

function formatEwsDate(date: Date): string {
  return date.toISOString();
}

export async function getItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const itemShape = request['ItemShape'] as Record<string, unknown> | undefined;
  const baseShape = (itemShape?.['BaseShape'] as string | undefined) ?? 'Default';

  const itemIds = request['ItemIds'] as Record<string, unknown> | undefined;
  const itemIdRaw = itemIds?.['ItemId'];

  const ids: string[] = [];
  if (Array.isArray(itemIdRaw)) {
    for (const item of itemIdRaw) {
      const id = (item as Record<string, Record<string, string>>)['$']?.['Id'];
      if (id) ids.push(id);
    }
  } else if (itemIdRaw) {
    const id = (itemIdRaw as Record<string, Record<string, string>>)['$']?.['Id'];
    if (id) ids.push(id);
  }

  if (ids.length === 0) {
    return errorResponse('GetItem', 'InvalidArgument', 'No ItemId provided');
  }

  const messages = await prisma.message.findMany({
    where: { id: { in: ids }, deletedAt: null },
    include: { attachments: true, folder: { include: { mailbox: true } } },
  });

  // Verify ownership
  const owned = messages.filter((m) => (m.folder.mailbox.userId ?? '') === user.userId);

  return soapEnvelope((body) => {
    const response = body
      .ele('m:GetItemResponse')
      .ele('m:ResponseMessages');

    for (const msg of owned) {
      const msgResp = response
        .ele('m:GetItemResponseMessage', { ResponseClass: 'Success' });

      msgResp.ele('m:ResponseCode').txt('NoError');

      const item = msgResp.ele('m:Items').ele('t:Message');
      item.ele('t:ItemId', { Id: msg.id, ChangeKey: String(msg.modSeq) });
      item.ele('t:Subject').txt(msg.subject ?? '');
      item.ele('t:IsRead').txt(msg.flags.includes('\\Seen') ? 'true' : 'false');
      item.ele('t:DateTimeReceived').txt(formatEwsDate(msg.date));
      item.ele('t:DateTimeSent').txt(formatEwsDate(msg.date));
      item.ele('t:Size').txt(String(msg.rawSize));
      item.ele('t:Importance').txt('Normal');

      if (baseShape !== 'IdOnly') {
        item.ele('t:From')
          .ele('t:Mailbox')
          .ele('t:EmailAddress').txt(msg.fromAddr);

        const toRecips = item.ele('t:ToRecipients');
        for (const addr of msg.toAddrs) {
          toRecips.ele('t:Mailbox').ele('t:EmailAddress').txt(addr);
        }

        if (msg.ccAddrs.length > 0) {
          const ccRecips = item.ele('t:CcRecipients');
          for (const addr of msg.ccAddrs) {
            ccRecips.ele('t:Mailbox').ele('t:EmailAddress').txt(addr);
          }
        }

        if (baseShape === 'AllProperties') {
          item.ele('t:Body', { BodyType: 'HTML' }).txt(msg.bodyHtml ?? msg.bodyText ?? '');

          if (msg.attachments.length > 0) {
            const attEle = item.ele('t:Attachments');
            for (const att of msg.attachments) {
              attEle
                .ele('t:FileAttachment')
                .ele('t:AttachmentId', { Id: att.id }).up()
                .ele('t:Name').txt(att.filename).up()
                .ele('t:ContentType').txt(att.mimeType).up()
                .ele('t:Size').txt(String(att.size));
            }
          }
        }
      }
    }
  });
}
