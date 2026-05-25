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

function principalHref(userId: string): string {
  return `/dav/principals/${userId}/`;
}

/**
 * v3.18.14 Calendar Sharing — CalDAV-Helper.
 * v3.18.15: WRITE-Sharing freigeschaltet; volle DAV ACL nach RFC 3744.
 *
 * Liefert die Permission des `viewerUserId` auf `calendarId`:
 *  - 'OWNER' wenn `viewerUserId === calendar.userId`
 *  - 'WRITE' / 'READ' wenn CalendarShare existiert
 *  - null wenn kein Zugriff besteht
 */
async function getDavAccess(
  viewerUserId: string,
  calendarId: string,
): Promise<{ permission: 'OWNER' | 'WRITE' | 'READ'; ownerId: string } | null> {
  const cal = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { userId: true },
  });
  if (!cal) return null;
  if (cal.userId === viewerUserId) return { permission: 'OWNER', ownerId: cal.userId };

  const share = await prisma.calendarShare.findUnique({
    where: { calendarId_granteeId: { calendarId, granteeId: viewerUserId } },
    select: { permission: true },
  });
  if (!share) return null;
  return {
    permission: share.permission === 'WRITE' ? 'WRITE' : 'READ',
    ownerId: cal.userId,
  };
}

/**
 * v3.18.15 Privacy-Masking auf CalDAV-Antworten.
 *  - PUBLIC: unverändert
 *  - PRIVATE: SUMMARY → "Beschäftigt", DESCRIPTION/LOCATION entfernt
 *  - CONFIDENTIAL: gibt null zurück → Event wird ausgeblendet
 *  Owner sieht ALLES.
 */
function maskIcalForGrantee(icalData: string, classification: string, isOwner: boolean): string | null {
  if (isOwner) return icalData;
  const cls = (classification ?? 'PUBLIC').toUpperCase();
  if (cls === 'CONFIDENTIAL') return null;
  if (cls === 'PRIVATE') {
    return icalData
      .replace(/^SUMMARY:.*$/m, 'SUMMARY:Beschäftigt')
      .replace(/^DESCRIPTION:.*$/m, 'DESCRIPTION:')
      .replace(/^LOCATION:.*$/m, 'LOCATION:');
  }
  return icalData;
}

/** RFC 3744 — privilege set element je nach Permission. */
function appendPrivilegeSet(
  cups: ReturnType<typeof create>,
  permission: 'OWNER' | 'WRITE' | 'READ',
): void {
  if (permission === 'OWNER') {
    cups.ele('d:privilege').ele('d:all');
    cups.ele('d:privilege').ele('d:read');
    cups.ele('d:privilege').ele('d:write');
    cups.ele('d:privilege').ele('d:write-properties');
    cups.ele('d:privilege').ele('d:write-content');
  } else if (permission === 'WRITE') {
    cups.ele('d:privilege').ele('d:read');
    cups.ele('d:privilege').ele('d:write');
    cups.ele('d:privilege').ele('d:write-content');
    cups.ele('d:privilege').ele('d:bind');     // create new resources
    cups.ele('d:privilege').ele('d:unbind');   // delete resources
  } else {
    cups.ele('d:privilege').ele('d:read');
    cups.ele('d:privilege').ele('d:read-current-user-privilege-set');
  }
}

/** RFC 3744 — minimal-konformer <DAV:acl>-Block. */
function appendAclProperty(
  prop: ReturnType<typeof create>,
  ownerId: string,
  shares: Array<{ granteeId: string; permission: 'READ' | 'WRITE' }>,
): void {
  const acl = prop.ele('d:acl');

  // Owner ACE: all privileges
  const ownerAce = acl.ele('d:ace');
  ownerAce.ele('d:principal').ele('d:href').txt(principalHref(ownerId));
  ownerAce.ele('d:grant').ele('d:privilege').ele('d:all');

  // Grantee ACEs
  for (const s of shares) {
    const ace = acl.ele('d:ace');
    ace.ele('d:principal').ele('d:href').txt(principalHref(s.granteeId));
    const grant = ace.ele('d:grant');
    grant.ele('d:privilege').ele('d:read');
    if (s.permission === 'WRITE') {
      grant.ele('d:privilege').ele('d:write');
      grant.ele('d:privilege').ele('d:bind');
      grant.ele('d:privilege').ele('d:unbind');
    }
  }
}

// OPTIONS — advertise CalDAV capabilities + RFC 3744 ACL
caldavRouter.options('*', (req: Request, res: Response) => {
  res.set({
    Allow: 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCALENDAR, REPORT, ACL',
    DAV: '1, 2, 3, access-control, calendar-access, addressbook',
    'Content-Length': '0',
  });
  res.status(204).send();
});

// PROPFIND /:userId — list calendars (calendar-home-set)
caldavRouter.all('/calendars/:userId', async (req: Request, res: Response) => {
  if (req.method !== 'PROPFIND') { res.status(405).send('Method Not Allowed'); return; }

  const { userId } = req.params as { userId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const [owned, shares] = await Promise.all([
    prisma.calendar.findMany({ where: { userId } }),
    prisma.calendarShare.findMany({
      where: { granteeId: userId },
      select: {
        permission: true,
        calendar: { select: { id: true, name: true, userId: true } },
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
    prop.ele('d:owner').ele('d:href').txt(principalHref(userId));
    const cups = prop.ele('d:current-user-privilege-set');
    appendPrivilegeSet(cups, 'OWNER');
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
    prop.ele('d:owner').ele('d:href').txt(principalHref(s.calendar.userId));
    const cups = prop.ele('d:current-user-privilege-set');
    appendPrivilegeSet(cups, s.permission === 'WRITE' ? 'WRITE' : 'READ');
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

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const calendar = await prisma.calendar.findUnique({ where: { id: calendarId } });
  if (!calendar) { res.status(404).send('Not Found'); return; }

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId },
    select: { id: true, dtStart: true, dtEnd: true, summary: true, classification: true },
  });

  // ACL-Liste nur für Owner-Sicht relevant (Grantees sehen ihre eigene Permission via cups)
  const shares = access.permission === 'OWNER'
    ? await prisma.calendarShare.findMany({
        where: { calendarId },
        select: { granteeId: true, permission: true },
      })
    : [];

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV });

  const calResponse = doc.ele('d:response');
  calResponse.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/`);
  const calPropstat = calResponse.ele('d:propstat');
  const calProp = calPropstat.ele('d:prop');
  calProp.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
  calProp.ele('d:displayname').txt(access.permission === 'OWNER' ? calendar.name : `[Geteilt] ${calendar.name}`);
  calProp.ele('d:getctag', { 'xmlns:cs': NS_CS }).txt(String(Date.now()));
  calProp.ele('d:owner').ele('d:href').txt(principalHref(access.ownerId));
  const cups = calProp.ele('d:current-user-privilege-set');
  appendPrivilegeSet(cups, access.permission);
  if (access.permission === 'OWNER') {
    appendAclProperty(calProp, access.ownerId, shares);
  }
  calPropstat.ele('d:status').txt('HTTP/1.1 200 OK');

  // Event-Listing — Confidential werden ausgeblendet, sonst nur href+etag (Body via GET/REPORT)
  for (const event of events) {
    if (access.permission !== 'OWNER' && (event.classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL') continue;
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

// GET /:userId/:calendarId/:eventId.ics — fetch iCalendar data (mit Privacy-Masking)
caldavRouter.get('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const id = eventId.replace(/\.ics$/, '');
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
    select: { id: true, icalData: true, classification: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  const masked = maskIcalForGrantee(event.icalData, event.classification, access.permission === 'OWNER');
  if (masked === null) { res.status(404).send('Not Found'); return; }

  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: `"${event.id}"`,
  });
  res.send(masked);
});

// PUT /:userId/:calendarId/:eventId.ics — create or update event
// v3.18.15: OWNER + WRITE-Grantees dürfen schreiben
caldavRouter.put('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Calendar Not Found'); return; }
  if (access.permission === 'READ') {
    res.status(403).send('Forbidden — READ-only share, no write access');
    return;
  }

  const id = eventId.replace(/\.ics$/, '');
  const icalData = typeof req.body === 'string' ? req.body : '';
  if (!icalData) { res.status(400).send('Bad Request'); return; }

  const dtStartMatch = /DTSTART[^:]*:([\d\w]+)/.exec(icalData);
  const dtEndMatch = /DTEND[^:]*:([\d\w]+)/.exec(icalData);
  const summaryMatch = /SUMMARY:(.+)/.exec(icalData);
  const recurringMatch = /RRULE:/.test(icalData);
  const classMatch = /^CLASS:(PUBLIC|PRIVATE|CONFIDENTIAL)\s*$/m.exec(icalData);

  const dtStart = dtStartMatch ? parseIcalDate(dtStartMatch[1] ?? '') : new Date();
  const dtEnd = dtEndMatch ? parseIcalDate(dtEndMatch[1] ?? '') : new Date(Date.now() + 3600000);
  const summary = summaryMatch?.[1]?.trim() ?? '';
  const classification = (classMatch?.[1] ?? 'PUBLIC').toUpperCase();

  const existing = await prisma.calendarEvent.findFirst({
    where: { id },
    select: { id: true, calendarId: true, classification: true },
  });

  if (existing) {
    // Cross-Calendar-Manipulation verhindern
    if (existing.calendarId !== calendarId) {
      res.status(403).send('Forbidden — event belongs to another calendar');
      return;
    }
    // Grantee mit WRITE darf KEINE Events ändern, die OWNER als CONFIDENTIAL markiert hat
    if (access.permission !== 'OWNER' && (existing.classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL') {
      res.status(403).send('Forbidden — event is confidential');
      return;
    }
    await prisma.calendarEvent.update({
      where: { id },
      data: { icalData, summary, dtStart, dtEnd, recurring: recurringMatch, classification },
    });
    log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event updated');
    res.set('ETag', `"${id}"`).status(204).send();
  } else {
    await prisma.calendarEvent.create({
      data: { id, uid: id, calendarId, icalData, summary, dtStart, dtEnd, recurring: recurringMatch, classification },
    });
    log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event created');
    res.set('ETag', `"${id}"`).status(201).send();
  }
});

// DELETE /:userId/:calendarId/:eventId.ics — OWNER + WRITE-Grantees
caldavRouter.delete('/calendars/:userId/:calendarId/:eventId', async (req: Request, res: Response) => {
  const { userId, calendarId, eventId } = req.params as {
    userId: string; calendarId: string; eventId: string;
  };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }
  if (access.permission === 'READ') {
    res.status(403).send('Forbidden — READ-only share, no delete');
    return;
  }

  const id = eventId.replace(/\.ics$/, '');
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
    select: { id: true, classification: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  // WRITE-Grantees dürfen keine CONFIDENTIAL-Events löschen
  if (access.permission !== 'OWNER' && (event.classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL') {
    res.status(403).send('Forbidden — event is confidential');
    return;
  }

  await prisma.calendarEvent.delete({ where: { id } });
  log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event deleted');
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

// REPORT — calendar-query for sync (mit Privacy-Masking)
caldavRouter.all('/calendars/:userId/:calendarId', async (req: Request, res: Response, next) => {
  if (req.method !== 'REPORT') { next(); return; }

  const { userId, calendarId } = req.params as { userId: string; calendarId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId },
    select: { id: true, icalData: true, classification: true },
  });

  const doc = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV });

  for (const event of events) {
    const masked = maskIcalForGrantee(event.icalData, event.classification, access.permission === 'OWNER');
    if (masked === null) continue; // CONFIDENTIAL für Grantee
    const r = doc.ele('d:response');
    r.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/${event.id}.ics`);
    const ps = r.ele('d:propstat');
    ps.ele('d:prop')
      .ele('d:getetag').txt(`"${event.id}"`).up()
      .ele('c:calendar-data').txt(masked);
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  }

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
});

function parseIcalDate(value: string): Date {
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
