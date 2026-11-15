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
      if ('gte' in c) return (v as Date).getTime() >= (c['gte'] as Date).getTime();
      if ('contains' in c) return typeof v === 'string' && v.includes(c['contains'] as string);
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
      for (const key of ['calendarId_granteeId', 'calendarId_uid']) {
        const compound = w[key] as Row | undefined;
        if (compound) { delete w[key]; Object.assign(w, compound); }
      }
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
    groupBy: async (a: { by: string[]; where?: Row }) => {
      const groups = new Map<unknown, Row[]>();
      for (const r of rows.filter((x) => matches(x, a.where))) groups.set(r[a.by[0]!], [...(groups.get(r[a.by[0]!]) ?? []), r]);
      return [...groups].map(([key, hit]) => ({
        [a.by[0]!]: key,
        _count: { _all: hit.length },
        _max: { updatedAt: hit.reduce<Date | null>((m, r) => (!m || (r['updatedAt'] as Date) > m ? r['updatedAt'] as Date : m), null) },
      }));
    },
  };
}

const db = {
  calendar: table([
    { id: 'cal1', userId: 'alice', name: 'Work', color: '#0078D4', sortOrder: 0 },
  ], () => ({ color: '#0078D4', sortOrder: 0 })),
  calendarShare: table([
    { calendarId: 'cal1', granteeId: 'bob', permission: 'READ' },
  ], () => ({})),
  calendarEvent: table([], () => ({ classification: 'PUBLIC', recurring: false, rrule: null, allDay: false })),
  contact: table([], () => ({ email: '', company: '' })),
  user: table([{ id: 'alice', email: 'alice@example.com', displayName: 'Alice' }], () => ({})),
  emailAlias: table([{ targetUserId: 'alice', active: true, address: 'team@example.com' }], () => ({})),
};

(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined, ...db };

const express = (await import('express')).default;
const { caldavRouter } = await import('./index.js');
const { carddavRouter } = await import('../carddav/index.js');
const { principalRouter } = await import('../principal/index.js');

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
  app.use('/dav', principalRouter, caldavRouter, carddavRouter);
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


// ─── v7.1.0 protocol review fixes ────────────────────────────────────────────

const { granteeView, validateCalendarObject } = await import('./index.js');

/** Shared calendar with a WRITE grantee (carol). */
db.calendar.rows.push({ id: 'calw', userId: 'alice', name: 'Team', color: '#112233', sortOrder: 2 });
db.calendarShare.rows.push({ calendarId: 'calw', granteeId: 'carol', permission: 'WRITE' });
const CALW = '/dav/calendars/alice/calw';
const CAROL = '/dav/calendars/carol/calw';

const ICS_SECRET = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'X-WR-CALNAME:Secret cal',
  'BEGIN:VEVENT', 'UID:uid-secret@test', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20260301T100000Z', 'DTEND:20260301T110000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'CLASS:PRIVATE',
  'SUMMARY:Doctor', 'DESCRIPTION:diagnosis', 'LOCATION:Clinic',
  'CONFERENCE;VALUE=URI:https://meet.example/secret-room', 'GEO:48.1;11.5',
  'STYLED-DESCRIPTION;VALUE=TEXT;FMTTYPE=text/html:<b>diagnosis</b>', 'RELATED-TO:parent-uid',
  'IMAGE;VALUE=URI:https://img.example/x.png', 'URL:https://intranet.example/case/7', 'X-SECRET:1',
  'ORGANIZER:mailto:alice@example.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:dr@example.com',
  'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:pills', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

test('PRIVATE mask is an allowlist: CONFERENCE/GEO/STYLED-DESCRIPTION/RELATED-TO/IMAGE/URL/X- are stripped', () => {
  const view = granteeView(ICS_SECRET, 'PRIVATE', false)!;
  assert.equal(view.masked, true);
  for (const leak of ['secret-room', 'GEO', 'STYLED-DESCRIPTION', 'parent-uid', 'img.example', 'intranet', 'X-SECRET',
    'Doctor', 'diagnosis', 'Clinic', 'dr@example.com', 'VALARM', 'pills', 'Secret cal']) {
    assert.ok(!view.data.includes(leak), `leaked ${leak}`);
  }
  for (const keep of ['UID:uid-secret@test', 'DTSTART:20260301T100000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'CLASS:PRIVATE', 'SUMMARY:Beschäftigt']) {
    assert.ok(view.data.includes(keep), `missing ${keep}`);
  }
  assert.equal(granteeView(ICS_SECRET, 'PRIVATE', true)!.data, ICS_SECRET, 'owner sees everything');
  assert.equal(granteeView(ICS_SECRET.replace('CLASS:PRIVATE', 'CLASS:CONFIDENTIAL'), 'PUBLIC', false), null, 'master CLASS wins over column');
});

test('an overridden instance with its own CLASS:PRIVATE under a PUBLIC master is masked', () => {
  const ics = ICS_SECRET.replace('CLASS:PRIVATE\r\n', '').replace('END:VEVENT\r\nEND:VCALENDAR',
    'END:VEVENT\r\nBEGIN:VEVENT\r\nUID:uid-secret@test\r\nRECURRENCE-ID:20260302T100000Z\r\nDTSTART:20260302T120000Z\r\nDTEND:20260302T130000Z\r\nCLASS:PRIVATE\r\nSUMMARY:Override secret\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const view = granteeView(ics, 'PUBLIC', false)!;
  assert.equal(view.masked, true);
  assert.match(view.data, /SUMMARY:Doctor/);                // public master stays readable
  assert.doesNotMatch(view.data, /Override secret/);
  assert.equal(granteeView(ics.replace(/CLASS:PRIVATE/g, ''), 'PUBLIC', false)!.masked, false);
});

test('WRITE grantee: masked PRIVATE event has its own ETag and a PUT/DELETE never overwrites the owner data', async () => {
  const put = await dav('PUT', `${CALW}/secret.ics`, { body: ICS_SECRET, type: 'text/calendar' });
  assert.equal(put.status, 201);
  const asCarol = await dav('GET', `${CAROL}/secret.ics`, { user: 'carol' });
  assert.equal(asCarol.status, 200);
  assert.match(asCarol.text, /SUMMARY:Beschäftigt/);
  assert.notEqual(asCarol.etag, put.etag, 'masked view must not carry the owner ETag');

  // The client round-trips the masked copy with If-Match of what it saw
  const back = await dav('PUT', `${CAROL}/secret.ics`, { user: 'carol', body: asCarol.text, type: 'text/calendar', headers: { 'If-Match': asCarol.etag! } });
  assert.equal(back.status, 403);
  assert.match(back.text, /need-privileges/);
  const blind = await dav('PUT', `${CAROL}/secret.ics`, { user: 'carol', body: asCarol.text, type: 'text/calendar', headers: { 'If-Match': put.etag! } });
  assert.equal(blind.status, 403);
  assert.equal((await dav('DELETE', `${CAROL}/secret.ics`, { user: 'carol' })).status, 403);

  const row = db.calendarEvent.rows.find((r) => r['id'] === 'secret')!;
  assert.equal(row['summary'], 'Doctor');
  assert.match(String(row['icalData']), /BEGIN:VALARM/);
  assert.equal((row['attendees'] as unknown[]).length, 1);
  assert.equal((await dav('GET', `${CALW}/secret.ics`)).etag, put.etag, 'owner ETag unchanged');

  // Resource PROPFIND: masked ETag + read-only privilege set for the grantee
  const pf = await dav('PROPFIND', `${CAROL}/secret.ics`, { user: 'carol', headers: { Depth: '0' } });
  assert.equal(pf.status, 207);
  assert.ok(pf.text.includes(`<d:getetag>${asCarol.etag!.replace(/"/g, '&quot;')}</d:getetag>`) || pf.text.includes(asCarol.etag!));
  assert.doesNotMatch(pf.text, /<d:write\/>/);

  // A PUBLIC event in the same calendar stays writable for the grantee
  const pub = await dav('PUT', `${CAROL}/pub.ics`, { user: 'carol', body: ICS_TZ.replace('uid-tz@test', 'uid-pub@test'), type: 'text/calendar' });
  assert.equal(pub.status, 201);
  const upd = await dav('PUT', `${CAROL}/pub.ics`, { user: 'carol', body: ICS_TZ.replace('uid-tz@test', 'uid-pub@test').replace('Planning', 'Moved'), type: 'text/calendar', headers: { 'If-Match': pub.etag! } });
  assert.equal(upd.status, 204);
});

test('PUT preconditions: METHOD, several UIDs, VTODO, UID change on update', async () => {
  const withMethod = await dav('PUT', `${CAL}/m.ics`, { body: ICS_TZ.replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST').replace('uid-tz', 'uid-m'), type: 'text/calendar' });
  assert.equal(withMethod.status, 403);
  assert.match(withMethod.text, /valid-calendar-object-resource/);

  const twoUids = ICS_TZ.replace('uid-tz', 'uid-a').replace('END:VCALENDAR',
    'BEGIN:VEVENT\r\nUID:uid-b\r\nRECURRENCE-ID:20260108T090000Z\r\nDTSTART:20260108T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal((await dav('PUT', `${CAL}/two.ics`, { body: twoUids, type: 'text/calendar' })).status, 403);

  const todo = await dav('PUT', `${CAL}/todo.ics`, { body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:t1\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n', type: 'text/calendar' });
  assert.equal(todo.status, 403);
  assert.match(todo.text, /supported-calendar-component/);
  assert.equal(validateCalendarObject(ICS_TZ).ok, true);

  // UID change on update: to a UID used by another resource → 409, to a free one → stored
  const a = await dav('PUT', `${CAL}/u1.ics`, { body: ICS_TZ.replace('uid-tz', 'uid-u1'), type: 'text/calendar' });
  assert.equal(a.status, 201);
  const clash = await dav('PUT', `${CAL}/u1.ics`, { body: ICS_TZ, type: 'text/calendar' });
  assert.equal(clash.status, 409);
  assert.match(clash.text, /no-uid-conflict/);
  assert.equal((await dav('PUT', `${CAL}/u1.ics`, { body: ICS_TZ.replace('uid-tz', 'uid-u1-new'), type: 'text/calendar' })).status, 204);
  assert.equal(db.calendarEvent.rows.find((r) => r['id'] === 'u1')!['uid'], 'uid-u1-new@test');
});

test('calendar-query: zero-duration event at the range start matches; series without instance in range does not', async () => {
  const zero = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:uid-zero', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20260601T000000Z', 'SUMMARY:Reminder', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  assert.equal((await dav('PUT', `${CAL}/zero.ics`, { body: zero, type: 'text/calendar' })).status, 201);
  const q = (start: string, end: string, extra = '') => dav('REPORT', CAL, {
    body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/>${extra}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const at = await q('20260601T000000Z', '20260602T000000Z');
  assert.match(at.text, /zero\.ics/);
  // ev-tz: weekly from 2026-01-01, COUNT=5 → nothing in June
  assert.doesNotMatch(at.text, /ev-tz\.ics/);
});

test('calendar-query evaluates prop-filter/text-match (grantees only on the masked view) and rejects unknown collations', async () => {
  const body = (summary: string, collation = '') => `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="SUMMARY"><c:text-match${collation}>${summary}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const owner = await dav('REPORT', CALW, { body: body('doctor') });
  assert.match(owner.text, /secret\.ics/);
  assert.doesNotMatch(owner.text, /pub\.ics/);
  const grantee = await dav('REPORT', CAROL, { user: 'carol', body: body('doctor') });
  assert.doesNotMatch(grantee.text, /secret\.ics/, 'masked fields cannot be probed');
  const negate = await dav('REPORT', CALW, { body: body('doctor').replace('<c:text-match>', '<c:text-match negate-condition="yes">') });
  assert.match(negate.text, /pub\.ics/);
  assert.doesNotMatch(negate.text, /secret\.ics/);
  const bad = await dav('REPORT', CALW, { body: body('x', ' collation="i;klingon"') });
  assert.equal(bad.status, 403);
  assert.match(bad.text, /supported-collation/);
  const missingProp = await dav('REPORT', CALW, { body: body('x').replace(/<c:prop-filter name="SUMMARY">.*<\/c:prop-filter>/, '<c:prop-filter name="LOCATION"><c:is-not-defined/></c:prop-filter>') });
  assert.match(missingProp.text, /pub\.ics/);
  assert.doesNotMatch(missingProp.text, /secret\.ics/);
});

test('CALDAV:expand returns UTC instances with RECURRENCE-ID and no RRULE', async () => {
  const res = await dav('REPORT', CALW, {
    body: '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="20260301T000000Z" end="20260303T000000Z"/></c:calendar-data></d:prop>' +
      `<d:href>${CALW}/secret.ics</d:href></c:calendar-multiget>`,
  });
  assert.equal(res.status, 207);
  assert.equal((res.text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(res.text, /RECURRENCE-ID:20260301T100000Z/);
  assert.match(res.text, /RECURRENCE-ID:20260302T100000Z/);
  assert.doesNotMatch(res.text, /RRULE/);
});

test('discovery: /dav/ answers current-user-principal, the principal lists the homes; OPTIONS advertises no class 2', async () => {
  const root = await dav('PROPFIND', '/dav/', { headers: { Depth: '0' } });
  assert.equal(root.status, 207);
  assert.match(root.text, /<d:current-user-principal><d:href>\/dav\/principals\/alice\/<\/d:href>/);
  const p = await dav('PROPFIND', '/dav/principals/alice/', { headers: { Depth: '0' } });
  assert.equal(p.status, 207);
  assert.match(p.text, /<c:calendar-home-set><d:href>\/dav\/calendars\/alice\/<\/d:href>/);
  assert.match(p.text, /<ab:addressbook-home-set><d:href>\/dav\/addressbooks\/alice\/<\/d:href>/);
  assert.match(p.text, /mailto:alice@example.com/);
  assert.match(p.text, /mailto:team@example.com/);
  assert.match(p.text, /<d:principal\/>/);
  assert.equal((await dav('PROPFIND', '/dav/principals/alice/', { user: 'bob' })).status, 403);
  const home = await dav('PROPFIND', '/dav/calendars/alice/', { headers: { Depth: '1' } });
  assert.match(home.text, /current-user-principal/);
  assert.match(home.text, /ic:calendar-color>#112233</);

  const opts = await fetch(`${base}/dav/calendars/alice/`, { method: 'OPTIONS', headers: { 'X-Test-User': 'alice' } });
  const davHeader = opts.headers.get('dav') ?? '';
  assert.doesNotMatch(davHeader, /(^|,\s*)2(,|$)/);
  assert.doesNotMatch(davHeader, /access-control/);
  assert.doesNotMatch(opts.headers.get('allow') ?? '', /\bACL\b/);
});

test('PROPPATCH on a calendar: displayname/colour are stored; atomic failure; grantees get 403', async () => {
  const ok = await dav('PROPPATCH', `${CALW}/`, {
    body: '<d:propertyupdate xmlns:d="DAV:" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Renamed</d:displayname><i:calendar-color>#FF8800FF</i:calendar-color></d:prop></d:set></d:propertyupdate>',
  });
  assert.equal(ok.status, 207);
  assert.match(ok.text, /HTTP\/1.1 200 OK/);
  const cal = db.calendar.rows.find((r) => r['id'] === 'calw')!;
  assert.deepEqual([cal['name'], cal['color']], ['Renamed', '#FF8800']);

  const mixed = await dav('PROPPATCH', `${CALW}/`, {
    body: '<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:example"><d:set><d:prop><d:displayname>Nope</d:displayname><x:unknown>1</x:unknown></d:prop></d:set></d:propertyupdate>',
  });
  assert.match(mixed.text, /424 Failed Dependency/);
  assert.match(mixed.text, /403 Forbidden/);
  assert.equal(cal['name'], 'Renamed');

  const grantee = await dav('PROPPATCH', `${CAROL}/`, { user: 'carol', body: '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Mine</d:displayname></d:prop></d:set></d:propertyupdate>' });
  assert.match(grantee.text, /403 Forbidden/);
  assert.equal(cal['name'], 'Renamed');
});

test('MKCALENDAR applies displayname/colour and fails as a whole for a VTODO-only calendar', async () => {
  const body = (comp: string) => '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/"><d:set><d:prop>' +
    `<d:displayname>Holidays</d:displayname><i:calendar-color>#00AA00</i:calendar-color><c:supported-calendar-component-set><c:comp name="${comp}"/></c:supported-calendar-component-set>` +
    '</d:prop></d:set></c:mkcalendar>';
  const todo = await dav('MKCALENDAR', '/dav/calendars/alice/tasks1', { body: body('VTODO') });
  assert.equal(todo.status, 403);
  assert.match(todo.text, /mkcalendar-response/);
  assert.equal(db.calendar.rows.some((r) => r['id'] === 'tasks1'), false);
  assert.equal((await dav('MKCALENDAR', '/dav/calendars/alice/hol', { body: body('VEVENT') })).status, 201);
  const cal = db.calendar.rows.find((r) => r['id'] === 'hol')!;
  assert.deepEqual([cal['name'], cal['color']], ['Holidays', '#00AA00']);
});

test('CardDAV: home PROPFIND describes the home itself; resource PROPFIND; one vCard per resource; unique UID; query filter', async () => {
  const home = await dav('PROPFIND', '/dav/addressbooks/alice/', { headers: { Depth: '0' } });
  assert.equal(home.status, 207);
  assert.match(home.text, /<d:href>\/dav\/addressbooks\/alice\/<\/d:href>/);
  assert.doesNotMatch(home.text, /default\//);
  assert.match((await dav('PROPFIND', '/dav/addressbooks/alice/', { headers: { Depth: '1' } })).text, /default\//);

  const AB = '/dav/addressbooks/alice/default';
  const card = (uid: string, fn: string) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\nTEL;TYPE=CELL:+49 170 1\r\nEND:VCARD\r\n`;
  assert.equal((await dav('PUT', `${AB}/two.vcf`, { body: card('a', 'A') + card('b', 'B'), type: 'text/vcard' })).status, 403);
  assert.equal((await dav('PUT', `${AB}/k1.vcf`, { body: card('uid-k', 'Karl Klein'), type: 'text/vcard' })).status, 201);
  assert.equal(db.contact.rows.find((r) => r['id'] === 'k1')!['mobile'], '+49 170 1');
  const dup = await dav('PUT', `${AB}/k2.vcf`, { body: card('uid-k', 'Other'), type: 'text/vcard' });
  assert.equal(dup.status, 409);
  assert.match(dup.text, /no-uid-conflict/);

  const pf = await dav('PROPFIND', `${AB}/k1.vcf`, { headers: { Depth: '0' } });
  assert.equal(pf.status, 207);
  assert.match(pf.text, /getetag/);
  assert.equal((await dav('PROPFIND', `${AB}/nope.vcf`)).status, 404);
  assert.equal((await dav('PROPFIND', `${CAL}/ev-tz.ics`)).status, 207);
  assert.equal((await dav('PROPFIND', `${CAL}/nope.ics`)).status, 404);

  const query = (match: string) => dav('REPORT', AB, {
    body: `<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/></d:prop><card:filter><card:prop-filter name="FN"><card:text-match match-type="starts-with">${match}</card:text-match></card:prop-filter></card:filter></card:addressbook-query>`,
  });
  const hit = await query('karl');
  assert.match(hit.text, /k1\.vcf/);
  assert.doesNotMatch(hit.text, /c1\.vcf/);
  assert.doesNotMatch((await query('klein')).text, /k1\.vcf/);
});