import { test } from 'node:test';
import assert from 'node:assert/strict';

// @coremail/core validates its environment on import (logger → config)
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const {
  checkPreconditions,
  collectionTag,
  etagFor,
  parseReportRequest,
  resourceIdFromHref,
  syncTokenFor,
} = await import('./dav-utils.js');

test('etagFor is a quoted strong ETag that changes with updatedAt and id', () => {
  const t1 = new Date('2026-01-01T00:00:00.000Z');
  const t2 = new Date('2026-01-01T00:00:00.001Z');
  const a = etagFor('ev1', t1);
  assert.match(a, /^"[0-9a-f]{20}"$/);
  assert.equal(etagFor('ev1', t1), a, 'deterministic');
  assert.notEqual(etagFor('ev1', t2), a, 'edit → new ETag');
  assert.notEqual(etagFor('ev2', t1), a, 'other resource → other ETag');
  assert.notEqual(a, '"ev1"');
});

test('collectionTag reacts to edits (max updatedAt) and deletes (count)', () => {
  const t = new Date('2026-01-01T00:00:00Z');
  const base = collectionTag(3, t);
  assert.notEqual(collectionTag(3, new Date(t.getTime() + 1)), base); // edit
  assert.notEqual(collectionTag(2, t), base);                         // delete
  assert.equal(collectionTag(0, null), '0-0');
  assert.equal(syncTokenFor(base), `http://coremail.invalid/ns/sync/${base}`);
});

test('checkPreconditions: If-Match / If-None-Match table', () => {
  const E = '"abc"';
  const table: Array<[string, { ifMatch?: string; ifNoneMatch?: string }, string | null, 304 | 412 | null]> = [
    ['PUT', {}, E, null],
    ['PUT', {}, null, null],
    ['PUT', { ifMatch: E }, E, null],
    ['PUT', { ifMatch: '"old"' }, E, 412],
    ['PUT', { ifMatch: '"old", "abc"' }, E, null],
    ['PUT', { ifMatch: 'W/"abc"' }, E, null],
    ['PUT', { ifMatch: '*' }, E, null],
    ['PUT', { ifMatch: '*' }, null, 412],
    ['PUT', { ifMatch: E }, null, 412],
    ['PUT', { ifNoneMatch: '*' }, null, null],
    ['PUT', { ifNoneMatch: '*' }, E, 412],
    ['DELETE', { ifMatch: '"old"' }, E, 412],
    ['GET', { ifNoneMatch: E }, E, 304],
    ['GET', { ifNoneMatch: '"old"' }, E, null],
  ];
  for (const [method, headers, current, expected] of table) {
    assert.equal(checkPreconditions(method, headers, current), expected, `${method} ${JSON.stringify(headers)} current=${current}`);
  }
});

test('parseReportRequest classifies the REPORT bodies clients send', () => {
  const query = parseReportRequest(`<?xml version="1.0"?>
    <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <D:prop><D:getetag/><C:calendar-data/></D:prop>
      <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
        <C:time-range start="20260101T000000Z" end="20260201T000000Z"/>
      </C:comp-filter></C:comp-filter></C:filter>
    </C:calendar-query>`);
  assert.equal(query.kind, 'calendar-query');
  assert.deepEqual(query.compFilters, ['VCALENDAR', 'VEVENT']);
  assert.equal(query.timeRange?.start?.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(query.timeRange?.end?.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(query.wantsData, true);

  const etagsOnly = parseReportRequest('<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop></c:calendar-query>');
  assert.equal(etagsOnly.wantsData, false);

  const multiget = parseReportRequest(`<calendar-multiget xmlns="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:">
    <D:prop><D:getetag/><calendar-data/></D:prop>
    <D:href>/dav/calendars/u/c/a%201.ics</D:href><D:href>/dav/calendars/u/c/b.ics</D:href>
  </calendar-multiget>`);
  assert.equal(multiget.kind, 'calendar-multiget');
  assert.deepEqual(multiget.hrefs, ['/dav/calendars/u/c/a%201.ics', '/dav/calendars/u/c/b.ics']);

  const sync = parseReportRequest('<d:sync-collection xmlns:d="DAV:"><d:sync-token>tok&amp;1</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>');
  assert.equal(sync.kind, 'sync-collection');
  assert.equal(sync.syncToken, 'tok&1');
  assert.equal(parseReportRequest('<d:sync-collection xmlns:d="DAV:"><d:sync-token/></d:sync-collection>').syncToken, '');

  assert.equal(parseReportRequest('<x:free-busy-query xmlns:x="urn:ietf:params:xml:ns:caldav"/>').kind, 'unknown');
  assert.equal(parseReportRequest(undefined).kind, 'unknown');
});

test('resourceIdFromHref strips path, extension and percent-encoding', () => {
  assert.equal(resourceIdFromHref('/dav/calendars/u/c/abc.ics', '.ics'), 'abc');
  assert.equal(resourceIdFromHref('https://mail.example.com/dav/calendars/u/c/a%201.ics', '.ics'), 'a 1');
  assert.equal(resourceIdFromHref('/dav/addressbooks/u/default/x.vcf', '.vcf'), 'x');
});

test('parseReportRequest is namespace-aware: attributes on href, CDATA, entities, DOCTYPE entities not expanded', () => {
  const r = parseReportRequest(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY big "aaaa">]>
    <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><d:getetag/></d:prop>
      <d:href xml:lang="en">/dav/a.ics</d:href><d:href><![CDATA[/dav/b&c.ics]]></d:href><d:href>/dav/&#100;.ics</d:href>
    </c:calendar-multiget>`);
  assert.equal(r.kind, 'calendar-multiget');
  assert.deepEqual(r.hrefs, ['/dav/a.ics', '/dav/b&c.ics', '/dav/d.ics']);
  assert.equal(r.wantsData, false, 'a getetag-only prop list does not want calendar-data');
  // the CalDAV element name in the wrong namespace is not a calendar-query
  assert.equal(parseReportRequest('<calendar-query xmlns="DAV:"/>').kind, 'unknown');
});