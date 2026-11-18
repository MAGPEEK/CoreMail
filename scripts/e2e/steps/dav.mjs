// Step 7: CalDAV / CardDAV.
import { randomUUID } from 'node:crypto';
import { check, assert, creds, http, basic, session } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const B = state.users.b.email, uid = state.users.b.id;
  const auth = basic(B, c.userB);
  const H = (extra = {}) => ({ Authorization: auth, ...extra });

  let calHref;
  await check('caldav: PROPFIND calendar home lists the default calendar', async () => {
    const r = await http('PROPFIND', `/dav/calendars/${uid}`, {
      headers: H({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
    });
    assert(r.status === 207, `${r.status} ${r.text.slice(0, 200)}`);
    const hrefs = [...r.text.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]);
    calHref = hrefs.find((h) => h.replace(/\/$/, '').split('/').length > `/dav/calendars/${uid}`.split('/').length);
    assert(calHref, `no calendar collection in ${hrefs.join(', ')}`);
    const unauth = await http('PROPFIND', `/dav/calendars/${uid}`, { headers: { Depth: '0' } });
    assert(unauth.status === 401, `unauthenticated → ${unauth.status}`);
    return `${calHref}; unauthenticated 401`;
  });

  const evUid = `e2e-${randomUUID()}`;
  const evPath = `${calHref.replace(/\/?$/, '/')}${evUid}.ics`;
  const ics = (summary) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CoreMail e2e//EN',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
    'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:${evUid}`, 'DTSTAMP:20261101T120000Z',
    'DTSTART;TZID=Europe/Berlin:20261201T090000', 'DTEND;TZID=Europe/Berlin:20261201T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10', `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

  let etag1;
  await check('caldav: PUT event with TZID + RRULE → 201 + ETag', async () => {
    const r = await http('PUT', evPath, { headers: H({ 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }), body: ics('E2E weekly') });
    assert(r.status === 201 || r.status === 204, `${r.status} ${r.text.slice(0, 200)}`);
    etag1 = r.headers.get('etag');
    assert(etag1, 'no ETag on PUT');
    return `${r.status} ETag ${etag1}`;
  });

  await check('caldav: GET returns RRULE and TZID', async () => {
    const r = await http('GET', evPath, { headers: H() });
    assert(r.status === 200, `${r.status}`);
    assert(/RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10/.test(r.text), `RRULE lost:\n${r.text}`);
    assert(/DTSTART;TZID=Europe\/Berlin:20261201T090000/.test(r.text) || /DTSTART:20261201T080000Z/.test(r.text), `DTSTART/TZID lost:\n${r.text}`);
    return /TZID=Europe\/Berlin/.test(r.text) ? 'RRULE + TZID preserved' : 'RRULE preserved, DTSTART converted to UTC (same instant)';
  });

  await check('caldav: REPORT calendar-query returns the event', async () => {
    const r = await http('REPORT', calHref, {
      headers: H({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261101T000000Z" end="20270301T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
    });
    assert(r.status === 207, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.text.includes(evUid), 'event UID not in REPORT');
    return '207 with event';
  });

  let etag2;
  await check('caldav: update with If-Match → new ETag', async () => {
    const r = await http('PUT', evPath, { headers: H({ 'Content-Type': 'text/calendar', 'If-Match': etag1 }), body: ics('E2E weekly (updated)') });
    assert(r.status === 204 || r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    etag2 = r.headers.get('etag') ?? (await http('GET', evPath, { headers: H() })).headers.get('etag');
    assert(etag2 && etag2 !== etag1, `ETag unchanged: ${etag1} → ${etag2}`);
    return `${etag1} → ${etag2}`;
  });

  await check('caldav: stale If-Match → 412', async () => {
    const r = await http('PUT', evPath, { headers: H({ 'Content-Type': 'text/calendar', 'If-Match': etag1 }), body: ics('E2E stale') });
    assert(r.status === 412, `${r.status}`);
    return '412';
  });

  await check('caldav→REST: CalDAV event expands to weekly instances in /api/v1/calendar/events', async () => {
    const tok = await session(state, 'b', B, c.userB);
    const r = await http('GET', '/api/v1/calendar/events?start=2026-11-30T00:00:00Z&end=2027-01-01T00:00:00Z', { token: tok });
    assert(r.status === 200, `${r.status}`);
    const list = Array.isArray(r.json) ? r.json : r.json?.events ?? [];
    const inst = list.filter((e) => /E2E weekly/.test(e.summary ?? e.title ?? ''));
    // Tuesdays in Dec 2026: 1, 8, 15, 22, 29 → 5 instances, 09:00 Berlin = 08:00Z
    const perEvent = {};
    for (const e of inst) perEvent[e.id] = (perEvent[e.id] ?? 0) + 1;
    assert(Object.values(perEvent).length >= 1 && Object.values(perEvent).every((n) => n === 5), `instances per event: ${JSON.stringify(perEvent)}`);
    assert(inst.every((e) => new Date(e.dtStart ?? e.start).getUTCHours() === 8), `start hours ${inst.map((e) => e.dtStart ?? e.start).join(',')}`);
    return `5 instances at 08:00Z`;
  });

  // 9.4: single occurrences — written by a CalDAV client, then by the webmail (REST)
  const withException = ics('E2E weekly (updated)')
    .replace('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10\r\nEXDATE;TZID=Europe/Berlin:20261215T090000')
    .replace('END:VEVENT', ['END:VEVENT', 'BEGIN:VEVENT', `UID:${evUid}`, 'DTSTAMP:20261101T120000Z',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261208T090000', 'DTSTART;TZID=Europe/Berlin:20261208T140000',
      'DTEND;TZID=Europe/Berlin:20261208T150000', 'SUMMARY:E2E moved', 'END:VEVENT'].join('\r\n'));
  let seriesId;
  await check('caldav→REST: series exception (RECURRENCE-ID override + EXDATE) shows in /api/v1/calendar/events', async () => {
    const put = await http('PUT', evPath, { headers: H({ 'Content-Type': 'text/calendar; charset=utf-8' }), body: withException });
    assert(put.status === 204 || put.status === 200 || put.status === 201, `${put.status} ${put.text.slice(0, 200)}`);
    const tok = await session(state, 'b', B, c.userB);
    const r = await http('GET', '/api/v1/calendar/events?start=2026-11-30T00:00:00Z&end=2027-01-01T00:00:00Z', { token: tok });
    const inst = (r.json ?? []).filter((e) => e.uid === evUid);
    seriesId = inst[0]?.id;
    const view = inst.map((e) => `${e.dtStart.slice(0, 16)} ${e.summary}`);
    assert(inst.length === 4, `4 instances expected (EXDATE 15.12.): ${view.join(' | ')}`);
    assert(inst.some((e) => e.summary === 'E2E moved' && e.dtStart.startsWith('2026-12-08T13:00')), `override missing: ${view.join(' | ')}`);
    assert(!inst.some((e) => e.dtStart.startsWith('2026-12-15')), 'EXDATE ignored');
    return view.join(' | ');
  });

  await check('REST→caldav: occurrence changed / deleted in the webmail is RECURRENCE-ID / EXDATE in CalDAV', async () => {
    assert(seriesId, 'no series id from the previous check');
    const tok = await session(state, 'b', B, c.userB);
    const put = await http('PUT', `/api/v1/calendar/events/${seriesId}?occurrence=2026-12-22T08:00:00.000Z`, { token: tok, body: { summary: 'E2E REST occurrence', showAs: 'TENTATIVE' } });
    assert(put.status === 200, `${put.status} ${put.text}`);
    const del = await http('DELETE', `/api/v1/calendar/events/${seriesId}?occurrence=2026-12-29T08:00:00.000Z`, { token: tok });
    assert(del.status === 200, `${del.status} ${del.text}`);
    const g = await http('GET', evPath, { headers: H() });
    assert(g.status === 200, `${g.status}`);
    const unfolded = g.text.replace(/\r?\n[ \t]/g, '');
    assert(/RECURRENCE-ID;TZID=Europe\/Berlin:20261222T090000/.test(unfolded) && /SUMMARY:E2E REST occurrence/.test(unfolded), `override not in CalDAV:\n${unfolded}`);
    assert(/EXDATE;TZID=Europe\/Berlin:20261229T090000/.test(unfolded), `EXDATE not in CalDAV:\n${unfolded}`);
    assert(/RECURRENCE-ID;TZID=Europe\/Berlin:20261208T090000/.test(unfolded), 'the CalDAV override was lost');
    return 'override + EXDATE written in the series TZID';
  });

  // ── CardDAV ────────────────────────────────────────────────────────────────
  const cUid = `e2e-${randomUUID()}`;
  const cPath = `/dav/addressbooks/${uid}/default/${cUid}.vcf`;
  await check('carddav: PUT contact → 201', async () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${cUid}`, 'FN:Carol E2E', 'N:E2E;Carol;;;', 'EMAIL;TYPE=INTERNET:carol@external-e2e.test', 'TEL;TYPE=CELL:+49 170 0000000', 'END:VCARD', ''].join('\r\n');
    const r = await http('PUT', cPath, { headers: H({ 'Content-Type': 'text/vcard; charset=utf-8' }), body: vcf });
    assert(r.status === 201 || r.status === 204, `${r.status} ${r.text.slice(0, 200)}`);
    return `${r.status} ETag ${r.headers.get('etag')}`;
  });
  await check('carddav: REPORT addressbook-query returns the contact', async () => {
    const r = await http('REPORT', `/dav/addressbooks/${uid}/default/`, {
      headers: H({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>',
    });
    assert(r.status === 207, `${r.status} ${r.text.slice(0, 200)}`);
    assert(/Carol E2E/.test(r.text), 'contact not in REPORT');
    return '207 with contact';
  });
  await check('carddav: GET returns the vCard (email + phone)', async () => {
    const r = await http('GET', cPath, { headers: H() });
    assert(r.status === 200 && /carol@external-e2e\.test/.test(r.text) && /0000000/.test(r.text), `${r.status}\n${r.text}`);
    return 'ok';
  });
}
