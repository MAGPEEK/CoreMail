/**
 * 9.5: the CalDAV task list on a real Express app (loopback port) with faked auth
 * and an in-memory Prisma fake: discovery, PUT/GET/DELETE with ETags, the task rules
 * (status ↔ %, the next task of a completed recurring task), REPORTs, realtime
 * announcements and the webmail module switch.
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/caldav/tasks.test.ts  (in packages/caldav-server)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import type {} from '../auth.js'; // Request.davUser / davModules augmentation (type-only)

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

// ─── In-memory Prisma fake ───────────────────────────────────────────────────
type Row = Record<string, unknown>;
let clock = Date.parse('2026-11-18T08:00:00Z');
const tick = (): Date => new Date(++clock);
let seq = 0;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c['in'] as unknown[]).includes(v);
      if ('not' in c) return v !== c['not'];
      return false;
    }
    return (v ?? null) === cond;
  });
}

const tasks: Row[] = [];
const TASK_DEFAULTS = (): Row => ({
  body: '', bodyHtml: '', status: 'NOT_STARTED', priority: 'NORMAL', percentComplete: 0, completedAt: null, dueDate: null,
  startDate: null, reminder: null, reminderByMail: false, isPrivate: false, rrule: null, totalWorkMinutes: null,
  actualWorkMinutes: null, mileage: '', billingInfo: '', companies: '', uid: null, icalData: null, createdAt: new Date(clock),
});
const taskModel = {
  findUnique: async (a: { where: Row }) => tasks.find((r) => matches(r, a.where)) ?? null,
  findFirst: async (a: { where: Row }) => tasks.find((r) => matches(r, a.where)) ?? null,
  findMany: async (a: { where?: Row } = {}) => tasks.filter((r) => matches(r, a.where)),
  aggregate: async (a: { where?: Row }) => {
    const hit = tasks.filter((r) => matches(r, a.where));
    const max = hit.reduce<Date | null>((m, r) => (!m || (r['updatedAt'] as Date) > m ? r['updatedAt'] as Date : m), null);
    return { _count: { _all: hit.length }, _max: { updatedAt: max } };
  },
  create: async (a: { data: Row }) => {
    if (a.data['uid'] && tasks.some((t) => t['userId'] === a.data['userId'] && t['uid'] === a.data['uid'])) throw Object.assign(new Error('unique'), { code: 'P2002' });
    const row = { id: `c${++seq}`, ...TASK_DEFAULTS(), ...a.data, updatedAt: tick() };
    tasks.push(row);
    return { ...row };
  },
  update: async (a: { where: Row; data: Row }) => {
    const row = tasks.find((r) => matches(r, a.where))!;
    Object.assign(row, a.data, { updatedAt: tick() });
    return { ...row };
  },
  updateMany: async (a: { where: Row; data: Row }) => {
    const hit = tasks.filter((r) => matches(r, a.where));
    for (const row of hit) Object.assign(row, a.data, { updatedAt: tick() });
    return { count: hit.length };
  },
  delete: async (a: { where: Row }) => tasks.splice(tasks.findIndex((r) => matches(r, a.where)), 1)[0],
};
const empty = { findMany: async () => [], groupBy: async () => [], findUnique: async () => null };
const db: Row = {
  $on: () => undefined,
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  task: taskModel,
  calendar: empty,
  calendarShare: empty,
  calendarEvent: empty,
};
(globalThis as Record<string, unknown>)['__prisma'] = db;
const published: Array<{ channel: string; event: Row }> = [];
(globalThis as Record<string, unknown>)['__realtimeRedis'] = {
  publish: async (channel: string, message: string) => { published.push({ channel, event: JSON.parse(message) as Row }); return 1; },
};

const express = (await import('express')).default;
const { caldavTasksRouter } = await import('./tasks.js');
const { caldavRouter } = await import('./index.js');

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.text({ type: ['text/calendar', 'application/xml', 'text/xml'], limit: '10mb' }));
  // Faked auth + webmail modules (davFeatureGate is tested in auth.test.ts)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const u = req.get('X-Test-User');
    if (u) req.davUser = { userId: u, email: `${u}@example.com` };
    if (req.get('X-Test-No-Tasks')) req.davModules = { calendar: true, tasks: false };
    next();
  });
  app.use('/dav', caldavTasksRouter, caldavRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
beforeEach(() => { tasks.length = 0; published.length = 0; });

async function dav(method: string, path: string, opts: { user?: string; body?: string; type?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'X-Test-User': opts.user ?? 'alice',
      ...(opts.body !== undefined ? { 'Content-Type': opts.type ?? 'text/calendar; charset=utf-8' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
}

const LIST = '/dav/calendars/alice/tasks/';
const vtodo = (uid: string, ...props: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Client//EN', 'BEGIN:VTODO',
  `UID:${uid}`, ...props, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
const xml = (body: string) => ({ type: 'application/xml; charset=utf-8', body: `<?xml version="1.0"?>${body}` });
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '');

test('discovery: the calendar home lists the task list (VTODO) unless the tasks module is off', async () => {
  const home = await dav('PROPFIND', '/dav/calendars/alice', { headers: { Depth: '1' } });
  assert.equal(home.status, 207);
  assert.match(home.text, /<d:href>\/dav\/calendars\/alice\/tasks\/<\/d:href>/);
  assert.match(home.text, /<c:comp name="VTODO"\/>/);
  assert.match(home.text, /<d:displayname>Aufgaben<\/d:displayname>/);
  const off = await dav('PROPFIND', '/dav/calendars/alice', { headers: { Depth: '1', 'X-Test-No-Tasks': '1' } });
  assert.doesNotMatch(off.text, /\/tasks\//);

  const list = await dav('PROPFIND', LIST, { headers: { Depth: '0' } });
  assert.equal(list.status, 207);
  assert.match(list.text, /<c:supported-calendar-component-set><c:comp name="VTODO"\/>/);
  assert.match(list.text, /<d:sync-token>/);
  assert.equal((await dav('PROPFIND', '/dav/calendars/bob/tasks/', { headers: { Depth: '0' } })).status, 403, 'another user\'s list');
  assert.equal((await dav('MKCALENDAR', LIST)).status, 405, 'the task list exists already');
});

test('PUT creates a task (status rules applied), GET returns it with unknown properties; REST rows appear as tasks', async () => {
  const put = await dav('PUT', `${LIST}abc.ics`, {
    headers: { 'If-None-Match': '*' },
    body: vtodo('abc@client', 'SUMMARY:Angebot', 'STATUS:NEEDS-ACTION', 'PERCENT-COMPLETE:30', 'DUE;VALUE=DATE:20261205', 'PRIORITY:1', 'CATEGORIES:Kunde'),
  });
  assert.equal(put.status, 201);
  assert.equal(put.etag, null, 'the stored form differs from the body (DTSTAMP …) → no ETag');
  const row = tasks.find((t) => t['id'] === 'abc')!;
  assert.equal(row['userId'], 'alice');
  assert.equal(row['subject'], 'Angebot');
  assert.equal(row['status'], 'IN_PROGRESS', 'a percentage starts the task (task rules)');
  assert.equal(row['percentComplete'], 30);
  assert.equal((row['dueDate'] as Date).toISOString(), '2026-12-05T00:00:00.000Z');
  assert.equal(row['priority'], 'HIGH');
  assert.equal(row['uid'], 'abc@client');
  assert.deepEqual(published.map((p) => [p.channel, p.event['type'], p.event['action'], p.event['ids']]),
    [['user:alice:events', 'tasks', 'create', ['abc']]]);

  const get = await dav('GET', `${LIST}abc.ics`);
  assert.equal(get.status, 200);
  assert.ok(get.etag);
  const text = unfold(get.text);
  for (const line of ['UID:abc@client', 'STATUS:IN-PROCESS', 'PERCENT-COMPLETE:30', 'CATEGORIES:Kunde', 'PRIORITY:1', 'DUE;VALUE=DATE:20261205']) {
    assert.ok(text.includes(`\r\n${line}\r\n`), `missing ${line}:\n${text}`);
  }
  assert.equal((await dav('GET', `${LIST}abc.ics`, { headers: { 'If-None-Match': get.etag! } })).status, 304);

  // a task created in the webmail (no stored VTODO) is listed and rendered
  await taskModel.create({ data: { userId: 'alice', subject: 'Aus dem Webmail', status: 'COMPLETED', percentComplete: 100, completedAt: new Date('2026-11-17T10:00:00Z') } });
  const listing = await dav('PROPFIND', LIST, { headers: { Depth: '1' } });
  assert.match(listing.text, /\/dav\/calendars\/alice\/tasks\/c\d+\.ics/);
  const webmailTask = tasks.find((t) => t['subject'] === 'Aus dem Webmail')!;
  const rendered = unfold((await dav('GET', `${LIST}${webmailTask['id'] as string}.ics`)).text);
  assert.match(rendered, /\r\nSTATUS:COMPLETED\r\n/);
  assert.match(rendered, /\r\nCOMPLETED:20261117T100000Z\r\n/);
  assert.match(rendered, new RegExp(`\\r\\nUID:${webmailTask['id'] as string}\\r\\n`));
  // other users never see it
  assert.equal((await dav('GET', `/dav/calendars/bob/tasks/${webmailTask['id'] as string}.ics`, { user: 'bob' })).status, 404);
});

test('PUT with the stored form returns an ETag; If-Match is enforced on update and delete', async () => {
  await dav('PUT', `${LIST}t1.ics`, { body: vtodo('t1', 'SUMMARY:Eins') });
  const stored = await dav('GET', `${LIST}t1.ics`);
  const same = await dav('PUT', `${LIST}t1.ics`, { headers: { 'If-Match': stored.etag! }, body: stored.text });
  assert.equal(same.status, 204);
  assert.ok(same.etag, 'unchanged representation → ETag');
  assert.notEqual(same.etag, stored.etag);

  assert.equal((await dav('PUT', `${LIST}t1.ics`, { headers: { 'If-Match': stored.etag! }, body: stored.text })).status, 412, 'stale If-Match');
  assert.equal((await dav('PUT', `${LIST}t1.ics`, { headers: { 'If-None-Match': '*' }, body: stored.text })).status, 412, 'exists already');
  assert.equal((await dav('DELETE', `${LIST}t1.ics`, { headers: { 'If-Match': stored.etag! } })).status, 412);
  const del = await dav('DELETE', `${LIST}t1.ics`, { headers: { 'If-Match': same.etag! } });
  assert.equal(del.status, 204);
  assert.equal(tasks.length, 0);
  assert.equal(published.at(-1)?.event['action'], 'delete');
  assert.equal((await dav('GET', `${LIST}t1.ics`)).status, 404);
});

test('completing a recurring task over CalDAV closes it and creates the next one (task rules)', async () => {
  await dav('PUT', `${LIST}weekly.ics`, { body: vtodo('weekly', 'SUMMARY:Wochenbericht', 'DUE;VALUE=DATE:20261204', 'RRULE:FREQ=WEEKLY', 'CATEGORIES:Team') });
  published.length = 0;
  const done = await dav('PUT', `${LIST}weekly.ics`, {
    body: vtodo('weekly', 'SUMMARY:Wochenbericht', 'DUE;VALUE=DATE:20261204', 'RRULE:FREQ=WEEKLY', 'CATEGORIES:Team', 'STATUS:COMPLETED', 'COMPLETED:20261204T150000Z'),
  });
  assert.equal(done.status, 204);
  assert.equal(done.etag, null, 'the server removed the rule → the client must fetch again');
  assert.equal(tasks.length, 2);
  const closed = tasks.find((t) => t['id'] === 'weekly')!;
  assert.equal(closed['status'], 'COMPLETED');
  assert.equal(closed['rrule'], null);
  assert.equal((closed['completedAt'] as Date).toISOString(), '2026-12-04T15:00:00.000Z');
  const next = tasks.find((t) => t['id'] !== 'weekly')!;
  assert.equal(next['status'], 'NOT_STARTED');
  assert.equal((next['dueDate'] as Date).toISOString(), '2026-12-11T00:00:00.000Z');
  assert.equal(next['rrule'], 'FREQ=WEEKLY');
  assert.deepEqual(published[0]?.event['ids'], ['weekly', next['id']]);

  const nextText = unfold((await dav('GET', `${LIST}${next['id'] as string}.ics`)).text);
  assert.match(nextText, new RegExp(`\\r\\nUID:${next['id'] as string}\\r\\n`), 'the next task has its own UID');
  assert.match(nextText, /\r\nCATEGORIES:Team\r\n/, 'client properties carry over');
  assert.match(nextText, /\r\nSTATUS:NEEDS-ACTION\r\n/);
  assert.doesNotMatch(nextText, /COMPLETED:/);

  // sending the completion again creates nothing more
  await dav('PUT', `${LIST}weekly.ics`, { body: vtodo('weekly', 'SUMMARY:Wochenbericht', 'DUE;VALUE=DATE:20261204', 'RRULE:FREQ=WEEKLY', 'STATUS:COMPLETED') });
  assert.equal(tasks.length, 2);
  // review: …and does not revive the rule on the completed task (reopening it later would start a second series)
  assert.equal(closed['rrule'], null);
  assert.doesNotMatch(unfold((await dav('GET', `${LIST}weekly.ics`)).text), /\r\nRRULE:/);
  // reopening it with its rule is the client's explicit choice
  await dav('PUT', `${LIST}weekly.ics`, { body: vtodo('weekly', 'SUMMARY:Wochenbericht', 'DUE;VALUE=DATE:20261204', 'RRULE:FREQ=WEEKLY', 'STATUS:NEEDS-ACTION') });
  assert.equal(closed['status'], 'NOT_STARTED');
  assert.equal(closed['rrule'], 'FREQ=WEEKLY');
});

test('review: the reserved name — no second "tasks" collection in the home, MKCALENDAR refused in every spelling', async () => {
  const legacy = { id: 'tasks', name: 'Alt', userId: 'alice', color: '#0078D4', sortOrder: 0 };
  const shared = { id: 'Tasks', name: 'Geteilt', userId: 'bob', color: '#0078D4', sortOrder: 0 };
  db['calendar'] = { ...empty, findMany: async () => [legacy, { ...legacy, id: 'work', name: 'Arbeit' }] };
  db['calendarShare'] = { ...empty, findMany: async () => [{ permission: 'READ', calendar: shared }] };
  try {
    const home = await dav('PROPFIND', '/dav/calendars/alice', { headers: { Depth: '1' } });
    assert.equal(home.status, 207);
    assert.equal((home.text.match(/<d:href>\/dav\/calendars\/alice\/tasks\/<\/d:href>/gi) ?? []).length, 1, 'only the task list');
    assert.match(home.text, /\/dav\/calendars\/alice\/work\//);
  } finally {
    db['calendar'] = empty;
    db['calendarShare'] = empty;
  }
  for (const path of ['/dav/calendars/alice/Tasks/', '/dav/calendars/alice/%74asks/']) {
    assert.equal((await dav('MKCALENDAR', path)).status, 405, path);
  }
});

test('PUT preconditions: UID conflict, foreign resource name, VEVENT, unsupported rule', async () => {
  await dav('PUT', `${LIST}a.ics`, { body: vtodo('same-uid', 'SUMMARY:A') });
  const clash = await dav('PUT', `${LIST}b.ics`, { body: vtodo('same-uid', 'SUMMARY:B') });
  assert.equal(clash.status, 409);
  assert.match(clash.text, /no-uid-conflict/);
  assert.match(clash.text, /\/tasks\/a\.ics/);

  await taskModel.create({ data: { id: 'bobs', userId: 'bob', subject: 'Bob' } });
  const foreign = await dav('PUT', `${LIST}bobs.ics`, { body: vtodo('x', 'SUMMARY:x') });
  assert.equal(foreign.status, 409);
  assert.doesNotMatch(foreign.text, /bob/i, 'no hint about the other user');

  const event = await dav('PUT', `${LIST}e.ics`, { body: vtodo('e').replace('BEGIN:VTODO', 'BEGIN:VEVENT\r\nUID:e\r\nDTSTART:20261201T090000Z\r\nEND:VEVENT\r\nBEGIN:VTODO') });
  assert.equal(event.status, 403);
  assert.match(event.text, /supported-calendar-component/);
  assert.equal((await dav('PUT', `${LIST}h.ics`, { body: vtodo('h', 'SUMMARY:h', 'RRULE:FREQ=HOURLY') })).status, 403);
  assert.equal((await dav('PUT', `/dav/calendars/bob/tasks/x.ics`, { body: vtodo('x', 'SUMMARY:x') })).status, 403, 'another user\'s list');
});

test('REPORT: calendar-query (VTODO, time-range, prop-filter), multiget, sync-collection', async () => {
  await dav('PUT', `${LIST}dec.ics`, { body: vtodo('dec', 'SUMMARY:Dezember', 'DUE;VALUE=DATE:20261210', 'CATEGORIES:Arbeit') });
  await dav('PUT', `${LIST}jan.ics`, { body: vtodo('jan', 'SUMMARY:Januar', 'DUE;VALUE=DATE:20270110') });
  await dav('PUT', `${LIST}none.ics`, { body: vtodo('none', 'SUMMARY:Ohne Datum') });

  const query = (filter: string) => dav('REPORT', LIST, { headers: { Depth: '1' }, ...xml(
    `<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR">${filter}</c:comp-filter></c:filter></c:calendar-query>`) });
  const all = await query('<c:comp-filter name="VTODO"/>');
  assert.equal(all.status, 207);
  assert.equal((all.text.match(/<d:response>/g) ?? []).length, 3);
  const december = await query('<c:comp-filter name="VTODO"><c:time-range start="20261201T000000Z" end="20270101T000000Z"/></c:comp-filter>');
  assert.match(december.text, /dec\.ics/);
  assert.match(december.text, /none\.ics/, 'a task without dates matches every range');
  assert.doesNotMatch(december.text, /jan\.ics/);
  const tagged = await query('<c:comp-filter name="VTODO"><c:prop-filter name="CATEGORIES"><c:text-match>arbeit</c:text-match></c:prop-filter></c:comp-filter>');
  assert.equal((tagged.text.match(/<d:response>/g) ?? []).length, 1);
  assert.equal(((await query('<c:comp-filter name="VEVENT"/>')).text.match(/<d:response>/g) ?? []).length, 0, 'no events here');

  const multi = await dav('REPORT', LIST, { headers: { Depth: '1' }, ...xml(
    `<c:calendar-multiget ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${LIST}dec.ics</d:href><d:href>${LIST}gone.ics</d:href></c:calendar-multiget>`) });
  assert.match(multi.text, /SUMMARY:Dezember/);
  assert.match(multi.text, /gone\.ics<\/d:href><d:status>HTTP\/1\.1 404 Not Found/);

  const sync = (token: string) => dav('REPORT', LIST, { headers: { Depth: '1' }, ...xml(
    `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:prop><d:getetag/></d:prop></d:sync-collection>`) });
  const first = await sync('');
  assert.equal((first.text.match(/<d:response>/g) ?? []).length, 3);
  const token = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(first.text)![1]!;
  assert.equal(((await sync(token)).text.match(/<d:response>/g) ?? []).length, 0, 'same token: no changes');
  await dav('DELETE', `${LIST}jan.ics`);
  const stale = await sync(token);
  assert.equal(stale.status, 403);
  assert.match(stale.text, /valid-sync-token/);
});
