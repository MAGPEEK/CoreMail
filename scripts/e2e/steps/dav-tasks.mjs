// Step 7b (9.5): the CalDAV task list (VTODO) — CalDAV PUT → REST read, REST create → REPORT,
// completing a recurring task over CalDAV creates the next one.
import { randomUUID } from 'node:crypto';
import { check, assert, creds, http, basic, session } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const B = state.users.b.email, uid = state.users.b.id;
  const auth = basic(B, c.userB);
  const H = (extra = {}) => ({ Authorization: auth, ...extra });
  const list = `/dav/calendars/${uid}/tasks/`;
  const vtodo = (todoUid, ...props) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CoreMail e2e//EN', 'BEGIN:VTODO',
    `UID:${todoUid}`, 'DTSTAMP:20261118T120000Z', ...props, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
  const unfold = (s) => s.replace(/\r?\n[ \t]/g, '');

  await check('caldav tasks: the calendar home lists the task list (VTODO)', async () => {
    const r = await http('PROPFIND', `/dav/calendars/${uid}`, {
      headers: H({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>',
    });
    assert(r.status === 207, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.text.includes(list), `no task list in ${r.text.slice(0, 400)}`);
    assert(/name="VTODO"/.test(r.text), 'no VTODO component set');
    return list;
  });

  const todoUid = `e2e-todo-${randomUUID()}`;
  const todoPath = `${list}${todoUid}.ics`;
  let taskId = todoUid;
  await check('caldav→REST: VTODO PUT is a task in /api/v1/tasks (status rules applied)', async () => {
    const put = await http('PUT', todoPath, {
      headers: H({ 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }),
      body: vtodo(todoUid, 'SUMMARY:E2E Aufgabe', 'STATUS:IN-PROCESS', 'PERCENT-COMPLETE:40', 'DUE;VALUE=DATE:20261215', 'PRIORITY:1', 'CATEGORIES:E2E'),
    });
    assert(put.status === 201, `${put.status} ${put.text.slice(0, 200)}`);
    const tok = await session(state, 'b', B, c.userB);
    const r = await http('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, { token: tok });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const t = r.json;
    assert(t.subject === 'E2E Aufgabe' && t.status === 'IN_PROGRESS' && t.percentComplete === 40, JSON.stringify(t));
    assert(t.priority === 'HIGH' && String(t.dueDate).startsWith('2026-12-15'), JSON.stringify(t));
    return `${t.status} ${t.percentComplete} % due ${t.dueDate}`;
  });

  await check('REST→caldav: a change in the webmail shows in GET, CATEGORIES round-trip', async () => {
    const tok = await session(state, 'b', B, c.userB);
    const r = await http('PUT', `/api/v1/tasks/${encodeURIComponent(taskId)}`, { token: tok, body: { status: 'WAITING', percentComplete: 0 } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    const g = await http('GET', todoPath, { headers: H() });
    assert(g.status === 200 && g.headers.get('etag'), `${g.status}`);
    const text = unfold(g.text);
    assert(/\r\nSTATUS:NEEDS-ACTION\r\n/.test(text), `status:\n${text}`);
    assert(/\r\nCATEGORIES:E2E\r\n/.test(text), `CATEGORIES lost:\n${text}`);
    return 'WAITING shown as NEEDS-ACTION, CATEGORIES kept';
  });

  let restId;
  await check('REST→caldav: a task created in the webmail is in REPORT calendar-query (VTODO)', async () => {
    const tok = await session(state, 'b', B, c.userB);
    const created = await http('POST', '/api/v1/tasks', { token: tok, body: { subject: 'E2E REST task', dueDate: '2026-12-20T00:00:00.000Z', priority: 'LOW' } });
    assert(created.status === 201, `${created.status} ${created.text}`);
    restId = created.json.id;
    const r = await http('REPORT', list, {
      headers: H({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"><c:time-range start="20261201T000000Z" end="20270101T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>',
    });
    assert(r.status === 207, `${r.status} ${r.text.slice(0, 200)}`);
    const text = unfold(r.text);
    assert(text.includes(`${restId}.ics`) && /SUMMARY:E2E REST task/.test(text), `REST task missing:\n${text.slice(0, 600)}`);
    assert(/PRIORITY:9/.test(text) && /DUE;VALUE=DATE:20261220/.test(text), `mapping:\n${text.slice(0, 600)}`);
    assert(text.includes(`${todoUid}.ics`), 'the CalDAV task is missing');
    return `${restId}.ics + ${todoUid}.ics`;
  });

  await check('caldav: completing a recurring task creates the next one (REST sees both)', async () => {
    const recUid = `e2e-rec-${randomUUID()}`;
    const path = `${list}${recUid}.ics`;
    const body = (...p) => vtodo(recUid, 'SUMMARY:E2E weekly task', 'DUE;VALUE=DATE:20261204', 'RRULE:FREQ=WEEKLY', ...p);
    const put = await http('PUT', path, { headers: H({ 'Content-Type': 'text/calendar' }), body: body() });
    assert(put.status === 201, `${put.status} ${put.text.slice(0, 200)}`);
    const done = await http('PUT', path, { headers: H({ 'Content-Type': 'text/calendar' }), body: body('STATUS:COMPLETED', 'COMPLETED:20261204T150000Z') });
    assert(done.status === 204, `${done.status} ${done.text.slice(0, 200)}`);
    const tok = await session(state, 'b', B, c.userB);
    const all = await http('GET', '/api/v1/tasks', { token: tok });
    const weekly = (all.json ?? []).filter((t) => t.subject === 'E2E weekly task');
    assert(weekly.length === 2, `2 tasks expected: ${JSON.stringify(weekly)}`);
    const next = weekly.find((t) => t.status === 'NOT_STARTED');
    assert(next && String(next.dueDate).startsWith('2026-12-11') && next.rrule === 'FREQ=WEEKLY', JSON.stringify(weekly));
    const g = unfold((await http('GET', path, { headers: H() })).text);
    assert(/STATUS:COMPLETED/.test(g) && !/RRULE/.test(g), `completed occurrence:\n${g}`);
    // review: the client sending its completed copy again (with RRULE) neither creates nor revives the series
    const again = await http('PUT', path, { headers: H({ 'Content-Type': 'text/calendar' }), body: body('STATUS:COMPLETED', 'COMPLETED:20261204T150000Z') });
    assert(again.status === 204, `${again.status}`);
    const after = ((await http('GET', '/api/v1/tasks', { token: tok })).json ?? []).filter((t) => t.subject === 'E2E weekly task');
    assert(after.length === 2 && after.find((t) => t.status === 'COMPLETED')?.rrule === null, JSON.stringify(after));
    for (const t of weekly) await http('DELETE', `/api/v1/tasks/${encodeURIComponent(t.id)}`, { token: tok });
    return `next due ${next.dueDate}`;
  });

  await check('caldav tasks: the name of the task list is reserved (MKCALENDAR 405, also percent-encoded)', async () => {
    for (const p of [`/dav/calendars/${uid}/Tasks/`, `/dav/calendars/${uid}/%74asks/`]) {
      const r = await http('MKCALENDAR', p, { headers: H() });
      assert(r.status === 405, `${p}: ${r.status}`);
    }
    return '405';
  });

  await check('caldav tasks: DELETE with a stale If-Match → 412, with the current ETag → 204', async () => {
    const g = await http('GET', todoPath, { headers: H() });
    const etag = g.headers.get('etag');
    const stale = await http('DELETE', todoPath, { headers: H({ 'If-Match': '"stale"' }) });
    assert(stale.status === 412, `${stale.status}`);
    const del = await http('DELETE', todoPath, { headers: H({ 'If-Match': etag }) });
    assert(del.status === 204, `${del.status}`);
    const tok = await session(state, 'b', B, c.userB);
    assert((await http('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, { token: tok })).status === 404, 'task still in REST');
    if (restId) await http('DELETE', `/api/v1/tasks/${restId}`, { token: tok });
    return 'deleted';
  });
}
