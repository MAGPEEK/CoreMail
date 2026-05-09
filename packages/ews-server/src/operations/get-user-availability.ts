import { getPrisma } from '@coremail/storage';
import { soapEnvelope } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';

export async function getUserAvailability(
  request: Record<string, unknown>,
  _user: EwsUser,
): Promise<string> {
  const prisma = getPrisma();

  const mailboxDataArray = request['MailboxDataArray'] as Record<string, unknown> | undefined;
  const mailboxDataRaw = mailboxDataArray?.['MailboxData'];
  const mailboxDataList = Array.isArray(mailboxDataRaw)
    ? mailboxDataRaw
    : mailboxDataRaw
    ? [mailboxDataRaw]
    : [];

  const timeWindow = request['FreeBusyViewOptions'] as Record<string, unknown> | undefined;
  const windowRaw = timeWindow?.['TimeWindow'] as Record<string, string> | undefined;
  const startTime = windowRaw?.['StartTime'] ? new Date(windowRaw['StartTime']) : new Date();
  const endTime = windowRaw?.['EndTime']
    ? new Date(windowRaw['EndTime'])
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return soapEnvelope((body) => {
    const response = body
      .ele('m:GetUserAvailabilityResponse')
      .ele('m:FreeBusyResponseArray');

    for (const mailboxData of mailboxDataList) {
      const mbData = mailboxData as Record<string, unknown>;
      const mailbox = mbData['Email'] as Record<string, string> | undefined;
      const email = mailbox?.['Address'] ?? '';

      const freeBusyResponse = response.ele('m:FreeBusyResponse');
      freeBusyResponse
        .ele('m:ResponseMessage', { ResponseClass: 'Success' })
        .ele('m:ResponseCode').txt('NoError');

      const freeBusyView = freeBusyResponse.ele('m:FreeBusyView');
      freeBusyView.ele('t:FreeBusyViewType').txt('FreeBusy');

      const calendarEventArray = freeBusyView.ele('t:CalendarEventArray');

      // Fetch busy times for this user
      const dbUser = prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      void dbUser.then(async (u) => {
        if (!u) return;
        const calendars = await prisma.calendar.findMany({ where: { userId: u.id } });
        const events = await prisma.calendarEvent.findMany({
          where: {
            calendarId: { in: calendars.map((c) => c.id) },
            dtStart: { gte: startTime },
            dtEnd: { lte: endTime },
          },
        });
        for (const event of events) {
          calendarEventArray
            .ele('t:CalendarEvent')
            .ele('t:StartTime').txt(event.dtStart.toISOString()).up()
            .ele('t:EndTime').txt(event.dtEnd.toISOString()).up()
            .ele('t:BusyType').txt('Busy');
        }
      });
    }
  });
}
