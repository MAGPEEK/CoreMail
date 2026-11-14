import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import {
  parseCalendarObject,
  parseIcal,
  serializeComponent,
  escapeText,
  type IcalComponent,
} from '@coremail/core/calendar';
import { create } from 'xmlbuilder2';
import {
  asyncHandler,
  checkPreconditions,
  collectionTag,
  etagFor,
  parseReportRequest,
  preconditionHeaders,
  resourceIdFromHref,
  syncTokenFor,
} from '../dav-utils.js';

const log = createLogger('caldav');

export const caldavRouter: RouterType = Router();

const NS_DAV = 'DAV:';
const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
const NS_CS = 'http://calendarserver.org/ns/';

type XmlNode = ReturnType<typeof create>;

function xmlResponse(root: XmlNode): string {
  return root.end({ prettyPrint: false });
}

function caldavBase(userId: string): string {
  return `/dav/calendars/${userId}`;
}

function principalHref(userId: string): string {
  return `/dav/principals/${userId}/`;
}

function sendMultistatus(res: Response, doc: XmlNode): void {
  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
}

function newMultistatus(): XmlNode {
  return create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV, 'xmlns:cs': NS_CS });
}

/**
 * v3.18.14 Calendar Sharing — CalDAV helpers.
 * v3.18.15: WRITE sharing enabled; full DAV ACL per RFC 3744.
 *
 * Returns the permission of `viewerUserId` on `calendarId`:
 *  - 'OWNER' if `viewerUserId === calendar.userId`
 *  - 'WRITE' / 'READ' if a CalendarShare exists
 *  - null if there is no access
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

/** CTag / sync-token of a calendar collection: member count + newest updatedAt. */
async function calendarTag(calendarId: string): Promise<string> {
  const agg = await prisma.calendarEvent.aggregate({
    where: { calendarId },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return collectionTag(agg._count._all, agg._max.updatedAt ?? null);
}

/**
 * v3.18.15 privacy masking on CalDAV responses.
 *  - PUBLIC: unchanged
 *  - PRIVATE: SUMMARY → "Beschäftigt" (busy), DESCRIPTION/LOCATION/attendees/alarms removed
 *    (done on the parsed component tree, so folded or parameterised lines cannot leak)
 *  - CONFIDENTIAL: returns null → event is hidden
 *  The owner sees EVERYTHING.
 */
export function maskIcalForGrantee(icalData: string, classification: string, isOwner: boolean): string | null {
  if (isOwner) return icalData;
  const cls = (classification ?? 'PUBLIC').toUpperCase();
  if (cls === 'CONFIDENTIAL') return null;
  if (cls !== 'PRIVATE') return icalData;
  const root = parseIcal(icalData);
  if (!root) return null;
  const HIDDEN = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'ATTENDEE', 'ORGANIZER', 'COMMENT', 'ATTACH', 'CONTACT', 'URL', 'CATEGORIES', 'RESOURCES']);
  const maskEvent = (ev: IcalComponent): void => {
    ev.properties = ev.properties.filter((p) => !HIDDEN.has(p.name) && !p.name.startsWith('X-'));
    ev.properties.push({ name: 'SUMMARY', params: {}, value: escapeText('Beschäftigt') });
    ev.components = [];
  };
  const events = root.name === 'VEVENT' ? [root] : root.components.filter((c) => c.name === 'VEVENT');
  events.forEach(maskEvent);
  return serializeComponent(root) + '\r\n';
}

/** RFC 3744 — privilege set element depending on permission. */
function appendPrivilegeSet(
  cups: XmlNode,
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

/** RFC 3744 — minimally compliant <DAV:acl> block. */
function appendAclProperty(
  prop: XmlNode,
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

function appendCollectionProps(
  prop: XmlNode,
  displayName: string,
  ownerId: string,
  permission: 'OWNER' | 'WRITE' | 'READ',
  ctag: string,
): void {
  prop.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
  prop.ele('d:displayname').txt(displayName);
  prop.ele('cs:getctag').txt(ctag);
  prop.ele('d:sync-token').txt(syncTokenFor(ctag));
  prop.ele('c:supported-calendar-component-set')
    .ele('c:comp', { name: 'VEVENT' });
  const reports = prop.ele('d:supported-report-set');
  for (const r of ['c:calendar-query', 'c:calendar-multiget', 'd:sync-collection']) {
    reports.ele('d:supported-report').ele('d:report').ele(r);
  }
  prop.ele('d:owner').ele('d:href').txt(principalHref(ownerId));
  appendPrivilegeSet(prop.ele('d:current-user-privilege-set'), permission);
}

function eventHref(userId: string, calendarId: string, eventId: string): string {
  return `${caldavBase(userId)}/${calendarId}/${eventId}.ics`;
}

function isHiddenFor(permission: 'OWNER' | 'WRITE' | 'READ', classification: string | null): boolean {
  return permission !== 'OWNER' && (classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL';
}

// OPTIONS — advertise CalDAV capabilities + RFC 3744 ACL
caldavRouter.options('*', (_req: Request, res: Response) => {
  res.set({
    Allow: 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCALENDAR, REPORT, ACL',
    DAV: '1, 2, 3, access-control, calendar-access, addressbook',
    'Content-Length': '0',
  });
  res.status(204).send();
});

// PROPFIND /:userId — list calendars (calendar-home-set)
caldavRouter.all('/calendars/:userId', asyncHandler(async (req: Request, res: Response) => {
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

  const doc = newMultistatus();
  const home = doc.ele('d:response');
  home.ele('d:href').txt(`${caldavBase(userId)}/`);
  const homeStat = home.ele('d:propstat');
  homeStat.ele('d:prop').ele('d:resourcetype').ele('d:collection');
  homeStat.ele('d:status').txt('HTTP/1.1 200 OK');

  if (req.get('Depth') !== '0') {
    for (const cal of owned) {
      const response = doc.ele('d:response');
      response.ele('d:href').txt(`${caldavBase(userId)}/${cal.id}/`);
      const propstat = response.ele('d:propstat');
      appendCollectionProps(propstat.ele('d:prop'), cal.name, userId, 'OWNER', await calendarTag(cal.id));
      propstat.ele('d:status').txt('HTTP/1.1 200 OK');
    }

    for (const s of shares) {
      const response = doc.ele('d:response');
      response.ele('d:href').txt(`${caldavBase(userId)}/${s.calendar.id}/`);
      const propstat = response.ele('d:propstat');
      appendCollectionProps(
        propstat.ele('d:prop'), `[Geteilt] ${s.calendar.name}`, s.calendar.userId,
        s.permission === 'WRITE' ? 'WRITE' : 'READ', await calendarTag(s.calendar.id),
      );
      propstat.ele('d:status').txt('HTTP/1.1 200 OK');
    }
  }

  sendMultistatus(res, doc);
}));

// /:userId/:calendarId — ONE handler for every collection method. (Previously a
// PROPFIND-only `all()` handler answered 405 before the REPORT/MKCALENDAR handlers
// registered later could ever run, so calendar sync never worked.)
caldavRouter.all('/calendars/:userId/:calendarId', asyncHandler(async (req: Request, res: Response) => {
  const { userId, calendarId } = req.params as { userId: string; calendarId: string };
  const davUser = req.davUser;
  if (!davUser || davUser.userId !== userId) { res.status(403).send('Forbidden'); return; }

  switch (req.method) {
    case 'PROPFIND': return handleCalendarPropfind(req, res, userId, calendarId);
    case 'REPORT': return handleCalendarReport(req, res, userId, calendarId);
    case 'MKCALENDAR': return handleMkcalendar(req, res, userId, calendarId);
    default:
      res.set('Allow', 'OPTIONS, PROPFIND, REPORT, MKCALENDAR').status(405).send('Method Not Allowed');
  }
}));

async function handleCalendarPropfind(req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const calendar = await prisma.calendar.findUnique({ where: { id: calendarId } });
  if (!calendar) { res.status(404).send('Not Found'); return; }

  // ACL list only relevant for the owner view (grantees see their own permission via cups)
  const shares = access.permission === 'OWNER'
    ? await prisma.calendarShare.findMany({
        where: { calendarId },
        select: { granteeId: true, permission: true },
      })
    : [];

  const doc = newMultistatus();
  const calResponse = doc.ele('d:response');
  calResponse.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/`);
  const calPropstat = calResponse.ele('d:propstat');
  const calProp = calPropstat.ele('d:prop');
  appendCollectionProps(
    calProp,
    access.permission === 'OWNER' ? calendar.name : `[Geteilt] ${calendar.name}`,
    access.ownerId, access.permission, await calendarTag(calendarId),
  );
  if (access.permission === 'OWNER') {
    appendAclProperty(calProp, access.ownerId, shares);
  }
  calPropstat.ele('d:status').txt('HTTP/1.1 200 OK');

  // Event listing (Depth: 1) — confidential ones are hidden, otherwise only href+etag
  if (req.get('Depth') !== '0') {
    const events = await prisma.calendarEvent.findMany({
      where: { calendarId },
      select: { id: true, updatedAt: true, classification: true },
    });
    for (const event of events) {
      if (isHiddenFor(access.permission, event.classification)) continue;
      const evResponse = doc.ele('d:response');
      evResponse.ele('d:href').txt(eventHref(userId, calendarId, event.id));
      const evPropstat = evResponse.ele('d:propstat');
      const evProp = evPropstat.ele('d:prop');
      evProp.ele('d:getetag').txt(etagFor(event.id, event.updatedAt));
      evProp.ele('d:getcontenttype').txt('text/calendar; charset=utf-8; component=VEVENT');
      evProp.ele('d:resourcetype');
      evPropstat.ele('d:status').txt('HTTP/1.1 200 OK');
    }
  }

  sendMultistatus(res, doc);
}

// REPORT — calendar-query / calendar-multiget / sync-collection (with privacy masking)
async function handleCalendarReport(req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const report = parseReportRequest(req.body);
  const doc = newMultistatus();
  const select = { id: true, icalData: true, classification: true, updatedAt: true } as const;
  type Row = { id: string; icalData: string; classification: string; updatedAt: Date };

  const appendEvent = (event: Row): void => {
    const masked = maskIcalForGrantee(event.icalData, event.classification, access.permission === 'OWNER');
    if (masked === null) return; // CONFIDENTIAL for grantee
    const r = doc.ele('d:response');
    r.ele('d:href').txt(eventHref(userId, calendarId, event.id));
    const ps = r.ele('d:propstat');
    const prop = ps.ele('d:prop');
    prop.ele('d:getetag').txt(etagFor(event.id, event.updatedAt));
    if (report.wantsData) prop.ele('c:calendar-data').txt(masked);
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  };
  const appendNotFound = (href: string): void => {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(href);
    r.ele('d:status').txt('HTTP/1.1 404 Not Found');
  };

  if (report.kind === 'calendar-multiget') {
    const ids = report.hrefs.map((h) => resourceIdFromHref(h, '.ics'));
    const rows = await prisma.calendarEvent.findMany({ where: { calendarId, id: { in: ids } }, select });
    const byId = new Map(rows.map((r) => [r.id, r]));
    report.hrefs.forEach((href, i) => {
      const row = byId.get(ids[i] ?? '');
      if (!row || isHiddenFor(access.permission, row.classification)) appendNotFound(href);
      else appendEvent(row);
    });
    sendMultistatus(res, doc);
    return;
  }

  if (report.kind === 'sync-collection') {
    const ctag = await calendarTag(calendarId);
    const current = syncTokenFor(ctag);
    if (report.syncToken && report.syncToken !== current) {
      // No tombstones are kept → an outdated token cannot be answered with a delta.
      // RFC 6578 §3.2: DAV:valid-sync-token makes the client fall back to a full resync.
      res.status(403).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(
        create({ version: '1.0', encoding: 'utf-8' }).ele('d:error', { 'xmlns:d': NS_DAV }).ele('d:valid-sync-token').up(),
      ));
      return;
    }
    if (!report.syncToken) {
      const rows = await prisma.calendarEvent.findMany({ where: { calendarId }, select });
      rows.forEach(appendEvent);
    }
    doc.ele('d:sync-token').txt(current);
    sendMultistatus(res, doc);
    return;
  }

  if (report.kind === 'calendar-query') {
    // Only VEVENTs are stored — a VTODO/VJOURNAL-only query has no matches.
    const comps = report.compFilters.filter((c) => c !== 'VCALENDAR');
    if (comps.length > 0 && !comps.includes('VEVENT')) { sendMultistatus(res, doc); return; }
    const tr = report.timeRange;
    const where = {
      calendarId,
      ...(tr?.end ? { dtStart: { lt: tr.end } } : {}),
      // Plain events are filtered by exact overlap; recurring series are returned
      // when they started before the range end (instances are expanded client-side).
      ...(tr?.start ? { OR: [{ dtEnd: { gt: tr.start } }, { recurring: true }, { rrule: { not: null } }] } : {}),
    };
    const rows = await prisma.calendarEvent.findMany({ where, select });
    rows.forEach(appendEvent);
    sendMultistatus(res, doc);
    return;
  }

  res.status(403).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(
    create({ version: '1.0', encoding: 'utf-8' }).ele('d:error', { 'xmlns:d': NS_DAV }).ele('d:supported-report').up(),
  ));
}

// MKCALENDAR — create new calendar (only OWNER under their own URL)
async function handleMkcalendar(_req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  const existing = await prisma.calendar.findUnique({ where: { id: calendarId }, select: { id: true } });
  if (existing) { res.status(405).send('Calendar already exists'); return; }
  await prisma.calendar.create({
    data: { id: calendarId, userId, name: calendarId, color: '#0078D4' },
  });
  res.status(201).send();
}

// GET /:userId/:calendarId/:eventId.ics — fetch iCalendar data (with privacy masking)
caldavRouter.get('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
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
    select: { id: true, icalData: true, classification: true, updatedAt: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  const masked = maskIcalForGrantee(event.icalData, event.classification, access.permission === 'OWNER');
  if (masked === null) { res.status(404).send('Not Found'); return; }

  const etag = etagFor(event.id, event.updatedAt);
  const pre = checkPreconditions('GET', preconditionHeaders(req), etag);
  if (pre !== null) { res.set('ETag', etag).status(pre).send(); return; }

  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', ETag: etag });
  res.send(masked);
}));

// PUT /:userId/:calendarId/:eventId.ics — create or update event
// v3.18.15: OWNER + WRITE grantees may write
caldavRouter.put('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
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

  // Parse the master VEVENT (VTIMEZONE-aware, folded lines, TZID → UTC)
  const parsed = parseCalendarObject(icalData);
  if (!parsed) { res.status(400).send('Bad Request — no valid VEVENT with DTSTART'); return; }
  const ev = parsed.main;

  const existing = await prisma.calendarEvent.findFirst({
    where: { id },
    select: { id: true, calendarId: true, classification: true, updatedAt: true, uid: true },
  });

  // RFC 7232 conditional requests (If-None-Match: * on create, If-Match on update)
  const pre = checkPreconditions('PUT', preconditionHeaders(req), existing ? etagFor(existing.id, existing.updatedAt) : null);
  if (pre !== null) { res.status(412).send('Precondition Failed'); return; }

  const fields = {
    icalData,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    dtStart: ev.start,
    dtEnd: ev.end,
    allDay: ev.allDay,
    rrule: ev.rrule,
    recurring: ev.rrule !== null || ev.rdates.length > 0,
    classification: ev.classification,
    status: ev.status ?? 'CONFIRMED',
    organizer: ev.organizer,
    attendees: ev.attendees.map((a) => ({ ...a })),
    ...(ev.sequence !== null ? { sequence: ev.sequence } : {}),
  };

  if (existing) {
    // Prevent cross-calendar manipulation
    if (existing.calendarId !== calendarId) {
      res.status(403).send('Forbidden — event belongs to another calendar');
      return;
    }
    // A grantee with WRITE may NOT modify events the OWNER marked as CONFIDENTIAL
    if (access.permission !== 'OWNER' && (existing.classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL') {
      res.status(403).send('Forbidden — event is confidential');
      return;
    }
    const saved = await prisma.calendarEvent.update({
      where: { id },
      data: fields,
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event updated');
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(204).send();
  } else {
    const uid = ev.uid ?? id;
    // RFC 4791 §5.3.2.1 no-uid-conflict: UID is globally unique in our schema
    const clash = await prisma.calendarEvent.findUnique({ where: { uid }, select: { id: true, calendarId: true } });
    if (clash) {
      res.status(409).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(
        create({ version: '1.0', encoding: 'utf-8' })
          .ele('d:error', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV })
          .ele('c:no-uid-conflict').ele('d:href').txt(eventHref(userId, clash.calendarId, clash.id)).up().up(),
      ));
      return;
    }
    const saved = await prisma.calendarEvent.create({
      data: { id, uid, calendarId, ...fields },
      select: { id: true, updatedAt: true },
    });
    log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event created');
    res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(201).send();
  }
}));

// DELETE /:userId/:calendarId/:eventId.ics — OWNER + WRITE grantees
caldavRouter.delete('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
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
    select: { id: true, classification: true, updatedAt: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  // WRITE grantees may not delete CONFIDENTIAL events
  if (access.permission !== 'OWNER' && (event.classification ?? 'PUBLIC').toUpperCase() === 'CONFIDENTIAL') {
    res.status(403).send('Forbidden — event is confidential');
    return;
  }

  if (checkPreconditions('DELETE', preconditionHeaders(req), etagFor(event.id, event.updatedAt)) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }

  await prisma.calendarEvent.delete({ where: { id } });
  log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event deleted');
  res.status(204).send();
}));
