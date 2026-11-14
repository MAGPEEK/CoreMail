import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { soapEnvelope, errorResponse } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';
import { buildEwsOutboundJob, enqueueEwsOutbound, splitEwsBody } from './outbound-submit.js';

const log = createLogger('ews:create-item');

export async function createItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const messageDisposition = (request['$'] as Record<string, string> | undefined)?.[
    'MessageDisposition'
  ] ?? 'SaveOnly';

  const items = request['Items'] as Record<string, unknown> | undefined;
  const message = items?.['Message'] as Record<string, unknown> | undefined;
  const calendarItem = items?.['CalendarItem'] as Record<string, unknown> | undefined;

  if (calendarItem) {
    return createCalendarItem(calendarItem, user);
  }

  if (!message) {
    return errorResponse('CreateItem', 'InvalidArgument', 'No Message or CalendarItem provided');
  }

  const subject = String((message['Subject'] as string | undefined) ?? '');
  const { bodyText, bodyHtml } = splitEwsBody(message['Body']);

  const toAddrs  = extractAddresses(message['ToRecipients']  as Record<string, unknown> | undefined);
  const ccAddrs  = extractAddresses(message['CcRecipients']  as Record<string, unknown> | undefined);
  const bccAddrs = extractAddresses(message['BccRecipients'] as Record<string, unknown> | undefined);

  // Send first (before the Sent copy exists): enqueue on the BullMQ
  // `smtp-outbound` queue. From is always the authenticated user.
  if (messageDisposition === 'SendOnly' || messageDisposition === 'SendAndSaveCopy') {
    const job = buildEwsOutboundJob({
      userId: user.userId, email: user.email, subject, bodyText, bodyHtml,
      to: toAddrs, cc: ccAddrs, bcc: bccAddrs,
    });
    if (!job) {
      return errorResponse('CreateItem', 'ErrorInvalidRecipients', 'At least one recipient is required');
    }
    try {
      await enqueueEwsOutbound(job);
      log.info({ userId: user.userId, jobId: job.messageId, rcpt: job.to.length }, 'EWS mail enqueued');
    } catch (err) {
      log.error({ err, userId: user.userId }, 'EWS outbound enqueue failed');
      return errorResponse('CreateItem', 'ErrorInternalServerError', 'Message could not be submitted');
    }
  }

  // Find or create Drafts/Sent folder
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return errorResponse('CreateItem', 'ErrorMailboxNotFound', 'Mailbox not found');

  const folderName = messageDisposition === 'SaveOnly' ? 'Drafts' : 'Sent';
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: folderName },
  });
  if (!folder) return errorResponse('CreateItem', 'ErrorFolderNotFound', 'Folder not found');

  // Allocate UID
  const updatedMailbox = await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: { uidNext: { increment: 1 } },
  });
  const uid = updatedMailbox.uidNext - 1;

  const msg = await prisma.message.create({
    data: {
      folderId: folder.id,
      uid,
      modSeq: BigInt(Date.now()),
      flags: messageDisposition !== 'SaveOnly' ? ['\\Seen'] : ['\\Draft'],
      subject,
      fromAddr: user.email,
      toAddrs,
      ccAddrs,
      bccAddrs,
      date: new Date(),
      bodyText,
      bodyHtml,
      rawSize: bodyText.length + bodyHtml.length,
      storagePath: '',
    },
  });

  await prisma.folder.update({
    where: { id: folder.id },
    data: { totalCount: { increment: 1 } },
  });

  return soapEnvelope((body) => {
    body
      .ele('m:CreateItemResponse')
      .ele('m:ResponseMessages')
      .ele('m:CreateItemResponseMessage', { ResponseClass: 'Success' })
      .ele('m:ResponseCode').txt('NoError').up()
      .ele('m:Items')
      .ele('t:Message')
      .ele('t:ItemId', { Id: msg.id, ChangeKey: String(msg.modSeq) });
  });
}

async function createCalendarItem(
  item: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  

  const summary = String((item['Subject'] as string | undefined) ?? '');
  const startStr = String((item['Start'] as string | undefined) ?? new Date().toISOString());
  const endStr = String(
    (item['End'] as string | undefined) ?? new Date(Date.now() + 3600000).toISOString(),
  );

  const calendar = await prisma.calendar.findFirst({ where: { userId: user.userId } });
  if (!calendar) {
    return errorResponse('CreateItem', 'ErrorCalendarFolderNotFound', 'Calendar not found');
  }

  const { randomUUID } = await import('node:crypto');
  const eventUid = randomUUID();
  const event = await prisma.calendarEvent.create({
    data: {
      calendarId: calendar.id,
      uid: eventUid,
      summary,
      dtStart: new Date(startStr),
      dtEnd: new Date(endStr),
      icalData: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${eventUid}\r\nSUMMARY:${summary}\r\nDTSTART:${startStr}\r\nDTEND:${endStr}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
    },
  });

  return soapEnvelope((body) => {
    body
      .ele('m:CreateItemResponse')
      .ele('m:ResponseMessages')
      .ele('m:CreateItemResponseMessage', { ResponseClass: 'Success' })
      .ele('m:ResponseCode').txt('NoError').up()
      .ele('m:Items')
      .ele('t:CalendarItem')
      .ele('t:ItemId', { Id: event.id, ChangeKey: '1' });
  });
}

function extractAddresses(raw: Record<string, unknown> | undefined): string[] {
  if (!raw) return [];
  const mailboxes = raw['Mailbox'];
  if (!mailboxes) return [];
  const list = Array.isArray(mailboxes) ? mailboxes : [mailboxes];
  return list
    .map((m) => String((m as Record<string, string>)['EmailAddress'] ?? ''))
    .filter(Boolean);
}
