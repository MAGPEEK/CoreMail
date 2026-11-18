/**
 * 9.5: the CalDAV task list — one VTODO collection per user in the calendar home
 * (`/dav/calendars/<user>/tasks/`, supported-calendar-component-set VTODO), so Apple
 * Reminders, Thunderbird and DAVx⁵ (jtx Board, Tasks.org) sync the webmail tasks both
 * ways: PROPFIND, REPORT (calendar-query with comp-filter VTODO, calendar-multiget,
 * sync-collection), GET / PUT / DELETE with ETag / If-Match.
 *
 * Tasks are the Task rows of the user (the same ones the webmail and REST API show);
 * the mapping is vtodo.ts. Writes go through storage task-store.ts (the status rules,
 * the next task of a completed recurring task) and announce `tasks` realtime events.
 * The webmail module policy "tasks" is enforced by davFeatureGate (auth.ts): module
 * off → the collection is not listed in the home and every request to it gets 403.
 *
 * Resource names: a task created over CalDAV keeps the client's resource name as its
 * id; tasks created in the webmail appear as `<task id>.ics`.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { compileCalendarFilter, UnsupportedFilterError } from '../dav-filter.js';
import { parseIcal, type IcalComponent } from '@coremail/core/calendar';
import {
  prisma, announceUserEvent, createTaskWithRules, updateTaskWithRules, type StoredTask as Task,
} from '@coremail/storage';
import {
  appendCurrentUserPrincipal,
  asyncHandler,
  checkPreconditions,
  collectionTag,
  etagFor,
  newMultistatus,
  parseReportRequest,
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
  type XmlNode,
} from '../dav-utils.js';
import {
  MAX_VTODO_BYTES, columnsFromVTodo, normalizeCalendarText, parseVTodoObject, progressFromVTodo, renderVTodo, taskInRange,
} from './vtodo.js';

const log = createLogger('caldav:tasks');

/** Path segment of the task list inside the calendar home (reserved: no calendar can use it). */
export const TASK_COLLECTION_ID = 'tasks';
/** Display name of the task list (German UI text, like the shared-calendar prefix). */
export const TASK_LIST_NAME = 'Aufgaben';
const MAX_RESOURCE_NAME = 200;

export const caldavTasksRouter: RouterType = Router();

function taskListHref(userId: string): string {
  return `/dav/calendars/${userId}/${TASK_COLLECTION_ID}/`;
}

function taskHref(userId: string, taskId: string): string {
  return `${taskListHref(userId)}${encodeURIComponent(taskId)}.ics`;
}

const etagOf = (task: Pick<Task, 'id' | 'updatedAt'>): string => etagFor(task.id, task.updatedAt);

/** CTag / sync-token of the task list (task count + newest change). */
async function taskListTag(userId: string): Promise<string> {
  const agg = await prisma.task.aggregate({ where: { userId }, _count: { _all: true }, _max: { updatedAt: true } });
  return collectionTag(agg._count._all, agg._max.updatedAt ?? null);
}

/** The owner's privileges: tasks are read, written, created and deleted; the collection's properties are fixed. */
function appendTaskPrivileges(prop: XmlNode): void {
  const cups = prop.ele('d:current-user-privilege-set');
  for (const p of ['read', 'write', 'write-content', 'bind', 'unbind', 'read-current-user-privilege-set']) {
    cups.ele('d:privilege').ele(`d:${p}`);
  }
}

function appendTaskListProps(prop: XmlNode, req: Request, userId: string, ctag: string): void {
  prop.ele('d:resourcetype').ele('d:collection').up().ele('c:calendar');
  prop.ele('d:displayname').txt(TASK_LIST_NAME);
  prop.ele('cs:getctag').txt(ctag);
  prop.ele('d:sync-token').txt(syncTokenFor(ctag));
  prop.ele('c:supported-calendar-component-set').ele('c:comp', { name: 'VTODO' });
  prop.ele('c:supported-calendar-data').ele('c:calendar-data', { 'content-type': 'text/calendar', version: '2.0' });
  prop.ele('c:max-resource-size').txt(String(MAX_VTODO_BYTES));
  const reports = prop.ele('d:supported-report-set');
  for (const r of ['c:calendar-query', 'c:calendar-multiget', 'd:sync-collection']) {
    reports.ele('d:supported-report').ele('d:report').ele(r);
  }
  prop.ele('d:owner').ele('d:href').txt(principalHref(userId));
  appendTaskPrivileges(prop);
  appendCurrentUserPrincipal(prop, req);
}

/** The task list as a member of the calendar home listing (PROPFIND Depth: 1 on the home). */
export async function appendTaskCollection(doc: XmlNode, req: Request, userId: string): Promise<void> {
  const response = doc.ele('d:response');
  response.ele('d:href').txt(taskListHref(userId));
  const propstat = response.ele('d:propstat');
  appendTaskListProps(propstat.ele('d:prop'), req, userId, await taskListTag(userId));
  propstat.ele('d:status').txt('HTTP/1.1 200 OK');
}

function appendTaskResponse(doc: XmlNode, req: Request, href: string, etag: string): void {
  const r = doc.ele('d:response');
  r.ele('d:href').txt(href);
  const ps = r.ele('d:propstat');
  const prop = ps.ele('d:prop');
  prop.ele('d:getetag').txt(etag);
  prop.ele('d:getcontenttype').txt('text/calendar; charset=utf-8; component=VTODO');
  prop.ele('d:resourcetype');
  appendTaskPrivileges(prop);
  appendCurrentUserPrincipal(prop, req);
  ps.ele('d:status').txt('HTTP/1.1 200 OK');
}

// ─── The collection ──────────────────────────────────────────────────────────

caldavTasksRouter.all(`/calendars/:userId/${TASK_COLLECTION_ID}`, asyncHandler(async (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') { next(); return; }
  if (!requireOwnPath(req, res)) return;
  const { userId } = req.params as { userId: string };
  switch (req.method) {
    case 'PROPFIND': return handleTaskListPropfind(req, res, userId);
    case 'PROPPATCH': return sendReadOnlyProppatch(req, res, taskListHref(userId));
    case 'REPORT': return handleTaskListReport(req, res, userId);
    case 'MKCALENDAR': res.status(405).send('Calendar already exists'); return;
    default: res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH, REPORT').status(405).send('Method Not Allowed');
  }
}));

async function handleTaskListPropfind(req: Request, res: Response, userId: string): Promise<void> {
  const doc = newMultistatus();
  const self = doc.ele('d:response');
  self.ele('d:href').txt(taskListHref(userId));
  const ps = self.ele('d:propstat');
  appendTaskListProps(ps.ele('d:prop'), req, userId, await taskListTag(userId));
  ps.ele('d:status').txt('HTTP/1.1 200 OK');
  if (req.get('Depth') !== '0') {
    const tasks = await prisma.task.findMany({ where: { userId }, select: { id: true, updatedAt: true } });
    for (const t of tasks) appendTaskResponse(doc, req, taskHref(userId, t.id), etagOf(t));
  }
  sendMultistatus(res, doc);
}

async function handleTaskListReport(req: Request, res: Response, userId: string): Promise<void> {
  const report = parseReportRequest(req.body);
  const doc = newMultistatus();
  const appendTask = (task: Task, data: string): void => {
    const r = doc.ele('d:response');
    r.ele('d:href').txt(taskHref(userId, task.id));
    const ps = r.ele('d:propstat');
    const prop = ps.ele('d:prop');
    prop.ele('d:getetag').txt(etagOf(task));
    if (report.wantsData) prop.ele('c:calendar-data').txt(data);
    ps.ele('d:status').txt('HTTP/1.1 200 OK');
  };

  if (report.kind === 'calendar-multiget') {
    const ids = report.hrefs.map((h) => resourceIdFromHref(h, '.ics'));
    const rows = await prisma.task.findMany({ where: { userId, id: { in: ids } } });
    const byId = new Map(rows.map((t) => [t.id, t]));
    report.hrefs.forEach((href, i) => {
      const task = byId.get(ids[i] ?? '');
      if (task) { appendTask(task, renderVTodo(task)); return; }
      const r = doc.ele('d:response');
      r.ele('d:href').txt(href);
      r.ele('d:status').txt('HTTP/1.1 404 Not Found');
    });
    sendMultistatus(res, doc);
    return;
  }

  if (report.kind === 'sync-collection') {
    const current = syncTokenFor(await taskListTag(userId));
    // No tombstones are kept: an outdated token makes the client resync in full (RFC 6578 §3.2)
    if (report.syncToken && report.syncToken !== current) { sendDavError(res, 403, 'd:valid-sync-token'); return; }
    if (!report.syncToken) {
      for (const task of await prisma.task.findMany({ where: { userId } })) appendTask(task, renderVTodo(task));
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
    // Only VTODOs live here — a VEVENT/VJOURNAL-only query has no matches
    const comps = report.compFilters.filter((c) => c !== 'VCALENDAR');
    if (comps.length > 0 && !comps.includes('VTODO')) { sendMultistatus(res, doc); return; }
    const tr = report.timeRange;
    const rangeStart = tr?.start ?? new Date(Date.UTC(1900, 0, 1));
    const rangeEnd = tr?.end ?? new Date(Date.UTC(9999, 11, 31));
    for (const task of await prisma.task.findMany({ where: { userId } })) {
      if (tr && !taskInRange(task, rangeStart, rangeEnd)) continue;
      const data = renderVTodo(task);
      const root = parseIcal(data);
      if (root && matchesFilter(root)) appendTask(task, data);
    }
    sendMultistatus(res, doc);
    return;
  }

  sendDavError(res, 403, 'd:supported-report');
}

// ─── Task resources ──────────────────────────────────────────────────────────

const RESOURCE = `/calendars/:userId/${TASK_COLLECTION_ID}/:resource`;

const taskIdOf = (resource: string): string => resource.replace(/\.ics$/i, '');

async function ownTask(userId: string, id: string): Promise<Task | null> {
  return prisma.task.findFirst({ where: { id, userId } });
}

caldavTasksRouter.get(RESOURCE, asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, resource } = req.params as { userId: string; resource: string };
  const task = await ownTask(userId, taskIdOf(resource));
  if (!task) { res.status(404).send('Not Found'); return; }
  const etag = etagOf(task);
  const pre = checkPreconditions('GET', preconditionHeaders(req), etag);
  if (pre !== null) { res.set('ETag', etag).status(pre).send(); return; }
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', ETag: etag }).send(renderVTodo(task));
}));

/** Another task of the user already carries this UID (its own, or its id when it has none)? */
async function uidOwner(userId: string, uid: string): Promise<{ id: string } | null> {
  return prisma.task.findFirst({ where: { userId, OR: [{ uid }, { id: uid, uid: null }] }, select: { id: true } });
}

caldavTasksRouter.put(RESOURCE, asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, resource } = req.params as { userId: string; resource: string };
  const id = taskIdOf(resource);
  if (!id || id.length > MAX_RESOURCE_NAME) { res.status(400).send('Bad Request — invalid resource name'); return; }
  const body = typeof req.body === 'string' ? req.body : '';
  if (!body) { res.status(400).send('Bad Request'); return; }

  const check = parseVTodoObject(body);
  if (!check.ok) { sendDavError(res, check.status, check.element); return; }

  const existing = await prisma.task.findUnique({ where: { id } });
  // Task ids are global keys: an id of another user's task gets a neutral 409 (no existence hint)
  if (existing && existing.userId !== userId) { res.status(409).send('Conflict — choose another resource name'); return; }
  if (checkPreconditions('PUT', preconditionHeaders(req), existing ? etagOf(existing) : null) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }

  const uid = check.fields.uid ?? existing?.uid ?? null;
  const effectiveUid = uid ?? existing?.id ?? id;
  if (!existing || (existing.uid ?? existing.id) !== effectiveUid) {
    const clash = await uidOwner(userId, effectiveUid);
    if (clash && clash.id !== id) { sendUidConflict(res, taskHref(userId, clash.id)); return; }
  }

  const fields = { ...check.fields, uid };
  const columns = columnsFromVTodo(fields, existing, body);
  const patch = progressFromVTodo(fields, existing);
  let saved: Task | null;
  let next: Task | null = null;
  try {
    if (existing) {
      const result = await updateTaskWithRules(existing, columns, patch);
      saved = result.updated;
      next = result.created;
    } else {
      saved = await createTaskWithRules(userId, columns.subject, columns, patch, new Date(), id);
    }
  } catch (err) {
    // Concurrent PUT with the same UID (or resource name) — answer the precondition, not 500
    if (isUniqueViolation(err)) { sendUidConflict(res, taskHref(userId, id)); return; }
    throw err;
  }
  if (!saved) { res.status(404).send('Not Found'); return; }

  announceUserEvent(userId, { type: 'tasks', action: existing ? 'update' : 'create', ids: next ? [saved.id, next.id] : [saved.id] });
  log.info({ userId, taskId: id, created: !existing, next: next?.id }, 'CalDAV task saved');
  // RFC 4791 §5.3.4: an ETag only when the stored representation is what the client sent
  if (normalizeCalendarText(body) === renderVTodo(saved)) res.set('ETag', etagOf(saved));
  res.status(existing ? 204 : 201).send();
}));

caldavTasksRouter.delete(RESOURCE, asyncHandler(async (req: Request, res: Response) => {
  if (!requireOwnPath(req, res)) return;
  const { userId, resource } = req.params as { userId: string; resource: string };
  const task = await ownTask(userId, taskIdOf(resource));
  if (!task) { res.status(404).send('Not Found'); return; }
  if (checkPreconditions('DELETE', preconditionHeaders(req), etagOf(task)) !== null) {
    res.status(412).send('Precondition Failed');
    return;
  }
  await prisma.task.delete({ where: { id: task.id } });
  announceUserEvent(userId, { type: 'tasks', action: 'delete', ids: [task.id] });
  log.info({ userId, taskId: task.id }, 'CalDAV task deleted');
  res.status(204).send();
}));

// PROPFIND / PROPPATCH on a task (RFC 4918 §9.1: every resource answers PROPFIND)
caldavTasksRouter.all(RESOURCE, asyncHandler(async (req: Request, res: Response, next) => {
  if (req.method === 'OPTIONS') { next(); return; }
  if (!requireOwnPath(req, res)) return;
  const { userId, resource } = req.params as { userId: string; resource: string };
  if (req.method !== 'PROPFIND' && req.method !== 'PROPPATCH') {
    res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH').status(405).send('Method Not Allowed');
    return;
  }
  const task = await ownTask(userId, taskIdOf(resource));
  if (!task) { res.status(404).send('Not Found'); return; }
  const href = taskHref(userId, task.id);
  if (req.method === 'PROPPATCH') { sendReadOnlyProppatch(req, res, href); return; }
  const doc = newMultistatus();
  appendTaskResponse(doc, req, href, etagOf(task));
  sendMultistatus(res, doc);
}));
