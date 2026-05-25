import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { create } from 'xmlbuilder2';

const log = createLogger('caldav');

export const caldavRouter: RouterType = Router();

const NS_DAV = 'DAV:';
const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
const NS_CS = 'http://calendarserver.org/ns/';

function xmlResponse(root: ReturnType<typeof create>): string {
  return root.end({ prettyPrint: false });
}

function caldavBase(userId: string): string {
  return `/dav/calendars/${userId}`;
}

/**
 * v3.18.14 Calendar Sharing — CalDAV-Helper.
 * Liefert die Permission des `viewerUserId` auf `calendarId`:
 *  - 'OWNER' wenn `viewerUserId === calendar.userId`
 *  - 'WRITE' / 'READ' wenn CalendarShare existiert
 *  - null wenn kein Zugriff besteht
 *
 * TODO v3.18.15: Volle DAV-ACL nach RFC 3744 (`<DAV:acl>`, `<DAV:principal-URL>`,
 * `<DAV:owner>`) + WRITE-Sharing über CalDAV (PUT/DELETE für WRITE-Grantees).
 * Aktuell: Grantees können nur lesen (PROPFIND/REPORT/GET).
 */
async function getDavPermission(
  viewerUserId: string,
  calendarId: string,
): Promise<'OWNER' | 'WRITE' | 'READ' | null> {
  const cal = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { userId: true },
  });
  if (!cal) return null;
  if (cal.userId === viewerUserId) return 'OWNER';

  const share = await prisma.calendarShare.findUnique({
    where: { calendarId_granteeId: { calendarId, granteeId: viewerUserId } },
    select: { permission: true },
  });
  if (!share) return null;
  return share.permission === 'WRITE' ? 'WRITE' : 'READ';
}

// OPTIONS — advertise CalDAV capabilities
caldavRouter.options('*', (req: Request, res: Response) => {
  res.set({
    Allow: 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCALENDAR, REPORT',
    DAV: '1, 2, 3, calendar-access, addressbook',
    'Content-Length': '0',
  });
  res.status(204).send();
});

// PROPFIND /:userId — list calendars (calendar-home-set)
// User sieht eigene Kalender + alle Kalender, die andere User mit ihm geteilt haben.
caldavRouter.all('/calendars/:userId', async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  // Eigene + geteilte Kalender (READ-Shares reichen für Listing).
  const [owned, shares] = await Promise.all([
    prisma.calendar.findMany({ where: { userId } }),
    prisma.calendarShare.findMany({
      where: { granteeId: userId },
      select: {
        permission: true,
        calendar: { select: { id: true, name: true } },
      },
    }),
  ]);

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV });

  for (const cal of owned) {
    const href = `${caldavBase(userId)}/${cal.id}/`;
    const response = doc.ele('d:response');
    response.ele('d:href').txt(href);
    const propstat = response.ele('d:propstat');
    const prop = propstat.ele('d:prop');
    prop.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
    prop.ele('d:displayname').txt(cal.name);
    prop.ele('d:getctag', { 'xmlns:cs': NS_CS }).txt(String(Date.now()));
    prop.ele('c:supported-calendar-component-set')
      .ele('c:comp', { name: 'VEVENT' }).up()
      .ele('c:comp', { name: 'VTODO' });
    // Owner sieht alle Privilegien
    const cups = prop.ele('d:current-user-privilege-set');
    cups.ele('d:privilege').ele('d:all');
    propstat.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  for (const s of shares) {
    const href = `${caldavBase(userId)}/${s.calendar.id}/`;
    const response = doc.ele('d:response');
    response.ele('d:href').txt(href);
    const propstat = response.ele('d:propstat');
    const prop = propstat.ele('d:prop');
    prop.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
    prop.ele('d:displayname').txt(`[Geteilt] ${s.calendar.name}`);
    prop.ele('d:getctag', { 'xmlns:cs': NS_CS }).txt(String(Date.now()));
    prop.ele('c:supported-calendar-component-set')
      .ele('c:comp', { name: 'VEVENT' }).up()
      .ele('c:comp', { name: 'VTODO' });
    // v3.18.14: read-only über CalDAV (WRITE-Shares folgen in v3.18.15)
    const cups = prop.ele('d:current-user-privilege-set');
    cups.ele('d:privilege').ele('d:read');
    propstat.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

// PROPFIND /:userId/:calendarId — calendar properties + event list
caldavRouter.all('/calendars/:userId/:calendarId', async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId, calendarId } = req.params as { userId: string; calendarId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const perm = await getDavPermission(userId, calendarId);
  if (!perm) { res.status(404).send('Not Found'); return; }

  const calendar = await prisma.calendar.findUnique({ where: { id: calendarId } });
  if (!calendar) { res.status(404).send('Not Found'); return; }

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId },
    select: { id: true, dtStart: true, dtEnd: true, summary: true },
  });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV });

  // Calendar collection response
  const calResponse = doc.ele('d:response');
  calResponse.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/`);
  const calPropstat = calResponse.ele('d:propstat');
  const calProp = calPropstat.ele('d:prop');
  calProp.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
  calProp.ele('d:displayname').txt(perm === 'OWNER' ? calendar.name : `[Geteilt] ${calendar.name}`);
  calProp.ele('d:getctag', { 'xmlns:cs': NS_CS }).txt(String(Date.now()));
  // current-user-privilege-set
  const cups = calProp.ele('d:current-user-privilege-set');
  if (perm === 'OWNER') {
    cups.ele('d:privilege').ele('d:all');
  } else {
    // v3.18.14: alle Grantees read-only über CalDAV. WRITE-CalDAV in v3.18.15.
    cups.ele('d:privilege').ele('d:read');
  }
  calPropstat.ele('d:status').txt('HTTP/1.1 200 OK');

  // Each event as a response entry
  for (const event of events) {
    const evResponse = doc.ele('d:response');
    evResponse.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/${event.id}.ics`);
    const evPropstat = evResponse.ele('d:propstat');
    const evProp = evPropstat.ele('d:prop');
    evProp.ele('d:getetag').txt(`"${event.id}"`);
    evProp.ele('d:getcontenttype').txt('text/calendar; charset=utf-8');
    evPropstat.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

// GET /:userId/:calendarId/:eventId.ics — fetch iCalendar data
caldavRouter.get('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const perm = await getDavPermission(userId, calendarId);
  if (!perm) { res.status(404).send('Not Found'); return; }

  const id = eventId.replace(/\.ics$/, '');
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: `"${event.id}"`,
  });
  res.send(event.icalData);
});

// PUT /:userId/:calendarId/:eventId.ics — create or update event
// v3.18.14: Nur OWNER. WRITE-Grantees in v3.18.15.
caldavRouter.put('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const perm = await getDavPermission(userId, calendarId);
  if (perm !== 'OWNER') { res.status(403).send('Forbidden — only owner can write via CalDAV in v3.18.14'); return; }

  const id = eventId.replace(/\.ics$/, '');
  const icalData = typeof req.body === 'string' ? req.body : '';
  if (!icalData) { res.status(400).send('Bad Request'); return; }

  // Parse DTSTART, DTEND, SUMMARY from iCal
  const dtStartMatch = /DTSTART[^:]*:([\d\w]+)/.exec(icalData);
  const dtEndMatch = /DTEND[^:]*:([\d\w]+)/.exec(icalData);
  const summaryMatch = /SUMMARY:(.+)/.exec(icalData);
  const recurringMatch = /RRULE:/.test(icalData);

  const dtStart = dtStartMatch ? parseIcalDate(dtStartMatch[1] ?? '') : new Date();
  const dtEnd = dtEndMatch ? parseIcalDate(dtEndMatch[1] ?? '') : new Date(Date.now() + 3600000);
  const summary = summaryMatch?.[1]?.trim() ?? '';

  const calendar = await prisma.calendar.findFirst({ where: { id: calendarId, userId } });
  if (!calendar) { res.status(404).send('Calendar Not Found'); return; }

  const existing = await prisma.calendarEvent.findFirst({ where: { id } });

  if (existing) {
    await prisma.calendarEvent.update({
      where: { id },
      data: { icalData, summary, dtStart, dtEnd, recurring: recurringMatch },
    });
    log.info({ userId, eventId: id }, 'CalDAV event updated');
    res.set('ETag', `"${id}"`).status(204).send();
  } else {
    await prisma.calendarEvent.create({
      data: { id, uid: id, calendarId, icalData, summary, dtStart, dtEnd, recurring: recurringMatch },
    });
    log.info({ userId, eventId: id }, 'CalDAV event created');
    res.set('ETag', `"${id}"`).status(201).send();
  }
});

// DELETE /:userId/:calendarId/:eventId.ics — delete event (OWNER only in v3.18.14)
caldavRouter.delete('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const perm = await getDavPermission(userId, calendarId);
  if (perm !== 'OWNER') { res.status(403).send('Forbidden — only owner can delete via CalDAV in v3.18.14'); return; }

  const id = eventId.replace(/\.ics$/, '');
  const event = await prisma.calendarEvent.findFirst({ where: { id, calendarId } });
  if (!event) { res.status(404).send('Not Found'); return; }

  await prisma.calendarEvent.delete({ where: { id } });
  log.info({ userId, eventId: id }, 'CalDAV event deleted');
  res.status(204).send();
});

// MKCALENDAR — create new calendar (only OWNER under their own URL)
caldavRouter.all('/calendars/:userId/:calendarId', async (req: Request, res: Response, next) => {
  if (req.method !== 'MKCALENDAR') { next(); return; }

  const { userId, calendarId } = req.params as { userId: string; calendarId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  await prisma.calendar.create({
    data: { id: calendarId, userId, name: calendarId, color: '#0078D4' },
  });

  res.status(201).send();
});

// REPORT — calendar-query for sync (OWNER + READ/WRITE-Grantees)
caldavRouter.all('/calendars/:userId/:calendarId', async (req: Request, res: Response, next) => {
  if (req.method !== 'REPORT') { next(); return; }

  const { userId, calendarId } = req.params as { userId: string; calendarId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const perm = await getDavPermission(userId, calendarId);
  if (!perm) { res.status(404).send('Not Found'); return; }

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId },
    select: { id: true, icalData: true },
  });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV });

  for (const event of events) {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/${event.id}.ics`);
    const ps = r.ele('d:propstat');
    ps.ele('d:prop')
      .ele('d:getetag').txt(`"${event.id}"`).up()
      .ele('c:calendar-data').txt(event.icalData);
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

function parseIcalDate(value: string): Date {
  // Format: 20260509T140000Z or 20260509
  if (value.length === 8) {
    return new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`,
    );
  }
  if (value.endsWith('Z')) {
    return new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
      `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
    );
  }
  return new Date(value);
}
