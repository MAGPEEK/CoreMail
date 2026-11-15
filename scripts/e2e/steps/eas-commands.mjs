// Step 8b: ActiveSync 14.1 commands — OPTIONS command list, Settings (Oof / DeviceInformation /
// UserInformation), Search (Mailbox + GAL), ResolveRecipients, MoveItems, MeetingResponse.
// Requests are encoded like a real client ([page, token] per MS-ASWBXML); responses are
// decoded with the repo decoder. Runs after `eas` (needs the users and the E2E pop3 mail).
import { check, assert, creds, http, basic, session, waitFor } from '../lib.mjs';
import { decodeWbxml } from '../../../packages/activesync/src/wbxml.ts';

const P = { AirSync: 0, FolderHierarchy: 7, Move: 5, MeetingResponse: 8, ResolveRecipients: 10, Provision: 14, Search: 15, Settings: 18 };
/** Node: [page, token, children | text | undefined] */
function encode(root) {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, t, kids]) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(t | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    if (typeof kids === 'string') out.push(0x03, ...Buffer.from(kids, 'utf8'), 0x00); else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}
const S = (t, k) => [P.Settings, t, k];
const Q = (t, k) => [P.Search, t, k];
const R = (t, k) => [P.ResolveRecipients, t, k];
const M = (t, k) => [P.Move, t, k];
const MR = (t, k) => [P.MeetingResponse, t, k];
const kid = (e, name) => e?.children?.find((c) => typeof c !== 'string' && c.name === name);
const all = (e, name) => (e?.children ?? []).filter((c) => typeof c !== 'string' && c.name === name);

export async function run(state) {
  const c = creds();
  const A = state.users.a.email, B = state.users.b.email;
  const auth = basic(B, c.userB);
  const device = 'E2EDEVICE02';
  const qs = (cmd) => `/Microsoft-Server-ActiveSync?Cmd=${cmd}&User=${encodeURIComponent(B)}&DeviceId=${device}&DeviceType=iPhone`;
  let policyKey = '0';
  const post = async (cmd, node) => {
    const r = await http('POST', qs(cmd), {
      raw: true, body: encode(node),
      headers: { Authorization: auth, 'Content-Type': 'application/vnd.ms-sync.wbxml', 'MS-ASProtocolVersion': '14.1', 'X-MS-PolicyKey': policyKey, 'User-Agent': 'Apple-iPhone/1' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.status === 200, `${cmd} → HTTP ${r.status} ${buf.toString('utf8').slice(0, 120)}`);
    assert(buf.length > 0, `${cmd} → empty 200 (stub)`);
    return decodeWbxml(buf);
  };

  await check('eas-cmd: OPTIONS advertises the implemented 14.1 commands only', async () => {
    const o = await http('OPTIONS', '/Microsoft-Server-ActiveSync', { headers: { Authorization: auth } });
    const cmds = (o.headers.get('ms-asprotocolcommands') ?? '').split(',');
    for (const x of ['Settings', 'Search', 'MoveItems', 'MeetingResponse', 'ResolveRecipients']) assert(cmds.includes(x), `${x} missing in ${cmds}`);
    for (const x of ['GetHierarchy', 'CreateCollection', 'FolderCreate', 'ValidateCert', 'Find', 'Notify']) assert(!cmds.includes(x), `${x} advertised but not implemented`);
    return cmds.join(',');
  });

  await check('eas-cmd: Provision for the second device', async () => {
    const p1 = await post('Provision', [P.Provision, 0x05, [[P.Provision, 0x06, [[P.Provision, 0x07, [[P.Provision, 0x08, 'MS-EAS-Provisioning-WBXML']]]]]]]);
    const key = kid(kid(kid(p1, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert(key, 'no PolicyKey');
    policyKey = key;
    const p2 = await post('Provision', [P.Provision, 0x05, [[P.Provision, 0x06, [[P.Provision, 0x07, [[P.Provision, 0x08, 'MS-EAS-Provisioning-WBXML'], [P.Provision, 0x09, key], [P.Provision, 0x0b, '1']]]]]]]);
    policyKey = kid(kid(kid(p2, 'Policies'), 'Policy'), 'PolicyKey')?.text ?? key;
    return `PolicyKey ${policyKey}`;
  });

  await check('eas-cmd: Settings DeviceInformation Set + UserInformation Get', async () => {
    const res = await post('Settings', S(0x05, [
      S(0x16, [S(0x08, [S(0x17, 'iPhone15,2'), S(0x19, 'E2E iPhone'), S(0x1a, 'iOS 18.1'), S(0x20, 'Apple-iPhone/2201')])]),
      S(0x1d, [S(0x07)]),
    ]));
    assert(kid(res, 'Status')?.text === '1', JSON.stringify(res).slice(0, 300));
    assert(kid(kid(res, 'DeviceInformation'), 'Status')?.text === '1', 'DeviceInformation status');
    const addrs = kid(kid(kid(kid(kid(res, 'UserInformation'), 'Get'), 'Accounts'), 'Account'), 'EmailAddresses');
    const primary = kid(addrs, 'PrimarySmtpAddress')?.text;
    assert(primary === B.toLowerCase(), `PrimarySmtpAddress ${primary}`);
    return `primary ${primary}, ${all(addrs, 'SmtpAddress').length} alias(es)`;
  });

  await check('eas-cmd: Settings Oof Set/Get round trip with the MWA out-of-office settings', async () => {
    const tok = await session(state, 'b', B, c.userB);
    const set = await post('Settings', S(0x05, [S(0x09, [S(0x08, [
      S(0x0a, '1'),
      S(0x0d, [S(0x0e), S(0x11, '1'), S(0x12, 'E2E EAS away (internal)'), S(0x13, 'Text')]),
      S(0x0d, [S(0x0f), S(0x11, '1'), S(0x12, 'E2E EAS away'), S(0x13, 'Text')]),
      S(0x0d, [S(0x10), S(0x11, '1'), S(0x12, 'E2E EAS away'), S(0x13, 'Text')]),
    ])])]));
    assert(kid(kid(set, 'Oof'), 'Status')?.text === '1', `Oof Set ${JSON.stringify(set).slice(0, 200)}`);
    const mwa = await http('GET', '/api/v1/user/oof', { token: tok });
    assert(mwa.json?.enabled === true && mwa.json?.internalMessage === 'E2E EAS away (internal)' && mwa.json?.externalMessage === 'E2E EAS away',
      `MWA oof ${mwa.status} ${mwa.text.slice(0, 200)}`);
    // MWA change → visible to the device
    const put = await http('PUT', '/api/v1/user/oof', { token: tok, body: { ...mwa.json, internalMessage: 'changed in MWA', startDate: undefined, endDate: undefined } });
    assert(put.status === 200, `PUT oof ${put.status}`);
    const get = await post('Settings', S(0x05, [S(0x09, [S(0x07, [S(0x13, 'Text')])])]));
    const g = kid(kid(get, 'Oof'), 'Get');
    const internal = all(g, 'OofMessage').find((m) => kid(m, 'AppliesToInternal'));
    assert(kid(g, 'OofState')?.text === '1' && kid(internal, 'ReplyMessage')?.text === 'changed in MWA', `Oof Get ${JSON.stringify(g).slice(0, 300)}`);
    // switch it off again so later steps are not answered by auto-replies
    const off = await post('Settings', S(0x05, [S(0x09, [S(0x08, [S(0x0a, '0')])])]));
    assert(kid(kid(off, 'Oof'), 'Status')?.text === '1', 'Oof off');
    const after = await http('GET', '/api/v1/user/oof', { token: tok });
    assert(after.json?.enabled === false, 'MWA still enabled after Oof state 0');
    return 'Set → MWA, MWA → Get, disabled again';
  });

  let inboxId, archiveId;
  await check('eas-cmd: FolderSync (folder ids for Search/MoveItems)', async () => {
    const fs = await post('FolderSync', [P.FolderHierarchy, 0x16, [[P.FolderHierarchy, 0x12, '0']]]);
    const adds = all(kid(fs, 'Changes'), 'Add');
    const byType = (t) => adds.find((a) => kid(a, 'Type')?.text === t);
    inboxId = kid(byType('2'), 'ServerId')?.text;
    archiveId = kid(adds.find((a) => kid(a, 'DisplayName')?.text === 'Archive') ?? byType('4'), 'ServerId')?.text;
    assert(inboxId && archiveId, `inbox ${inboxId} archive ${archiveId}`);
    return `inbox ${inboxId}, target ${archiveId}`;
  });

  let foundId;
  await check('eas-cmd: Search Store=Mailbox (FreeText in the Inbox)', async () => {
    const res = await post('Search', Q(0x05, [Q(0x07, [
      Q(0x08, 'Mailbox'),
      Q(0x09, [Q(0x13, [[P.AirSync, 0x12, inboxId], Q(0x15, 'E2E')])]),
      Q(0x0a, [Q(0x0b, '0-9'), [17, 0x05, [[17, 0x06, '1'], [17, 0x07, '200']]]]),
    ])]));
    const store = kid(kid(res, 'Response'), 'Store');
    assert(kid(store, 'Status')?.text === '1', `store status ${kid(store, 'Status')?.text}`);
    const results = all(store, 'Result').filter((r) => kid(r, 'LongId'));
    assert(results.length > 0, `no results: ${JSON.stringify(store).slice(0, 300)}`);
    foundId = kid(results[0], 'LongId').text;
    return `${results.length} result(s), total ${kid(store, 'Total')?.text}`;
  });

  await check('eas-cmd: Search Store=GAL finds a user of the own domain', async () => {
    const local = A.split('@')[0];
    const res = await post('Search', Q(0x05, [Q(0x07, [Q(0x08, 'GAL'), Q(0x09, local), Q(0x0a, [Q(0x0b, '0-19')])])]));
    const store = kid(kid(res, 'Response'), 'Store');
    const emails = all(store, 'Result').map((r) => kid(kid(r, 'Properties'), 'EmailAddress')?.text);
    assert(emails.includes(A.toLowerCase()), `GAL ${emails.join(', ')}`);
    return emails.join(', ');
  });

  await check('eas-cmd: ResolveRecipients resolves a GAL address', async () => {
    const res = await post('ResolveRecipients', R(0x05, [R(0x10, A), R(0x10, 'nobody-e2e@nowhere.invalid')]));
    const [r1, r2] = all(res, 'Response');
    const rc = kid(r1, 'Recipient');
    assert(kid(r1, 'Status')?.text === '1' && kid(rc, 'Type')?.text === '1' && kid(rc, 'EmailAddress')?.text === A.toLowerCase(), JSON.stringify(r1).slice(0, 300));
    assert(kid(r2, 'Status')?.text === '4', `unknown → ${kid(r2, 'Status')?.text}`);
    return `${kid(rc, 'DisplayName')?.text} <${kid(rc, 'EmailAddress')?.text}>`;
  });

  await check('eas-cmd: MoveItems moves to another folder and back (Status 3)', async () => {
    const mv = async (from, to) => {
      const res = await post('MoveItems', M(0x05, [M(0x06, [M(0x07, foundId), M(0x08, from), M(0x09, to)])]));
      const r = kid(res, 'Response');
      assert(kid(r, 'Status')?.text === '3', `move ${from}→${to}: ${JSON.stringify(r)}`);
      return kid(r, 'DstMsgId')?.text;
    };
    const dst = await mv(inboxId, archiveId);
    const back = await mv(archiveId, inboxId);
    const foreign = await post('MoveItems', M(0x05, [M(0x06, [M(0x07, foundId), M(0x08, inboxId), M(0x09, 'not-my-folder')])]));
    assert(kid(kid(foreign, 'Response'), 'Status')?.text === '2', 'foreign destination accepted');
    return `DstMsgId ${dst} / ${back}`;
  });

  await check('eas-cmd: MeetingResponse accepts an invitation (calendar); at 14.1 the device sends the REPLY — exactly one reaches the organizer', async () => {
    const tokA = await session(state, 'a', A, c.userA);
    const tokB = await session(state, 'b', B, c.userB);
    const cals = await http('GET', '/api/v1/calendar', { token: tokA });
    const calId = (Array.isArray(cals.json) ? cals.json : []).find((x) => !x.shared)?.id;
    assert(calId, `no calendar for A: ${cals.status}`);
    const subject = `E2E EAS meeting ${Date.now()}`;
    const start = new Date(Date.now() + 7 * 864e5);
    const ev = await http('POST', '/api/v1/calendar/events', { token: tokA, body: {
      calendarId: calId, summary: subject, dtStart: start.toISOString(), dtEnd: new Date(start.getTime() + 36e5).toISOString(),
      attendees: [{ email: B }],
    } });
    assert(ev.status === 201, `create event ${ev.status} ${ev.text.slice(0, 200)}`);
    const invite = await waitFor(async () => {
      const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent(subject)}`, { token: tokB });
      return (q.json?.messages ?? q.json ?? []).find((m) => (m.folderId ?? inboxId) === inboxId) ?? null;
    }, { what: 'invitation in B inbox', timeout: 30000 });
    const res = await post('MeetingResponse', MR(0x07, [MR(0x09, [MR(0x0c, '1'), MR(0x06, inboxId), MR(0x08, invite.id)])]));
    const result = kid(res, 'Result');
    assert(kid(result, 'Status')?.text === '1' && kid(result, 'CalendarId')?.text, `MeetingResponse ${JSON.stringify(result)}`);
    // [MS-ASCMD] before EAS 16.0 the device sends the iTIP REPLY itself (SendMail) after the
    // MeetingResponse — the server must not send a second one.
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CoreMail E2E//EAS device//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
      `UID:${ev.json.uid}`, `SEQUENCE:${ev.json.sequence ?? 0}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
      `ORGANIZER:mailto:${A}`, `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${B}`, 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const mime = [
      `From: ${B}`, `To: ${A}`, `Subject: Accepted: ${subject}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <e2e-reply-${Date.now()}@e2e.test>`, 'MIME-Version: 1.0', 'Content-Type: text/calendar; method=REPLY; charset=UTF-8', '', ics,
    ].join('\r\n');
    const CM = (t, k) => [21, t, k];
    const sent = await post('SendMail', CM(0x05, [CM(0x11, `e2e-mr-${Date.now()}`), CM(0x08), CM(0x10, mime)]));
    assert(kid(sent, 'Status')?.text === '1', `SendMail REPLY ${JSON.stringify(sent)}`);
    // the REPLY reaches the organizer and updates the attendee status
    await waitFor(async () => {
      const e = await http('GET', `/api/v1/calendar/events/${ev.json.id}`, { token: tokA });
      return (e.json?.attendees ?? []).some((a) => a.email?.toLowerCase() === B.toLowerCase() && a.partstat === 'ACCEPTED');
    }, { what: 'organizer sees ACCEPTED', timeout: 30000 });
    // give a (wrong) server-side duplicate time to arrive, then count the replies
    await new Promise((r) => setTimeout(r, 5000));
    const q = await http('GET', `/api/v1/mail/search?q=${encodeURIComponent(subject)}`, { token: tokA });
    const replies = (q.json?.messages ?? q.json ?? []).filter((m) => /^Accepted:/i.test(m.subject ?? '') && (m.subject ?? '').includes(subject));
    assert(replies.length === 1, `organizer received ${replies.length} replies (expected exactly the device's one)`);
    return `CalendarId ${kid(result, 'CalendarId').text}; organizer sees ACCEPTED; 1 reply`;
  });
}
