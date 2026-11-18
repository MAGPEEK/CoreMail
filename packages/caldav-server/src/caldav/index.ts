import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma, announceCalendarChange, announceUserEvent } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import {
  escapeText,
  findMainVEvent,
  getProperty,
  granteeView,
  MASKED_SUMMARY,
  normClass,
  parseCalendarObject,
  parseIcal,
  serializeComponent,
  type EventView,
  type IcalComponent,
} from '@coremail/core/calendar';
import { eventOverlapsRange, expandCalendarData, limitRecurrenceSet } from '@coremail/core/recurrence';
import { create } from 'xmlbuilder2';
import {
  DAV_ALLOW,
  DAV_COMPLIANCE,
  NS_APPLE,
  NS_CALDAV,
  NS_DAV,
  appendCurrentUserPrincipal,
  appendPropResults,
  asyncHandler,
  checkPreconditions,
  collectionTag,
  etagFor,
  newMultistatus,
  parseCaldavUtc,
  parseProppatch,
  parseReportRequest,
  parseXml,
  preconditionHeaders,
  principalHref,
  requireOwnPath,
  resourceIdFromHref,
  sendDavError,
  sendMultistatus,
  sendReadOnlyProppatch,
  sendUidConflict,
  isUniqueViolation,
  syncTokenFor,
  xmlChild,
  xmlChildren,
  type XmlEl,
  type XmlNode,
} from '../dav-utils.js';
import { compileCalendarFilter, UnsupportedFilterError } from '../dav-filter.js';
import { appendTaskCollection, isTaskCollectionSegment } from './tasks.js';

const log = createLogger('caldav');

export const caldavRouter: RouterType = Router();

/** Privacy helpers shared with the REST API (8.0.0: moved to @coremail/core/calendar). */
export { MASKED_SUMMARY, granteeView, type EventView };
/** Display-name prefix of calendars shared with the user. */
export const SHARED_CALENDAR_PREFIX = '[Geteilt] ';
export const DEFAULT_CALENDAR_COLOR = '#0078D4';

type Permission = 'OWNER' | 'WRITE' | 'READ';

function caldavBase(userId: string): string {
  return `/dav/calendars/${userId}`;
}

function eventHref(userId: string, calendarId: string, eventId: string): string {
  return `${caldavBase(userId)}/${calendarId}/${eventId}.ics`;
}

/**
 * v3.18.14 Calendar Sharing — CalDAV helpers.
 * v3.18.15: WRITE sharing enabled.
 *
 * Returns the permission of `viewerUserId` on `calendarId`:
 *  - 'OWNER' if `viewerUserId === calendar.userId`
 *  - 'WRITE' / 'READ' if a CalendarShare exists
 *  - null if there is no access
 */
async function getDavAccess(
  viewerUserId: string,
  calendarId: string,
): Promise<{ permission: Permission; ownerId: string } | null> {
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

/** CTag / sync-token of calendar collections (member count + newest updatedAt), one query for all. */
async function calendarTags(calendarIds: string[]): Promise<Map<string, string>> {
  const tags = new Map(calendarIds.map((id) => [id, collectionTag(0, null)]));
  if (calendarIds.length === 0) return tags;
  const rows = await prisma.calendarEvent.groupBy({
    by: ['calendarId'],
    where: { calendarId: { in: calendarIds } },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  for (const r of rows) tags.set(r.calendarId, collectionTag(r._count._all, r._max.updatedAt ?? null));
  return tags;
}

async function calendarTag(calendarId: string): Promise<string> {
  return (await calendarTags([calendarId])).get(calendarId)!;
}

// ─── Privacy (v3.18.15, allowlist since 8.0.0) ──────────────────────────────
// granteeView / normClass / MASKED_SUMMARY live in @coremail/core/calendar (8.0.0) so the
// REST API applies exactly the same rule (incl. CLASS of recurrence overrides).

function isConfidential(cls: string | null | undefined): boolean {
  return normClass(cls) === 'CONFIDENTIAL';
}

/** Backwards-compatible wrapper: masked text, or null when hidden. */
export function maskIcalForGrantee(icalData: string, classification: string, isOwner: boolean): string | null {
  return granteeView(icalData, classification, isOwner)?.data ?? null;
}

/**
 * ETag of what the viewer receives. A masked view has its OWN ETag, so a client can
 * never present the masked representation as "the current version" in If-Match.
 */
function viewEtag(id: string, updatedAt: Date, view: EventView): string {
  return view.masked ? etagFor(`${id}#masked`, updatedAt) : etagFor(id, updatedAt);
}

/** May `permission` modify/delete this stored event? Grantees never write masked or hidden events. */
function canWriteEvent(permission: Permission, icalData: string, classification: string | null): boolean {
  if (permission === 'OWNER') return true;
  if (permission === 'READ') return false;
  const view = granteeView(icalData, classification, false);
  return view !== null && !view.masked;
}

function sendNeedPrivileges(res: Response, href: string, privilege: 'write-content' | 'bind' | 'unbind'): void {
  sendDavError(res, 403, 'd:need-privileges', (el) => {
    const r = el.ele('d:resource');
    r.ele('d:href').txt(href);
    r.ele('d:privilege').ele(`d:${privilege}`);
  });
}

// ─── Properties ──────────────────────────────────────────────────────────────

/** RFC 3744 — privilege set element depending on permission. */
function appendPrivilegeSet(cups: XmlNode, permission: Permission): void {
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

/** RFC 3744 — minimally compliant <DAV:acl> block (read-only; the ACL method is not supported). */
function appendAclProperty(
  prop: XmlNode,
  ownerId: string,
  shares: Array<{ granteeId: string; permission: 'READ' | 'WRITE' }>,
): void {
  const acl = prop.ele('d:acl');
  const ownerAce = acl.ele('d:ace');
  ownerAce.ele('d:principal').ele('d:href').txt(principalHref(ownerId));
  ownerAce.ele('d:grant').ele('d:privilege').ele('d:all');
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

interface CalendarRow { id: string; name: string; color: string; sortOrder: number; userId: string }

function appendCollectionProps(
  prop: XmlNode,
  req: Request,
  cal: CalendarRow,
  permission: Permission,
  ctag: string,
): void {
  prop.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
  prop.ele('d:displayname').txt(permission === 'OWNER' ? cal.name : `${SHARED_CALENDAR_PREFIX}${cal.name}`);
  prop.ele('ic:calendar-color').txt(cal.color);
  prop.ele('ic:calendar-order').txt(String(cal.sortOrder));
  prop.ele('cs:getctag').txt(ctag);
  prop.ele('d:sync-token').txt(syncTokenFor(ctag));
  prop.ele('c:supported-calendar-component-set').ele('c:comp', { name: 'VEVENT' });
  prop.ele('c:supported-calendar-data').ele('c:calendar-data', { 'content-type': 'text/calendar', version: '2.0' });
  const reports = prop.ele('d:supported-report-set');
  for (const r of ['c:calendar-query', 'c:calendar-multiget', 'd:sync-collection']) {
    reports.ele('d:supported-report').ele('d:report').ele(r);
  }
  prop.ele('d:owner').ele('d:href').txt(principalHref(cal.userId));
  appendPrivilegeSet(prop.ele('d:current-user-privilege-set'), permission);
  appendCurrentUserPrincipal(prop, req);
}

// OPTIONS — advertise only what is implemented (no LOCK → no class 2, no ACL method)
caldavRouter.options('*', (_req: Request, res: Response) => {
  res.set({ Allow: DAV_ALLOW, DAV: DAV_COMPLIANCE, 'Content-Length': '0' });
  res.status(204).send();
});

// PROPFIND /calendars/:userId — the calendar home (+ its calendars with Depth: 1)
caldavRouter.all('/calendars/:userId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId } = req.params as { userId: string };
  if (req.method === 'PROPPATCH') { return sendReadOnlyProppatch(req, res, `${caldavBase(userId)}/`); }
  if (req.method !== 'PROPFIND') { res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH').status(405).send('Method Not Allowed'); return; }

  const doc = newMultistatus();
  const home = doc.ele('d:response');
  home.ele('d:href').txt(`${caldavBase(userId)}/`);
  const homeStat = home.ele('d:propstat');
  const homeProp = homeStat.ele('d:prop');
  homeProp.ele('d:resourcetype').ele('d:collection');
  homeProp.ele('d:owner').ele('d:href').txt(principalHref(userId));
  appendCurrentUserPrincipal(homeProp, req);
  homeStat.ele('d:status').txt('HTTP/1.1 200 OK');

  // 9.5: calendars and the task list, each only while its webmail module is on
  const modules = req.davModules ?? { calendar: true, tasks: true };
  if (req.get('Depth') !== '0' && modules.calendar) {
    const [owned, shares] = await Promise.all([
      prisma.calendar.findMany({ where: { userId } }),
      prisma.calendarShare.findMany({
        where: { granteeId: userId },
        select: {
          permission: true,
          calendar: { select: { id: true, name: true, userId: true, color: true, sortOrder: true } },
        },
      }),
    ]);
    const tags = await calendarTags([...owned.map((c) => c.id), ...shares.map((s) => s.calendar.id)]);
    const entries: Array<{ cal: CalendarRow; permission: Permission }> = [
      ...owned.map((cal) => ({ cal, permission: 'OWNER' as const })),
      ...shares.map((s) => ({ cal: s.calendar, permission: (s.permission === 'WRITE' ? 'WRITE' : 'READ') as Permission })),
    ].filter(({ cal }) => {
      // A calendar created over CalDAV before 9.5 under the reserved name sits behind the
      // task list (its path is answered by caldav/tasks.ts): never list a second
      // collection with the same href — it stays usable in the webmail
      if (!isTaskCollectionSegment(cal.id)) return true;
      log.warn({ userId, calendarId: cal.id }, 'Calendar id collides with the task list path — not listed over CalDAV');
      return false;
    });
    for (const { cal, permission } of entries) {
      const response = doc.ele('d:response');
      response.ele('d:href').txt(`${caldavBase(userId)}/${cal.id}/`);
      const propstat = response.ele('d:propstat');
      appendCollectionProps(propstat.ele('d:prop'), req, cal, permission, tags.get(cal.id)!);
      propstat.ele('d:status').txt('HTTP/1.1 200 OK');
    }
  }
  if (req.get('Depth') !== '0' && modules.tasks) await appendTaskCollection(doc, req, userId);

  sendMultistatus(res, doc);
}));

// /calendars/:userId/:calendarId — ONE handler for every collection method. (Previously a
// PROPFIND-only `all()` handler answered 405 before the REPORT/MKCALENDAR handlers
// registered later could ever run, so calendar sync never worked.)
caldavRouter.all('/calendars/:userId/:calendarId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, calendarId } = req.params as { userId: string; calendarId: string };

  switch (req.method) {
    case 'PROPFIND': return handleCalendarPropfind(req, res, userId, calendarId);
    case 'PROPPATCH': return handleCalendarProppatch(req, res, userId, calendarId);
    case 'REPORT': return handleCalendarReport(req, res, userId, calendarId);
    case 'MKCALENDAR': return handleMkcalendar(req, res, userId, calendarId);
    default:
      res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH, REPORT, MKCALENDAR').status(405).send('Method Not Allowed');
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
  appendCollectionProps(calProp, req, calendar, access.permission, await calendarTag(calendarId));
  if (access.permission === 'OWNER') appendAclProperty(calProp, access.ownerId, shares);
  calPropstat.ele('d:status').txt('HTTP/1.1 200 OK');

  // Event listing (Depth: 1) — hidden events are skipped, masked ones get the masked ETag
  if (req.get('Depth') !== '0') {
    const isOwner = access.permission === 'OWNER';
    const events = await prisma.calendarEvent.findMany({
      where: { calendarId },
      select: { id: true, updatedAt: true, classification: true, ...(isOwner ? {} : { icalData: true }) },
    });
    for (const event of events) {
      const view = isOwner
        ? { data: '', masked: false }
        : granteeView((event as { icalData?: string }).icalData ?? '', event.classification, false);
      if (!view) continue;
      appendEventResponse(doc, req, eventHref(userId, calendarId, event.id), viewEtag(event.id, event.updatedAt, view),
        writePermissionFor(access.permission, view));
    }
  }

  sendMultistatus(res, doc);
}

function writePermissionFor(permission: Permission, view: EventView): Permission {
  return permission === 'WRITE' && view.masked ? 'READ' : permission;
}

function appendEventResponse(doc: XmlNode, req: Request, href: string, etag: string, permission: Permission): void {
  const evResponse = doc.ele('d:response');
  evResponse.ele('d:href').txt(href);
  const evPropstat = evResponse.ele('d:propstat');
  const evProp = evPropstat.ele('d:prop');
  evProp.ele('d:getetag').txt(etag);
  evProp.ele('d:getcontenttype').txt('text/calendar; charset=utf-8; component=VEVENT');
  evProp.ele('d:resourcetype');
  appendPrivilegeSet(evProp.ele('d:current-user-privilege-set'), permission);
  appendCurrentUserPrincipal(evProp, req);
  evPropstat.ele('d:status').txt('HTTP/1.1 200 OK');
}

// ─── Settable collection properties (PROPPATCH + MKCALENDAR) ─────────────────

interface CalendarPatch { name?: string; color?: string; sortOrder?: number }

/** Apply one property to `data`; returns the per-property status (200 or 403). */
function applyCollectionProp(op: 'set' | 'remove', prop: XmlEl, data: CalendarPatch): number {
  const value = prop.text.trim();
  if (prop.ns === NS_DAV && prop.name === 'displayname') {
    if (op === 'remove' || !value || value.length > 255) return 403;
    data.name = value;
    return 200;
  }
  if (prop.ns === NS_APPLE && prop.name === 'calendar-color') {
    if (op === 'remove') { data.color = DEFAULT_CALENDAR_COLOR; return 200; }
    const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
    if (!m) return 403;
    data.color = `#${m[1]!.toUpperCase()}`;
    return 200;
  }
  if (prop.ns === NS_APPLE && prop.name === 'calendar-order') {
    if (op === 'remove') { data.sortOrder = 0; return 200; }
    if (!/^-?\d{1,9}$/.test(value)) return 403;
    data.sortOrder = Number(value);
    return 200;
  }
  return 403; // protected, live or unsupported property (dead properties are not stored)
}

async function handleCalendarProppatch(req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }
  const ops = parseProppatch(req.body);
  if (!ops) { res.status(400).send('Bad Request — DAV:propertyupdate expected'); return; }

  const data: CalendarPatch = {};
  let results = ops.map((o) => ({
    prop: o.prop,
    // A grantee's calendar properties are the owner's — read-only for them
    status: access.permission === 'OWNER' ? applyCollectionProp(o.op, o.prop, data) : 403,
  }));
  // RFC 4918 §9.2: PROPPATCH is atomic — one failure fails every instruction
  if (results.some((r) => r.status !== 200)) {
    results = results.map((r) => (r.status === 200 ? { ...r, status: 424 } : r));
  } else if (Object.keys(data).length > 0) {
    await prisma.calendar.update({ where: { id: calendarId }, data });
    announceCalendarChange([calendarId], { action: 'update' });
  }
  const doc = newMultistatus();
  const r = doc.ele('d:response');
  r.ele('d:href').txt(`${caldavBase(userId)}/${calendarId}/`);
  appendPropResults(r, results);
  sendMultistatus(res, doc);
}

// MKCALENDAR — create a new calendar (only OWNER under their own URL); RFC 4791 §5.3.1
async function handleMkcalendar(req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  // 9.5: the task list's name is reserved — also when the client percent-encodes it
  // (Express routes on the raw path, so `%74asks` arrives here, decoded)
  if (isTaskCollectionSegment(calendarId)) { res.status(405).send('Calendar already exists'); return; }
  const existing = await prisma.calendar.findUnique({ where: { id: calendarId }, select: { id: true, userId: true } });
  // RFC 4791 §5.3.1: MKCALENDAR on an existing resource of the caller → 405. Calendar IDs
  // are global keys: an ID taken by ANOTHER user gets a neutral 409 that does not say the
  // calendar exists elsewhere (8.0.0 — was the same 405 as for the caller's own calendar).
  if (existing && existing.userId === userId) { res.status(405).send('Calendar already exists'); return; }
  if (existing) { res.status(409).send('Conflict — choose another resource name'); return; }

  const root = parseXml(req.body);
  if (typeof req.body === 'string' && req.body.trim() && !root) { res.status(400).send('Bad Request — malformed XML'); return; }
  const isMkcalendar = root?.ns === NS_CALDAV && root.name === 'mkcalendar';
  const isMkcol = root?.ns === NS_DAV && root.name === 'mkcol'; // RFC 5689 extended MKCOL body
  if (root && !isMkcalendar && !isMkcol) { res.status(400).send('Bad Request — CALDAV:mkcalendar expected'); return; }

  const props = xmlChildren(root, NS_DAV, 'set').flatMap((s) => xmlChildren(s, NS_DAV, 'prop').flatMap((p) => p.children));
  const data: CalendarPatch = {};
  let results = props.map((prop) => {
    if (prop.ns === NS_CALDAV && prop.name === 'supported-calendar-component-set') {
      // Only VEVENT is stored: a calendar for tasks/journals cannot be created
      const comps = xmlChildren(prop, NS_CALDAV, 'comp').map((c) => (c.attrs['name'] ?? '').toUpperCase());
      return { prop, status: comps.includes('VEVENT') ? 200 : 403 };
    }
    if (prop.ns === NS_CALDAV && (prop.name === 'calendar-timezone' || prop.name === 'schedule-calendar-transp')) {
      return { prop, status: 200 }; // accepted; times are stored in UTC, every calendar is opaque
    }
    return { prop, status: applyCollectionProp('set', prop, data) };
  });

  if (results.some((r) => r.status !== 200)) {
    results = results.map((r) => (r.status === 200 ? { ...r, status: 424 } : r));
    const body = create({ version: '1.0', encoding: 'utf-8' })
      .ele(isMkcol ? 'd:mkcol-response' : 'c:mkcalendar-response', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV, 'xmlns:ic': NS_APPLE });
    appendPropResults(body, results);
    res.status(403).set('Content-Type', 'application/xml; charset=utf-8').send(body.end({ prettyPrint: false }));
    return;
  }

  await prisma.calendar.create({
    data: {
      id: calendarId, userId, name: data.name ?? calendarId, color: data.color ?? DEFAULT_CALENDAR_COLOR,
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
    },
  });
  announceUserEvent(userId, { type: 'calendar', action: 'create', calendarIds: [calendarId] });
  res.status(201).send();
}

// ─── REPORT — calendar-query / calendar-multiget / sync-collection ───────────

interface DataOptions { expand: { start: Date; end: Date } | null; limitSet: { start: Date; end: Date } | null }

/** CALDAV:expand / CALDAV:limit-recurrence-set inside the requested calendar-data (RFC 4791 §9.6). */
function dataOptions(el: XmlEl | null): DataOptions | { invalid: string } {
  const range = (name: string): { start: Date; end: Date } | null | 'invalid' => {
    const e = xmlChild(el, NS_CALDAV, name);
    if (!e) return null;
    const start = parseCaldavUtc(e.attrs['start']);
    const end = parseCaldavUtc(e.attrs['end']);
    return start && end && start < end ? { start, end } : 'invalid';
  };
  const expand = range('expand');
  const limitSet = range('limit-recurrence-set');
  if (expand === 'invalid' || limitSet === 'invalid') return { invalid: 'expand/limit-recurrence-set needs UTC start < end' };
  return { expand, limitSet };
}

function renderCalendarData(data: string, opts: DataOptions): string {
  if (opts.expand) {
    return expandCalendarData(data, opts.expand.start, opts.expand.end)
      ?? 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CoreMail//CoreMail Calendar//EN\r\nEND:VCALENDAR\r\n';
  }
  if (opts.limitSet) return limitRecurrenceSet(data, opts.limitSet.start, opts.limitSet.end);
  return data;
}

async function handleCalendarReport(req: Request, res: Response, userId: string, calendarId: string): Promise<void> {
  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }
  const isOwner = access.permission === 'OWNER';

  const report = parseReportRequest(req.body);
  const opts = dataOptions(report.dataElement);
  if ('invalid' in opts) { sendDavError(res, 403, 'c:valid-filter'); return; }

  const doc = newMultistatus();
  const select = {
    id: true, icalData: true, classification: true, updatedAt: true,
    dtStart: true, dtEnd: true, allDay: true, recurring: true, rrule: true,
  } as const;
  type Row = { id: string; icalData: string; classification: string; updatedAt: Date; dtStart: Date; dtEnd: Date; allDay: boolean; recurring: boolean; rrule: string | null };

  const viewOf = (event: Row): EventView | null => granteeView(event.icalData, event.classification, isOwner);
  const appendEvent = (event: Row, view: EventView): void => {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(eventHref(userId, calendarId, event.id));
    const ps = r.ele('d:propstat');
    const prop = ps.ele('d:prop');
    prop.ele('d:getetag').txt(viewEtag(event.id, event.updatedAt, view));
    if (report.wantsData) prop.ele('c:calendar-data').txt(renderCalendarData(view.data, opts));
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
      const view = row ? viewOf(row) : null;
      if (!row || !view) appendNotFound(href);
      else appendEvent(row, view);
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
      sendDavError(res, 403, 'd:valid-sync-token');
      return;
    }
    if (!report.syncToken) {
      const rows = await prisma.calendarEvent.findMany({ where: { calendarId }, select });
      for (const row of rows) { const v = viewOf(row); if (v) appendEvent(row, v); }
    }
    doc.ele('d:sync-token').txt(current);
    sendMultistatus(res, doc);
    return;
  }

  if (report.kind === 'calendar-query') {
    let matchesFilter: (root: IcalComponent) => boolean;
    try {
      matchesFilter = compileCalendarFilter(report.filter);
    } catch (err) {
      if (err instanceof UnsupportedFilterError) { sendDavError(res, 403, `c:${err.precondition}`); return; }
      throw err;
    }
    // Only VEVENTs are stored — a VTODO/VJOURNAL-only query has no matches.
    const comps = report.compFilters.filter((c) => c !== 'VCALENDAR');
    if (comps.length > 0 && !comps.includes('VEVENT')) { sendMultistatus(res, doc); return; }
    const tr = report.timeRange;
    const where = {
      calendarId,
      ...(tr?.end ? { dtStart: { lt: tr.end } } : {}),
      // RFC 4791 §9.9: overlap, a zero-duration event matches when start <= DTSTART < end;
      // recurring series are pre-selected and checked instance by instance below.
      ...(tr?.start ? { OR: [{ dtEnd: { gt: tr.start } }, { dtStart: { gte: tr.start } }, { recurring: true }, { rrule: { not: null } }] } : {}),
    };
    const rows = await prisma.calendarEvent.findMany({ where, select });
    const rangeStart = tr?.start ?? new Date(Date.UTC(1900, 0, 1));
    const rangeEnd = tr?.end ?? new Date(Date.UTC(9999, 11, 31));
    for (const row of rows) {
      if (tr && (row.recurring || row.rrule) && !eventOverlapsRange(row, rangeStart, rangeEnd)) continue;
      const view = viewOf(row);
      if (!view) continue;
      // Filters run on what the viewer may see — a grantee cannot probe masked fields
      const root = parseIcal(view.data);
      if (!root || !matchesFilter(root)) continue;
      appendEvent(row, view);
    }
    sendMultistatus(res, doc);
    return;
  }

  sendDavError(res, 403, 'd:supported-report');
}

// ─── Calendar object resources ───────────────────────────────────────────────

// GET /calendars/:userId/:calendarId/:eventId.ics — fetch iCalendar data (with privacy masking)
caldavRouter.get('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, calendarId, eventId } = req.params as { userId: string; calendarId: string; eventId: string };

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }

  const id = eventId.replace(/\.ics$/, '');
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
    select: { id: true, icalData: true, classification: true, updatedAt: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  const view = granteeView(event.icalData, event.classification, access.permission === 'OWNER');
  if (!view) { res.status(404).send('Not Found'); return; }

  const etag = viewEtag(event.id, event.updatedAt, view);
  const pre = checkPreconditions('GET', preconditionHeaders(req), etag);
  if (pre !== null) { res.set('ETag', etag).status(pre).send(); return; }

  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', ETag: etag });
  res.send(view.data);
}));

const ALLOWED_COMPONENTS = new Set(['VEVENT', 'VTIMEZONE']);

type Validation =
  | { ok: true; uid: string | null; parsed: NonNullable<ReturnType<typeof parseCalendarObject>> }
  | { ok: false; status: number; element: string; message: string };

/** RFC 4791 §4.1 / §5.3.2.1 preconditions of a calendar object resource. */
export function validateCalendarObject(text: string): Validation {
  const root = parseIcal(text);
  if (!root || root.name !== 'VCALENDAR') {
    return { ok: false, status: 400, element: 'c:valid-calendar-data', message: 'no VCALENDAR' };
  }
  const unsupported = root.components.find((c) => !ALLOWED_COMPONENTS.has(c.name));
  if (unsupported) {
    return { ok: false, status: 403, element: 'c:supported-calendar-component', message: `${unsupported.name} is not supported (VEVENT only)` };
  }
  if (getProperty(root, 'METHOD')) {
    return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'METHOD is not allowed in a stored calendar object' };
  }
  const events = root.components.filter((c) => c.name === 'VEVENT');
  const uids = new Set(events.map((e) => getProperty(e, 'UID')?.value.trim() ?? ''));
  if (uids.size > 1) {
    return { ok: false, status: 403, element: 'c:valid-calendar-object-resource', message: 'all components must share one UID' };
  }
  const parsed = parseCalendarObject(text);
  if (!parsed) return { ok: false, status: 400, element: 'c:valid-calendar-data', message: 'no valid VEVENT with DTSTART' };
  return { ok: true, uid: parsed.main.uid, parsed };
}

// PUT /calendars/:userId/:calendarId/:eventId.ics — create or update event
// v3.18.15: OWNER + WRITE grantees may write (grantees never masked/hidden events)
caldavRouter.put('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, calendarId, eventId } = req.params as { userId: string; calendarId: string; eventId: string };
  const id = eventId.replace(/\.ics$/, '');
  const href = eventHref(userId, calendarId, id);

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Calendar Not Found'); return; }
  if (access.permission === 'READ') { sendNeedPrivileges(res, href, 'bind'); return; }

  const icalData = typeof req.body === 'string' ? req.body : '';
  if (!icalData) { res.status(400).send('Bad Request'); return; }

  const check = validateCalendarObject(icalData);
  if (!check.ok) { sendDavError(res, check.status, check.element); return; }
  const ev = check.parsed.main;

  const existing = await prisma.calendarEvent.findFirst({
    where: { id },
    select: { id: true, calendarId: true, classification: true, updatedAt: true, uid: true, icalData: true },
  });

  if (existing) {
    // Prevent cross-calendar manipulation
    // Event IDs are global keys: an ID used in another calendar (possibly another user's)
    // gets a neutral 409 — 8.0.0: no longer "belongs to another calendar" (existence leak).
    if (existing.calendarId !== calendarId) {
      res.status(409).send('Conflict — choose another resource name');
      return;
    }
    // A grantee must never overwrite an event it only sees masked (PRIVATE) or not at all
    // (CONFIDENTIAL): its copy lacks the owner's data (v7.1.0 — data-loss fix).
    if (!canWriteEvent(access.permission, existing.icalData, existing.classification)) {
      sendNeedPrivileges(res, href, 'write-content');
      return;
    }
  }

  // RFC 7232 conditional requests (If-None-Match: * on create, If-Match on update)
  const pre = checkPreconditions('PUT', preconditionHeaders(req), existing ? etagFor(existing.id, existing.updatedAt) : null);
  if (pre !== null) { res.status(412).send('Precondition Failed'); return; }

  const uid = ev.uid ?? existing?.uid ?? id;
  const fields = {
    icalData,
    uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    dtStart: ev.start,
    dtEnd: ev.end,
    allDay: ev.allDay,
    rrule: ev.rrule,
    recurring: ev.rrule !== null || ev.rdates.length > 0,
    classification: ev.classification,
    showAs: ev.showAs, // 9.4: TRANSP / X-MICROSOFT-CDO-BUSYSTATUS of the master
    status: ev.status ?? 'CONFIRMED',
    organizer: ev.organizer,
    attendees: ev.attendees.map((a) => ({ ...a })),
    ...(ev.sequence !== null ? { sequence: ev.sequence } : {}),
  };

  // RFC 4791 §5.3.2.1 no-uid-conflict: a UID is unique within one calendar collection
  // (v7.1.0: no longer server-wide — invitees keep their own copy). Checked on create
  // and when an update changes the UID.
  if (!existing || existing.uid !== uid) {
    const clash = await prisma.calendarEvent.findUnique({ where: { calendarId_uid: { calendarId, uid } }, select: { id: true, calendarId: true } });
    if (clash && clash.id !== id) { sendUidConflict(res, eventHref(userId, clash.calendarId, clash.id)); return; }
  }

  try {
    if (existing) {
      const saved = await prisma.calendarEvent.update({ where: { id }, data: fields, select: { id: true, updatedAt: true } });
      log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event updated');
      announceCalendarChange([calendarId], { action: 'update', ids: [id] });
      res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(204).send();
    } else {
      const saved = await prisma.calendarEvent.create({ data: { id, calendarId, ...fields }, select: { id: true, updatedAt: true } });
      log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event created');
      announceCalendarChange([calendarId], { action: 'create', ids: [id] });
      res.set('ETag', etagFor(saved.id, saved.updatedAt)).status(201).send();
    }
  } catch (err) {
    // Concurrent PUT with the same UID (or resource name) — answer the precondition, not 500
    if (isUniqueViolation(err)) { sendUidConflict(res, href); return; }
    throw err;
  }
}));

// DELETE /calendars/:userId/:calendarId/:eventId.ics — OWNER + WRITE grantees
caldavRouter.delete('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, calendarId, eventId } = req.params as { userId: string; calendarId: string; eventId: string };
  const id = eventId.replace(/\.ics$/, '');
  const href = eventHref(userId, calendarId, id);

  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }
  if (access.permission === 'READ') { sendNeedPrivileges(res, href, 'unbind'); return; }

  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
    select: { id: true, classification: true, updatedAt: true, icalData: true },
  });
  if (!event) { res.status(404).send('Not Found'); return; }

  // WRITE grantees may not delete events they only see masked (PRIVATE) or not at all
  if (!canWriteEvent(access.permission, event.icalData, event.classification)) {
    if (access.permission !== 'OWNER' && isConfidential(event.classification)) { res.status(404).send('Not Found'); return; }
    sendNeedPrivileges(res, href, 'unbind');
    return;
  }

  if (checkPreconditions('DELETE', preconditionHeaders(req), etagFor(event.id, event.updatedAt)) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }

  await prisma.calendarEvent.delete({ where: { id } });
  log.info({ userId, eventId: id, perm: access.permission }, 'CalDAV event deleted');
  announceCalendarChange([calendarId], { action: 'delete', ids: [id] });
  res.status(204).send();
}));

// PROPFIND / PROPPATCH on a calendar object resource (RFC 4918 §9.1: every resource answers PROPFIND)
caldavRouter.all('/calendars/:userId/:calendarId/:eventId', asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, calendarId, eventId } = req.params as { userId: string; calendarId: string; eventId: string };
  const id = eventId.replace(/\.ics$/, '');
  const href = eventHref(userId, calendarId, id);

  if (req.method !== 'PROPFIND' && req.method !== 'PROPPATCH') {
    res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH').status(405).send('Method Not Allowed');
    return;
  }
  const access = await getDavAccess(userId, calendarId);
  if (!access) { res.status(404).send('Not Found'); return; }
  const event = await prisma.calendarEvent.findFirst({
    where: { id, calendarId },
    select: { id: true, icalData: true, classification: true, updatedAt: true },
  });
  const view = event ? granteeView(event.icalData, event.classification, access.permission === 'OWNER') : null;
  if (!event || !view) { res.status(404).send('Not Found'); return; }

  if (req.method === 'PROPPATCH') { sendReadOnlyProppatch(req, res, href); return; }

  const doc = newMultistatus();
  appendEventResponse(doc, req, href, viewEtag(event.id, event.updatedAt, view), writePermissionFor(access.permission, view));
  sendMultistatus(res, doc);
}));
