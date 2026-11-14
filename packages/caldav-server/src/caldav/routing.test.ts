/**
 * CalDAV/CardDAV routing + write-path tests on a real Express app (ephemeral
 * loopback port) with faked auth and an in-memory Prisma fake.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import type {} from '../auth.js'; // Request.davUser augmentation (type-only)

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

// ─── In-memory Prisma fake ───────────────────────────────────────────────────
type Row = Record<string, unknown>;
let clock = Date.parse('2026-01-01T00:00:00Z');
const tick = (): Date => new Date(++clock);

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c['in'] as unknown[]).includes(v);
      if ('lt' in c) return (v as Date).getTime() < (c['lt'] as Date).getTime();
      if ('gt' in c) return (v as Date).getTime() > (c['gt'] as Date).getTime();
      if ('not' in c) return c['not'] === null ? v !== null && v !== undefined : v !== c['not'];
      return false;
    }
    return v === cond;
  });
}

function table(rows: Row[], defaults: () => Row) {
  return {
    rows,
    findMany: async (a: { where?: Row } = {}) => rows.filter((r) => matches(r, a.where)),
    findFirst: async (a: { where?: Row } = {}) => rows.find((r) => matches(r, a.where)) ?? null,
    findUnique: async (a: { where: Row }) => {
      const w = { ...a.where };
      const compound = w['calendarId_granteeId'] as Row | undefined;
      if (compound) { delete w['calendarId_granteeId']; Object.assign(w, compound); }
      return rows.find((r) => matches(r, w)) ?? null;
    },
    create: async (a: { data: Row }) => {
      const row = { ...defaults(), ...a.data, updatedAt: tick() };
      rows.push(row);
      return row;
    },
    update: async (a: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, a.where));
      if (!row) throw new Error('not found');
      Object.assign(row, a.data, { updatedAt: tick() });
      return row;
    },
    delete: async (a: { where: Row }) => {
      const i = rows.findIndex((r) => matches(r, a.where));
      return rows.splice(i, 1)[0];
    },
    aggregate: async (a: { where?: Row }) => {
      const hit = rows.filter((r) => matches(r, a.where));
      const max = hit.reduce<Date | null>((m, r) => {
        const u = r['updatedAt'] as Date;
        return !m || u > m ? u : m;
      }, null);
      return { _count: { _all: hit.length }, _max: { updatedAt: max } };
    },
  };
}

const db = {
  calendar: table([
    { id: 'cal1', userId: 'alice', name: 'Work' },
  ], () => ({ color: '#0078D4' })),
  calendarShare: table([
    { calendarId: 'cal1', granteeId: 'bob', permission: 'READ' },
  ], () => ({})),
  calendarEvent: table([], () => ({ classification: 'PUBLIC', recurring: false, rrule: null, allDay: false })),
  contact: table([], () => ({ email: '', company: '' })),
};

(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined, ...db };

const express = (await import('express')).default;
const { caldavRouter } = await import('./index.js');
const { carddavRouter } = await import('../carddav/index.js');

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.text({ type: ['text/calendar', 'text/vcard', 'application/xml', 'text/xml'], limit: '10mb' }));
  // Faked auth: the X-Test-User header becomes req.davUser
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const u = req.get('X-Test-User');
    if (u) req.davUser = { userId: u, email: `${u}@example.com` };
    next();
  });
  app.use('/dav', caldavRouter);
  app.use('/dav', carddavRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function dav(method: string, path: string, opts: { user?: string; body?: string; type?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'X-Test-User': opts.user ?? 'alice',
      ...(opts.body !== undefined ? { 'Content-Type': opts.type ?? 'application/xml; charset=utf-8' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
}

const ICS_TZ = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:uid-tz@test', 'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20260101T100000', 'DTEND;TZID=Europe/Berlin:20260101T110000',
  'SUMMARY:Planning', 'RRULE:FREQ=WEEKLY;COUNT=5', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const ICS_ALLDAY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:uid-day@test', 'DTSTART;VALUE=DATE:20260110', 'DTEND;VALUE=DATE:20260111',
  'SUMMARY:Holiday', 'CLASS:PRIVATE', 'DESCRIPTION:secret', ' continued secret', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const CAL = '/dav/calendars/alice/cal1';

test('PUT stores TZID/all-day/RRULE correctly and returns an ETag that GET repeats', async () => {
  const put = await dav('PUT', `${CAL}/ev-tz.ics`, { body: ICS_TZ, type: 'text/calendar' });
  assert.equal(put.status, 201);
  assert.ok(put.etag);
  const row = db.calendarEvent.rows.find((r) => r['id'] === 'ev-tz')!;
  assert.equal((row['dtStart'] as Date).toISOString(), '2026-01-01T09:00:00.000Z');
  assert.equal(row['rrule'], 'FREQ=WEEKLY;COUNT=5');
  assert.equal(row['recurring'], true);
  assert.equal(row['uid'], 'uid-tz@test');

  const get = await dav('GET', `${CAL}/ev-tz.ics`);
  assert.equal(get.status, 200);
  assert.equal(get.etag, put.etag);
  assert.equal((await dav('GET', `${CAL}/ev-tz.ics`, { headers: { 'If-None-Match': put.etag! } })).status, 304);

  const day = await dav('PUT', `${CAL}/ev-day.ics`, { body: ICS_ALLDAY, type: 'text/calendar' });
  assert.equal(day.status, 201);
  const dayRow = db.calendarEvent.rows.find((r) => r['id'] === 'ev-day')!;
  assert.equal(dayRow['allDay'], true);
  assert.equal((dayRow['dtEnd'] as Date).toISOString(), '2026-01-11T00:00:00.000Z');
  assert.equal(dayRow['description'], 'secretcontinued secret');
});

test('PUT honours If-Match / If-None-Match and changes the ETag on update', async () => {
  const first = await dav('GET', `${CAL}/ev-tz.ics`);
  assert.equal((await dav('PUT', `${CAL}/ev-tz.ics`, { body: ICS_TZ, type: 'text/calendar', headers: { 'If-None-Match': '*' } })).status, 412);
  assert.equal((await dav('PUT', `${CAL}/ev-tz.ics`, { body: ICS_TZ, type: 'text/calendar', headers: { 'If-Match': '"stale"' } })).status, 412);
  assert.equal((await dav('PUT', `${CAL}/ev-new.ics`, { body: ICS_TZ.replace('uid-tz', 'uid-x'), type: 'text/calendar', headers: { 'If-Match': '*' } })).status, 412);

  const upd = await dav('PUT', `${CAL}/ev-tz.ics`, { body: ICS_TZ.replace('Planning', 'Planning v2'), type: 'text/calendar', headers: { 'If-Match': first.etag! } });
  assert.equal(upd.status, 204);
  assert.ok(upd.etag);
  assert.notEqual(upd.etag, first.etag);
});

test('PUT rejects documents without a usable VEVENT (400) and duplicate UIDs (409) instead of crashing', async () => {
  assert.equal((await dav('PUT', `${CAL}/bad.ics`, { body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', type: 'text/calendar' })).status, 400);
  assert.equal((await dav('PUT', `${CAL}/bad2.ics`, { body: ICS_TZ.replace('20260101T100000', 'garbage'), type: 'text/calendar' })).status, 400);
  const dup = await dav('PUT', `${CAL}/other-name.ics`, { body: ICS_TZ, type: 'text/calendar' });
  assert.equal(dup.status, 409);
  assert.match(dup.text, /no-uid-conflict/);
});

test('REPORT reaches its handler: calendar-query returns calendar-data with ETags', async () => {
  const res = await dav('REPORT', `${CAL}/`, {
    headers: { Depth: '1' },
    body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>' +
      '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20260105T000000Z" end="20260112T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>',
  });
  assert.equal(res.status, 207);
  assert.match(res.text, /ev-tz\.ics/);   // recurring series started before the range end
  assert.match(res.text, /ev-day\.ics/);  // overlaps the range
  assert.match(res.text, /BEGIN:VCALENDAR/);
  const todo = await dav('REPORT', CAL, {
    body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>',
  });
  assert.equal(todo.status, 207);
  assert.doesNotMatch(todo.text, /\.ics/);
});

test('REPORT calendar-multiget returns found resources and 404 entries', async () => {
  const res = await dav('REPORT', CAL, {
    body: `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>
      <d:href>${CAL}/ev-tz.ics</d:href><d:href>${CAL}/missing.ics</d:href></c:calendar-multiget>`,
  });
  assert.equal(res.status, 207);
  assert.match(res.text, /Planning v2/);
  assert.match(res.text, /missing\.ics<\/d:href><d:status>HTTP\/1.1 404 Not Found/);
});

test('REPORT sync-collection: initial full sync, same token = no changes, stale token = 403 valid-sync-token', async () => {
  const body = (tok: string) => `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${tok}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
  const initial = await dav('REPORT', CAL, { body: body('') });
  assert.equal(initial.status, 207);
  assert.match(initial.text, /ev-tz\.ics/);
  const token = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(initial.text)?.[1];
  assert.ok(token);
  const same = await dav('REPORT', CAL, { body: body(token) });
  assert.equal(same.status, 207);
  assert.doesNotMatch(same.text, /\.ics/);

  await dav('PUT', `${CAL}/ev-day.ics`, { body: ICS_ALLDAY.replace('Holiday', 'Holiday!'), type: 'text/calendar' });
  const stale = await dav('REPORT', CAL, { body: body(token) });
  assert.equal(stale.status, 403);
  assert.match(stale.text, /valid-sync-token/);
});

test('getctag changes on edit and delete; DELETE honours If-Match', async () => {
  const ctag = async () => /getctag>([^<]+)</.exec((await dav('PROPFIND', `${CAL}/`, { headers: { Depth: '0' } })).text)?.[1];
  const c1 = await ctag();
  await dav('PUT', `${CAL}/ev-day.ics`, { body: ICS_ALLDAY.replace('Holiday', 'Holiday!!'), type: 'text/calendar' });
  const c2 = await ctag();
  assert.notEqual(c2, c1);
  assert.equal((await dav('DELETE', `${CAL}/ev-day.ics`, { headers: { 'If-Match': '"stale"' } })).status, 412);
  const cur = await dav('GET', `${CAL}/ev-day.ics`);
  assert.equal((await dav('DELETE', `${CAL}/ev-day.ics`, { headers: { 'If-Match': cur.etag! } })).status, 204);
  assert.notEqual(await ctag(), c2);
});

test('PRIVATE events are masked for grantees even when DESCRIPTION is folded', async () => {
  await dav('PUT', `${CAL}/ev-priv.ics`, { body: ICS_ALLDAY.replace('uid-day', 'uid-priv'), type: 'text/calendar' });
  const asBob = await dav('REPORT', '/dav/calendars/bob/cal1', {
    user: 'bob',
    body: `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><d:href>/dav/calendars/bob/cal1/ev-priv.ics</d:href></c:calendar-multiget>`,
  });
  assert.equal(asBob.status, 207);
  assert.doesNotMatch(asBob.text, /secret|Holiday/);
  assert.match(asBob.text, /SUMMARY:Beschäftigt/);
  // READ grantee cannot write
  assert.equal((await dav('PUT', '/dav/calendars/bob/cal1/x.ics', { user: 'bob', body: ICS_ALLDAY, type: 'text/calendar' })).status, 403);
});

test('MKCALENDAR reaches its handler; unsupported methods on a collection get 405', async () => {
  assert.equal((await dav('MKCALENDAR', '/dav/calendars/alice/cal2')).status, 201);
  assert.equal((await dav('MKCALENDAR', '/dav/calendars/alice/cal2')).status, 405);
  assert.equal((await dav('POST', CAL)).status, 405);
  assert.equal((await dav('PROPFIND', CAL, { user: 'mallory' })).status, 403);
});

test('CardDAV: REPORT reaches its handler, ETag/ctag change on edit, If-Match enforced', async () => {
  const AB = '/dav/addressbooks/alice/default';
  const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN;CHARSET=UTF-8:Jane\r\n  Doe\r\nitem1.EMAIL;TYPE=INTERNET:jane@example.com\r\nORG:ACME\\; Inc;Sales\r\nEND:VCARD\r\n';
  const put = await dav('PUT', `${AB}/c1.vcf`, { body: vcard, type: 'text/vcard' });
  assert.equal(put.status, 201);
  const row = db.contact.rows.find((r) => r['id'] === 'c1')!;
  assert.deepEqual([row['displayName'], row['email'], row['company']], ['Jane Doe', 'jane@example.com', 'ACME; Inc']);

  const ctag = async () => /getctag>([^<]+)</.exec((await dav('PROPFIND', AB, { headers: { Depth: '0' } })).text)?.[1];
  const c1 = await ctag();
  const report = await dav('REPORT', AB, { body: '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>' });
  assert.equal(report.status, 207);
  assert.match(report.text, /c1\.vcf/);
  assert.match(report.text, /BEGIN:VCARD/);

  assert.equal((await dav('PUT', `${AB}/c1.vcf`, { body: vcard, type: 'text/vcard', headers: { 'If-Match': '"stale"' } })).status, 412);
  const upd = await dav('PUT', `${AB}/c1.vcf`, { body: vcard.replace('Jane', 'Janet'), type: 'text/vcard', headers: { 'If-Match': put.etag! } });
  assert.equal(upd.status, 204);
  assert.notEqual(upd.etag, put.etag);
  assert.notEqual(await ctag(), c1);
});
