// Step 8d (w3): ActiveSync Calendar, Tasks and Notes on a 14.1 device — FolderSync announces the
// own calendar / tasks / notes folders; an event created over REST arrives in the calendar Sync
// (ServerId = event id); a task, a note and a recurring meeting with a deleted occurrence added
// by the device are visible over REST; a REST change of the task reaches the device as a Change;
// a device Delete removes the task. Requests use the [MS-ASWBXML] code pages (4 Calendar,
// 9 Tasks, 23 Notes); every response carries only 14.1 tags. Runs after `eas` (needs the users).
import { check, assert, creds, http, basic, session } from '../lib.mjs';
import { decodeWbxml, tagsNewerThan } from '../../../packages/activesync/src/wbxml.ts';

/** Node: [page, token, children | text | undefined] — encoded like a device does. */
function encode(root) {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, t, kids]) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(t | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    if (typeof kids === 'string') { out.push(0x03); for (const b of Buffer.from(kids, 'utf8')) out.push(b); out.push(0x00); } else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}
const kid = (e, name) => e?.children?.find((c) => typeof c !== 'string' && c.name === name);
const all = (e, name) => (e?.children ?? []).filter((c) => typeof c !== 'string' && c.name === name);
const A = (t, k) => [0, t, k];
const C = (t, k) => [4, t, k];
const T = (t, k) => [9, t, k];
const N = (t, k) => [23, t, k];
const B = (t, k) => [17, t, k];
const PV = (t, k) => [14, t, k];
const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** calendar:TimeZone of UTC (172 zero bytes: Bias 0, no daylight saving time). */
const UTC_ZONE = Buffer.alloc(172).toString('base64');

export async function run(state) {
  const c = creds();
  const B_MAIL = state.users.b.email;
  const auth = basic(B_MAIL, c.userB);
  const deviceId = 'E2EPIMDEVICE01';
  let policyKey;
  const post = async (cmd, node) => {
    const r = await http('POST', `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${encodeURIComponent(B_MAIL)}&DeviceId=${deviceId}&DeviceType=iPhone`, {
      raw: true, body: encode(node),
      headers: { Authorization: auth, 'Content-Type': 'application/vnd.ms-sync.wbxml', 'MS-ASProtocolVersion': '14.1', 'User-Agent': 'Apple-iPhone/1', ...(policyKey ? { 'X-MS-PolicyKey': policyKey } : {}) },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200 && buf.length > 0, `${cmd} → HTTP ${r.status} (${buf.length} B)`);
    const newer = tagsNewerThan(buf, '14.1');
    assert(newer.length === 0, `${cmd}: tags newer than 14.1: ${JSON.stringify(newer)}`);
    return decodeWbxml(buf);
  };
  /** One Sync of a collection → { key, status, adds, changes, deletes, responses }. */
  const sync = async (collectionId, key, extra = []) => {
    const tree = await post('Sync', A(0x05, [A(0x1c, [A(0x0f, [A(0x0b, key), A(0x12, collectionId), ...extra])])]));
    const col = kid(kid(tree, 'Collections'), 'Collection');
    const cmds = kid(col, 'Commands');
    const responses = kid(col, 'Responses');
    return {
      key: kid(col, 'SyncKey')?.text, status: kid(col, 'Status')?.text,
      adds: all(cmds, 'Add'), changes: all(cmds, 'Change'), deletes: all(cmds, 'Delete'),
      responses: [...all(responses, 'Add'), ...all(responses, 'Change'), ...all(responses, 'Delete')],
    };
  };
  const tok = await session(state, 'b', B_MAIL, c.userB);
  const keys = {};
  const created = { events: [], notes: [] };

  await check('eas-pim: Provision a 14.1 device', async () => {
    const p1 = await post('Provision', PV(0x05, [PV(0x06, [PV(0x07, [PV(0x08, 'MS-EAS-Provisioning-WBXML')])])]));
    const temp = kid(kid(kid(p1, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert(temp, 'no temporary PolicyKey');
    policyKey = temp;
    const p2 = await post('Provision', PV(0x05, [PV(0x06, [PV(0x07, [PV(0x08, 'MS-EAS-Provisioning-WBXML'), PV(0x09, temp), PV(0x0b, '1')])])]));
    policyKey = kid(kid(kid(p2, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert(policyKey && policyKey !== temp, 'no final PolicyKey');
    return `PolicyKey ${policyKey}`;
  });

  let calendarId, calendarCollection;
  await check('eas-pim: FolderSync announces the default calendar (8), tasks (7) and notes (10)', async () => {
    const fs = await post('FolderSync', [7, 0x16, [[7, 0x12, '0']]]);
    const adds = all(kid(fs, 'Changes'), 'Add').map((a) => ({ id: kid(a, 'ServerId')?.text, type: kid(a, 'Type')?.text, name: kid(a, 'DisplayName')?.text }));
    const byType = (t) => adds.filter((a) => a.type === t);
    assert(byType('8').length === 1 && byType('8')[0].id.startsWith('cal:'), `default calendar: ${JSON.stringify(adds)}`);
    assert(byType('7')[0]?.id === 'tasks:default' && byType('10')[0]?.id === 'notes:default', `tasks/notes: ${JSON.stringify(adds)}`);
    calendarCollection = byType('8')[0].id;
    calendarId = calendarCollection.slice('cal:'.length);
    return adds.filter((a) => a.id.includes(':')).map((a) => `${a.name}/${a.type}`).join(', ');
  });

  await check('eas-pim: an event created over REST arrives in the calendar Sync (ServerId = event id)', async () => {
    const start = new Date(Date.now() + 3 * 864e5);
    const subject = `E2E EAS calendar ${Date.now()}`;
    const ev = await http('POST', '/api/v1/calendar/events', { token: tok, body: {
      calendarId, summary: subject, dtStart: start.toISOString(), dtEnd: new Date(start.getTime() + 36e5).toISOString(), location: 'E2E Raum',
    } });
    assert(ev.status === 201, `create event ${ev.status} ${ev.text.slice(0, 200)}`);
    created.events.push(ev.json.id);
    const primed = await sync(calendarCollection, '0');
    assert(primed.status === '1' && primed.adds.length === 0, `priming ${JSON.stringify(primed)}`);
    const first = await sync(calendarCollection, primed.key, [A(0x17, [B(0x05, [B(0x06, '1'), B(0x07, '20000')])])]);
    const add = first.adds.find((a) => kid(a, 'ServerId')?.text === ev.json.id);
    const data = kid(add, 'ApplicationData');
    assert(add && kid(data, 'Subject')?.text === subject && kid(data, 'Location')?.text === 'E2E Raum' && kid(data, 'StartTime')?.text === compact(start),
      `event not in the Sync: ${first.adds.map((a) => kid(a, 'ServerId')?.text).join(', ')}`);
    keys.calendar = first.key;
    return `${first.adds.length} Add(s), key ${first.key}`;
  });

  let taskId;
  await check('eas-pim: a task added by the device is a task over REST', async () => {
    const primed = await sync('tasks:default', '0');
    const initial = await sync('tasks:default', primed.key);
    const due = new Date(Date.now() + 5 * 864e5);
    const subject = `E2E EAS task ${Date.now()}`;
    const r = await sync('tasks:default', initial.key, [A(0x16, [A(0x07, [A(0x0c, 'e2e-task-1'), A(0x1d, [
      T(0x20, subject), T(0x0e, '2'), T(0x0d, due.toISOString()), T(0x0c, due.toISOString()), T(0x0a, '0'),
      B(0x0a, [B(0x06, '1'), B(0x0b, 'vom Telefon')]),
    ])])])]);
    const resp = r.responses[0];
    taskId = kid(resp, 'ServerId')?.text;
    assert(kid(resp, 'Status')?.text === '1' && taskId, `Add response ${JSON.stringify(resp)}`);
    const t = await http('GET', `/api/v1/tasks/${taskId}`, { token: tok });
    assert(t.status === 200 && t.json.subject === subject && t.json.priority === 'HIGH' && t.json.body === 'vom Telefon'
      && new Date(t.json.dueDate).getTime() === due.getTime(), `REST task ${t.status} ${t.text.slice(0, 200)}`);
    keys.tasks = r.key;
    return `task ${taskId}`;
  });

  await check('eas-pim: a REST change of the task reaches the device as a Change; a device Delete removes it', async () => {
    const put = await http('PUT', `/api/v1/tasks/${taskId}`, { token: tok, body: { subject: 'E2E geändert im Web' } });
    assert(put.status === 200, `PUT task ${put.status}`);
    const r = await sync('tasks:default', keys.tasks);
    const change = r.changes.find((x) => kid(x, 'ServerId')?.text === taskId);
    assert(change && kid(kid(change, 'ApplicationData'), 'Subject')?.text === 'E2E geändert im Web', `Changes: ${r.changes.length}`);
    const d = await sync('tasks:default', r.key, [A(0x16, [A(0x09, [A(0x0d, taskId)])])]);
    assert(d.status === '1', `Delete status ${d.status}`);
    const gone = await http('GET', `/api/v1/tasks/${taskId}`, { token: tok });
    assert(gone.status === 404, `task still there: ${gone.status}`);
    return 'Change received, Delete applied';
  });

  await check('eas-pim: a note added by the device is a note over REST', async () => {
    const primed = await sync('notes:default', '0');
    const initial = await sync('notes:default', primed.key);
    const subject = `E2E EAS note ${Date.now()}`;
    const r = await sync('notes:default', initial.key, [A(0x16, [A(0x07, [A(0x0c, 'e2e-note-1'), A(0x1d, [
      N(0x05, subject), B(0x0a, [B(0x06, '1'), B(0x0b, 'Notiz vom Telefon')]), N(0x06, 'IPM.StickyNote'),
    ])])])]);
    const id = kid(r.responses[0], 'ServerId')?.text;
    assert(id, `Add response ${JSON.stringify(r.responses)}`);
    created.notes.push(id);
    const n = await http('GET', `/api/v1/notes/${id}`, { token: tok });
    assert(n.status === 200 && n.json.subject === subject && n.json.body === 'Notiz vom Telefon', `REST note ${n.status} ${n.text.slice(0, 200)}`);
    return `note ${id}`;
  });

  await check('eas-pim: a recurring meeting with a deleted occurrence added by the device expands without it over REST', async () => {
    const base = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 14, 9, 0, 0));
    const at = (weeks, h = 0) => new Date(base.getTime() + weeks * 7 * 864e5 + h * 36e5);
    const subject = `E2E EAS series ${Date.now()}`;
    const r = await sync(calendarCollection, keys.calendar, [A(0x16, [A(0x07, [A(0x0c, 'e2e-series-1'), A(0x1d, [
      C(0x05, UTC_ZONE), C(0x06, '0'), C(0x26, subject), C(0x27, compact(at(0))), C(0x12, compact(at(0, 1))), C(0x0d, '2'),
      C(0x1b, [C(0x1c, '1'), C(0x1f, '1'), C(0x20, String(1 << base.getUTCDay())), C(0x1e, '4')]),
      C(0x14, [C(0x13, [C(0x15, '1'), C(0x16, compact(at(1)))])]),
    ])])])]);
    const id = kid(r.responses[0], 'ServerId')?.text;
    assert(kid(r.responses[0], 'Status')?.text === '1' && id, `Add response ${JSON.stringify(r.responses)}`);
    created.events.push(id);
    const list = await http('GET', `/api/v1/calendar/events?calendarId=${calendarId}&start=${at(-1).toISOString()}&end=${at(5).toISOString()}`, { token: tok });
    const starts = (list.json ?? []).filter((e) => e.id === id).map((e) => new Date(e.dtStart).toISOString());
    const expected = [at(0), at(2), at(3)].map((d) => d.toISOString());
    assert(JSON.stringify(starts) === JSON.stringify(expected), `instances ${JSON.stringify(starts)} ≠ ${JSON.stringify(expected)}`);
    keys.calendar = r.key;
    return `${starts.length} instances, the second deleted`;
  });

  await check('eas-pim: clean up the items of this step', async () => {
    for (const id of created.events) await http('DELETE', `/api/v1/calendar/events/${id}`, { token: tok });
    for (const id of created.notes) await http('DELETE', `/api/v1/notes/${id}`, { token: tok });
    const r = await sync(calendarCollection, keys.calendar);
    return `${r.deletes.length} calendar Delete(s) sent to the device`;
  });
}
