import { getPrisma } from '@coremail/storage';
import { soapEnvelope } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

const WELL_KNOWN_FOLDERS: Record<string, string> = {
  inbox: 'INBOX',
  deleteditems: 'Trash',
  sentitems: 'Sent',
  drafts: 'Drafts',
  junkemail: 'Junk',
  outbox: 'Outbox',
};

function mapFlagToEws(flags: string[]): string {
  if (flags.includes('\\Seen')) return 'Read';
  return 'Unread';
}

function formatEwsDate(date: Date): string {
  return date.toISOString();
}

export async function findItem(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const traversal = (request['$'] as Record<string, string> | undefined)?.['Traversal'] ?? 'Shallow';
  const itemShape = request['ItemShape'] as Record<string, unknown> | undefined;
  const folderIds = request['ParentFolderIds'] as Record<string, unknown> | undefined;

  const baseShape =
    (itemShape?.['BaseShape'] as string | undefined) ?? 'Default';

  // Determine folder
  const distinguishedFolderId = folderIds?.['DistinguishedFolderId'] as
    | Record<string, string>
    | undefined;
  const folderName = distinguishedFolderId?.['$']?.['Id'] ?? 'inbox';
  const systemName = WELL_KNOWN_FOLDERS[folderName.toLowerCase()] ?? 'INBOX';

  // Calendar view handling
  const calendarView = request['CalendarView'] as Record<string, unknown> | undefined;
  if (calendarView) {
    return findCalendarItems(calendarView, user, baseShape);
  }

  // Paging
  const indexedPageView = request['IndexedPageItemView'] as
    | Record<string, string>
    | undefined;
  const maxReturn = parseInt(indexedPageView?.['$']?.['MaxReturnsPerPage'] ?? '50', 10);
  const offset = parseInt(indexedPageView?.['$']?.['Offset'] ?? '0', 10);

  // Find user's mailbox → folder
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: user.userId } });
  if (!mailbox) return buildEmptyFindItemResponse(0, false);

  const folder = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: systemName },
  });
  if (!folder) return buildEmptyFindItemResponse(0, false);

  const messages = await prisma.message.findMany({
    where: { folderId: folder.id, deletedAt: null },
    orderBy: { date: 'desc' },
    take: maxReturn,
    skip: offset,
    select: {
      id: true,
      uid: true,
      subject: true,
      fromAddr: true,
      toAddrs: true,
      date: true,
      flags: true,
      rawSize: true,
      modSeq: true,
    },
  });

  const total = await prisma.message.count({
    where: { folderId: folder.id, deletedAt: null },
  });

  const hasMore = offset + messages.length < total;

  return soapEnvelope((body) => {
    const response = body
      .ele('m:FindItemResponse')
      .ele('m:ResponseMessages')
      .ele('m:FindItemResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt('NoError');

    const rootFolder = response
      .ele('m:RootFolder', {
        TotalItemsInView: String(total),
        IncludesLastItemInRange: hasMore ? 'false' : 'true',
      })
      .ele('t:Items');

    for (const msg of messages) {
      const item = rootFolder.ele('t:Message');
      item.ele('t:ItemId', { Id: msg.id, ChangeKey: String(msg.modSeq) });
      item.ele('t:Subject').txt(msg.subject ?? '');
      item.ele('t:IsRead').txt(msg.flags.includes('\\Seen') ? 'true' : 'false');
      item.ele('t:DateTimeReceived').txt(formatEwsDate(msg.date));
      item.ele('t:DateTimeSent').txt(formatEwsDate(msg.date));
      item.ele('t:Size').txt(String(msg.rawSize));

      if (baseShape !== 'IdOnly') {
        item.ele('t:From')
          .ele('t:Mailbox')
          .ele('t:EmailAddress').txt(msg.fromAddr);

        const toRecips = item.ele('t:ToRecipients');
        for (const addr of msg.toAddrs.slice(0, 5)) {
          toRecips.ele('t:Mailbox').ele('t:EmailAddress').txt(addr);
        }
      }
    }
  });
}

async function findCalendarItems(
  calendarView: Record<string, unknown>,
  user: EwsUser,
  _baseShape: string,
): Promise<string> {
  const prisma = getPrisma();
  const attrs = calendarView['$'] as Record<string, string> | undefined;
  const startDate = attrs?.['StartDate'] ? new Date(attrs['StartDate']) : new Date();
  const endDate = attrs?.['EndDate']
    ? new Date(attrs['EndDate'])
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const calendars = await prisma.calendar.findMany({ where: { userId: user.userId } });
  const calendarIds = calendars.map((c) => c.id);

  const events = await prisma.calendarEvent.findMany({
    where: {
      calendarId: { in: calendarIds },
      dtStart: { gte: startDate, lte: endDate },
    },
    orderBy: { dtStart: 'asc' },
  });

  return soapEnvelope((body) => {
    const response = body
      .ele('m:FindItemResponse')
      .ele('m:ResponseMessages')
      .ele('m:FindItemResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt('NoError');

    const rootFolder = response
      .ele('m:RootFolder', {
        TotalItemsInView: String(events.length),
        IncludesLastItemInRange: 'true',
      })
      .ele('t:Items');

    for (const event of events) {
      const item = rootFolder.ele('t:CalendarItem');
      item.ele('t:ItemId', { Id: event.id, ChangeKey: '1' });
      item.ele('t:Subject').txt(event.summary ?? '');
      item.ele('t:Start').txt(formatEwsDate(event.dtStart));
      item.ele('t:End').txt(formatEwsDate(event.dtEnd));
      item.ele('t:IsAllDayEvent').txt('false');
      item.ele('t:LegacyFreeBusyStatus').txt('Busy');
      item.ele('t:CalendarItemType').txt(event.recurring ? 'RecurringMaster' : 'Single');
    }
  });
}

function buildEmptyFindItemResponse(total: number, hasMore: boolean): string {
  return soapEnvelope((body) => {
    const response = body
      .ele('m:FindItemResponse')
      .ele('m:ResponseMessages')
      .ele('m:FindItemResponseMessage', { ResponseClass: 'Success' });

    response.ele('m:ResponseCode').txt('NoError');
    response
      .ele('m:RootFolder', {
        TotalItemsInView: String(total),
        IncludesLastItemInRange: 'true',
      })
      .ele('t:Items');
  });
}
