// Step: MAPI over HTTP (classic Outlook, docs/mapi.md). The MAPI switch is off by
// default (Autodiscover announces no mapiHttp block); the admin turns it on for
// A and Autodiscover announces the mailbox and address book URLs. B sends A a
// mail (SMTP submission); A connects over MAPI (Connect → Execute Logon → Inbox
// → contents table) and sees it, opens it and reads the body through a stream,
// then composes a message in the Outbox and submits it to B (checked over IMAP).
// Cached mode (ICS): an initial contents synchronization of the Inbox carries the
// mail and ends with an ICS state; after a new mail and a read change the
// incremental synchronization with that state sends exactly those (a message
// change + IncrSyncRead), a third one nothing; a hierarchy synchronization lists
// the folder tree.
// The address book (Bind, GetSpecialTable, QueryRows, ResolveNames) lists and
// resolves B; a NotificationWait wakes within 3 s of a new mail and the next
// Execute carries RopNotify NewMail. With the switch off again, a running MAPI
// session is refused (403), a new Connect as well, and Autodiscover drops the
// mapiHttp block. (The e2e stack sets MAPI_HTTPS_TRUSTED: its test runner talks
// plain HTTP, so no CA certificate is served.)
import {
  check, assert, basic, creds, http, session, waitFor, BASE, PORTS, buildMime, smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend,
  imapCmd, imapQuote,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import {
  MapiHttpClient, rop, decodeLogon, decodeQueryRows, decodeOpenMessage, responseHead, TAG, HANDLE_UNUSED,
  nspiBody, nspiDecode, parseExecuteResponse, readNotifications, ropOutput,
  ICS, decodeGetBuffer, decodeIcsStream, decodeHierarchyStream, globcntOfId,
} from '../../../packages/mapi-server/src/testing/mapi-client.ts';

const SMTP_ADDRESS = 0x39fe001f;

/** Autodiscover v1 (Outlook schema) as classic Outlook asks for it (X-MapiHttpCapability). */
async function autodiscover(email, password) {
  const body = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${email}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
  const r = await http('POST', '/autodiscover/autodiscover.xml', {
    body, headers: { 'Content-Type': 'text/xml', 'X-MapiHttpCapability': '1', 'X-AnchorMailbox': email, Authorization: basic(email, password) },
  });
  assert(r.status === 200, `Autodiscover ${r.status}`);
  return r.text;
}

/** Sends B → A over SMTP submission; resolves when the server accepted it. */
async function sendBtoA(B, passB, A, subject, text) {
  const s = await smtpOpen(PORTS.submission);
  try {
    await smtpStartTls(s);
    const auth = await smtpAuthPlain(s, B, passB);
    assert(auth.code === 235, `AUTH ${auth.text}`);
    const r = await smtpSend(s, B, [A], buildMime({ from: `Bob E2E <${B}>`, to: A, subject, text }));
    assert(r.code === 250, `${r.stage}: ${r.text}`);
    return r.text.split('\n').at(-1);
  } finally { s.close(); }
}

const LEGACY_DN = '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=';
const U = HANDLE_UNUSED;

async function setMapi(token, userId, value) {
  const r = await http('PUT', `/api/v1/admin/protocol-access/users/${userId}`, { token, body: { mapi: value } });
  assert(r.status === 200, `protocol-access ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.effective.mapi;
}

/** Logon + Inbox contents with Mid/Subject columns; returns { folderIds, handles, rows }. */
async function inboxRows(client) {
  const logon = await client.execute([rop.logon(0)], [U]);
  assert(logon.responseCode === 0 && logon.errorCode === 0, `Logon: X-ResponseCode ${logon.responseCode}, ErrorCode ${logon.errorCode}`);
  const l = decodeLogon(logon.rop.responses);
  assert(l.returnValue === 0, `RopLogon 0x${l.returnValue.toString(16)}`);
  const cols = [TAG.Mid, TAG.Subject];
  const r = await client.execute([
    rop.openFolder(0, 1, l.folderIds[4]), rop.getContentsTable(1, 2), rop.setColumns(2, cols), rop.queryRows(2, 200),
  ], [logon.rop.handles[0], U, U]);
  const resp = r.rop.responses;
  for (const [what, skip] of [['OpenFolder', 2], ['GetContentsTable', 4], ['SetColumns', 1]]) {
    const head = responseHead(resp);
    assert(head.returnValue === 0, `${what} 0x${head.returnValue.toString(16)}`);
    resp.bytes(skip);
  }
  return { folderIds: l.folderIds, handles: r.rop.handles, rows: decodeQueryRows(resp, cols).rows };
}

/**
 * Cached mode (MS-OXCFXICS): Logon → OpenFolder → RopSynchronizationConfigure →
 * upload the ICS state → RopFastTransferSourceGetBuffer until Done. Returns the
 * decoded stream (its `state` is the next round's initial state).
 */
async function icsDownload(client, folderIndex, type, state = new Map()) {
  const logon = await client.execute([rop.logon(0)], [U]);
  const l = decodeLogon(logon.rop.responses);
  assert(l.returnValue === 0, `RopLogon 0x${l.returnValue.toString(16)}`);
  const flags = type === ICS.SyncContents ? ICS.FlagUnicode | ICS.FlagNormal | ICS.FlagReadState : ICS.FlagUnicode;
  const rops = [rop.openFolder(0, 1, l.folderIds[folderIndex]), rop.syncConfigure(1, 2, type, flags, ICS.ExtraEid)];
  for (const [tag, value] of state) rops.push(rop.uploadStateBegin(2, tag, value.length), rop.uploadStateContinue(2, value), rop.uploadStateEnd(2));
  const configured = await client.execute(rops, [logon.rop.handles[0], U, U]);
  const resp = configured.rop.responses;
  assert(responseHead(resp).returnValue === 0, 'OpenFolder');
  resp.bytes(2);
  for (let i = 1; i < rops.length; i++) {
    const head = responseHead(resp);
    assert(head.returnValue === 0, `ROP 0x${head.ropId.toString(16)} → 0x${head.returnValue.toString(16)}`);
  }
  let handles = configured.rop.handles;
  const parts = [];
  for (let calls = 0; calls < 5000; calls++) {
    const g = await client.execute([rop.getBuffer(2, 0x4000)], handles);
    handles = g.rop.handles;
    const chunk = decodeGetBuffer(g.rop.responses);
    assert(chunk.returnValue === 0, `GetBuffer 0x${chunk.returnValue.toString(16)}`);
    parts.push(chunk.data);
    if (chunk.status === 0x0003) return { ...decodeIcsStream(Buffer.concat(parts)), stream: Buffer.concat(parts), calls: calls + 1 };
  }
  throw new Error('GetBuffer never reported Done');
}

export async function run(state) {
  const c = creds();
  const A = state.users.a.email;
  const B = state.users.b.email;
  const passA = state.mfaA ? state.appPwA : c.userA;
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const subject = `E2E mapi inbound ${Date.now()}`;

  await check('mapi: MAPI is off by default — Connect with the correct password → 403, no password prompt', async () => {
    const r = await new MapiHttpClient(BASE, A, passA).connect(LEGACY_DN + state.users.a.id);
    assert(r.status === 403 && !r.headers.get('www-authenticate'), `${r.status} ${r.text.slice(0, 120)}`);
    return `403 ${r.text.slice(0, 60)}`;
  });

  await check('mapi: envelope — GET answers X-ResponseCode 2, no credentials → 401 Basic challenge', async () => {
    const get = await http('GET', '/mapi/emsmdb/', { raw: true });
    const anon = new MapiHttpClient(BASE, A, passA);
    anon.authorization = '';
    const r = await anon.connect('');
    assert(get.headers.get('x-responsecode') === '2', `GET → ${get.status} code ${get.headers.get('x-responsecode')}`);
    assert(r.status === 401 && /^Basic /.test(r.headers.get('www-authenticate') ?? ''), `anonymous → ${r.status}`);
    return 'GET code 2, anonymous 401';
  });

  await check('mapi: auth — a Negotiate / NTLM header gets the Basic challenge only (no NTLM offered)', async () => {
    const nego = new MapiHttpClient(BASE, A, passA);
    nego.authorization = 'NTLM TlRMTVNTUAABAAAAB4IIog==';
    const r = await nego.request('nspi', 'PING', Buffer.alloc(0));
    const challenge = r.headers.get('www-authenticate') ?? '';
    assert(r.status === 401 && /^Basic /.test(challenge) && !/NTLM|Negotiate/i.test(challenge), `${r.status} ${challenge}`);
    return challenge;
  });

  await check('mapi: Autodiscover while the switch is off → no mapiHttp block', async () => {
    const xml = await autodiscover(A, passA);
    assert(!/mapiHttp/.test(xml), 'mapiHttp announced although MAPI is off');
    return 'IMAP/SMTP only';
  });

  try {
    await check('mapi: switch on for A (user level)', async () => {
      assert(await setMapi(admin, state.users.a.id, 'on') === true, 'mapi not effective');
      return 'effective on';
    });

    await check('mapi: Autodiscover announces mapiHttp (MailStore + AddressBook), never EXCH/EXPR', async () => {
      const xml = await waitFor(async () => {
        const x = await autodiscover(A, passA);
        return /<Protocol Type="mapiHttp" Version="1">/.test(x) ? x : null;
      }, { timeout: 45_000, interval: 2000, what: 'the mapiHttp block (protocol switch caches)' });
      assert(/<MailStore>\s*<InternalUrl>https:\/\/[^<]+\/mapi\/emsmdb\/<\/InternalUrl>/.test(xml), 'MailStore URL');
      assert(/<AddressBook>\s*<InternalUrl>https:\/\/[^<]+\/mapi\/nspi\/<\/InternalUrl>/.test(xml), 'AddressBook URL');
      assert(xml.includes(`<LegacyDN>${LEGACY_DN}${state.users.a.id}</LegacyDN>`), 'LegacyDN of the account');
      assert(!/<Type>(EXCH|EXPR)<\/Type>/.test(xml), 'no RPC blocks');
      return 'mapiHttp version 1';
    });

    await check('mapi: B → A mail over SMTP submission', () => sendBtoA(B, c.userB, A, subject, 'Body read over MAPI.'));

    const client = new MapiHttpClient(BASE, A, passA);
    let found;
    await check('mapi: Connect → session cookies, PROCESSING/DONE framing, Connect body', async () => {
      const r = await client.connect(LEGACY_DN + state.users.a.id);
      assert(r.status === 200 && r.responseCode === 0, `${r.status} code ${r.responseCode} ${r.text.slice(0, 120)}`);
      assert(r.mapi.metaTags.at(-1) === 'DONE' && client.cookies.has('MapiContext') && client.cookies.has('MapiSequence'), 'framing / cookies');
      assert(r.mapi.body.readUInt32LE(4) === 0, `Connect ErrorCode 0x${r.mapi.body.readUInt32LE(4).toString(16)}`);
      return `meta ${r.mapi.metaTags.join(',')}; X-ServerApplication ${r.headers.get('x-serverapplication')}`;
    });

    await check('mapi: Logon → Inbox → GetContentsTable/QueryRows sees the e2e mail', async () => {
      found = await waitFor(async () => {
        const t = await inboxRows(client);
        const row = t.rows.find((x) => x[1] === subject);
        return row ? { ...t, mid: row[0] } : null;
      }, { timeout: 30_000, interval: 1000, what: 'the B → A mail in the MAPI contents table' });
      return `mid 0x${found.mid.toString(16)} among ${found.rows.length} rows`;
    });

    await check('mapi: OpenMessage + OpenStream/ReadStream returns the body', async () => {
      const r = await client.execute([
        rop.openFolder(0, 1, found.folderIds[4]), rop.openMessage(1, 3, found.folderIds[4], found.mid),
        rop.openStream(3, 4, TAG.Body), rop.readStream(4, 4096),
      ], [found.handles[0], U, U, U, U]);
      const resp = r.rop.responses;
      assert(responseHead(resp).returnValue === 0, 'OpenFolder');
      resp.bytes(2);
      const opened = decodeOpenMessage(resp);
      assert(opened.returnValue === 0 && opened.subject === subject, `OpenMessage 0x${opened.returnValue.toString(16)} ${opened.subject}`);
      assert(responseHead(resp).returnValue === 0, 'OpenStream');
      const size = resp.u32();
      assert(responseHead(resp).returnValue === 0, 'ReadStream');
      const body = resp.bytes(resp.u16()).toString('utf16le');
      assert(body.includes('Body read over MAPI.'), `body ${JSON.stringify(body.slice(0, 80))}`);
      return `stream ${size} bytes`;
    });

    let icsState;
    await check('mapi: cached mode — ICS initial sync of the Inbox carries the e2e mail and ends with an ICS state', async () => {
      const first = await icsDownload(client, 4, ICS.SyncContents);
      assert(first.ended, 'IncrSyncEnd');
      const hit = first.messages.find((m) => m.props.get(TAG.Subject) === subject);
      assert(hit, `the e2e mail among ${first.messages.length} message changes`);
      assert(hit.header.get(TAG.Mid) === found.mid, 'PidTagMid in the change header = the MID of the contents table');
      assert(first.state.has(ICS.IdsetGiven) && first.state.has(ICS.CnsetSeen), 'final state');
      icsState = first.state;
      return `${first.messages.length} messages in ${first.calls} buffer(s), state ${[...first.state.values()].reduce((n, b) => n + b.length, 0)} bytes`;
    });

    await check('mapi: cached mode — incremental sync after a new mail and a read change sends just those', async () => {
      const nextSubject = `E2E mapi ics ${Date.now()}`;
      await sendBtoA(B, c.userB, A, nextSubject, 'Arrives through ICS.');
      const fresh = await waitFor(async () => {
        const t = await inboxRows(client);
        return t.rows.some((x) => x[1] === nextSubject) ? t : null;
      }, { timeout: 30_000, interval: 1000, what: 'the new mail' });
      // mark the first mail read online (RopSetMessageReadFlag) — the delta carries it as IncrSyncRead
      const marked = await client.execute([
        rop.openFolder(0, 1, fresh.folderIds[4]), rop.openMessage(1, 3, fresh.folderIds[4], found.mid), rop.setMessageReadFlag(3, 3, true),
      ], [fresh.handles[0], U, U, U]);
      const resp = marked.rop.responses;
      assert(responseHead(resp).returnValue === 0, 'OpenFolder');
      resp.bytes(2);
      assert(decodeOpenMessage(resp).returnValue === 0, 'OpenMessage');
      assert(responseHead(resp).returnValue === 0, 'SetMessageReadFlag');
      const delta = await icsDownload(client, 4, ICS.SyncContents, icsState);
      assert(delta.ended, 'IncrSyncEnd');
      const subjects = delta.messages.map((m) => m.props.get(TAG.Subject));
      assert(subjects.length === 1 && subjects[0] === nextSubject, `only the new mail as a change: ${JSON.stringify(subjects)}`);
      assert(delta.read.includes(globcntOfId(found.mid)), `IncrSyncRead names the read mail: ${delta.read.join(',')}`);
      const again = await icsDownload(client, 4, ICS.SyncContents, delta.state);
      assert(again.messages.length === 0 && again.read.length === 0 && again.deleted.length === 0, 'nothing left after the delta');
      return `delta: ${subjects.length} change(s), ${delta.read.length} read change(s)`;
    });

    await check('mapi: cached mode — a malformed ICS state upload is refused with RpcFormat (no session failure)', async () => {
      const logon = await client.execute([rop.logon(0)], [U]);
      const l = decodeLogon(logon.rop.responses);
      assert(l.returnValue === 0, `RopLogon 0x${l.returnValue.toString(16)}`);
      const bad = Buffer.concat([Buffer.alloc(16, 1), Buffer.from([0x99])]); // REPLGUID + an unknown GLOBSET command
      const r = await client.execute([
        rop.openFolder(0, 1, l.folderIds[4]), rop.syncConfigure(1, 2, ICS.SyncContents, ICS.FlagUnicode | ICS.FlagNormal, 0),
        rop.uploadStateBegin(2, ICS.CnsetSeen, bad.length), rop.uploadStateContinue(2, bad), rop.uploadStateEnd(2),
      ], [logon.rop.handles[0], U, U]);
      const resp = r.rop.responses;
      assert(responseHead(resp).returnValue === 0, 'OpenFolder');
      resp.bytes(2);
      for (const what of ['SynchronizationConfigure', 'UploadStateStreamBegin', 'UploadStateStreamContinue']) {
        assert(responseHead(resp).returnValue === 0, what);
      }
      const end = responseHead(resp).returnValue;
      assert(end === 0x4b6, `UploadStateStreamEnd → 0x${end.toString(16)} (expected RpcFormat 0x4b6)`);
      return 'RpcFormat';
    });

    await check('mapi: cached mode — hierarchy sync lists the folder tree below Top of Information Store', async () => {
      const tree = decodeHierarchyStream((await icsDownload(client, 3, ICS.SyncHierarchy)).stream);
      const names = tree.map((f) => f.get(TAG.DisplayName));
      assert(['INBOX', 'Sent', 'Outbox'].every((n) => names.includes(n)), `folders ${JSON.stringify(names)}`);
      // the synchronizations logged on again: fresh handles for the checks below
      found = { ...(await inboxRows(client)), mid: found.mid };
      return `${tree.length} folders`;
    });

    const outSubject = `E2E mapi submit ${Date.now()}`;
    await check('mapi: CreateMessage (Outbox) + SetProperties + ModifyRecipients + SubmitMessage', async () => {
      const outbox = found.folderIds[5];
      const r = await client.execute([
        rop.openFolder(0, 1, outbox), rop.createMessage(1, 2, outbox),
        rop.setProperties(2, [{ tag: TAG.Subject, value: outSubject }, { tag: TAG.Body, value: 'Sent over MAPI.' }]),
        rop.modifyRecipients(2, [{ rowId: 0, type: 1, email: B, name: 'Bob E2E' }]),
        rop.submitMessage(2),
      ], [found.handles[0], U, U]);
      const resp = r.rop.responses;
      const codes = [];
      for (const skip of [2, 1, 2, 0, 0]) { codes.push(responseHead(resp).returnValue); resp.bytes(skip); }
      assert(codes.every((x) => x === 0), `return values ${codes.map((x) => x.toString(16)).join(',')}`);
      return 'submitted';
    });

    await check('mapi: the submitted message reaches B (IMAP)', async () => {
      const imap = await imapLogin(B, c.userB);
      try {
        assert(imap.loginResult.status === 'OK', imap.loginResult.text);
        const hit = await waitFor(async () => {
          await imapCmd(imap, 'SELECT INBOX');
          const s = await imapCmd(imap, `UID SEARCH SUBJECT ${imapQuote(outSubject)}`);
          return s.lines.find((l) => /^\* SEARCH \d/.test(l));
        }, { timeout: 30_000, interval: 1000, what: 'the MAPI message in B\'s Inbox' });
        return hit;
      } finally { imap.close(); }
    });

    const book = new MapiHttpClient(BASE, A, passA);
    await check('mapi: address book — Bind, GetSpecialTable, QueryRows lists A and B', async () => {
      const bind = await book.request('nspi', 'Bind', nspiBody.bind());
      assert(bind.status === 200 && bind.responseCode === 0, `Bind ${bind.status} code ${bind.responseCode}`);
      assert(nspiDecode.bind(bind.mapi.body).errorCode === 0 && book.cookies.has('NspiContext'), 'Bind ErrorCode / cookie');
      const special = await book.request('nspi', 'GetSpecialTable', nspiBody.getSpecialTable());
      assert(special.responseCode === 0 && special.mapi.body.readUInt32LE(4) === 0, 'GetSpecialTable');
      const rows = [];
      let stat = {};
      for (let page = 0; page < 20; page++) {
        const r = nspiDecode.table((await book.request('nspi', 'QueryRows', nspiBody.queryRows(stat, 200, [TAG.DisplayName, SMTP_ADDRESS]))).mapi.body);
        assert(r.errorCode === 0, `QueryRows 0x${r.errorCode.toString(16)}`);
        rows.push(...(r.rowSet?.rows ?? []));
        stat = r.stat;
        if (stat.currentRec === 2 || (r.rowSet?.rows.length ?? 0) === 0) break;
      }
      const emails = rows.map((row) => row[1]);
      assert(emails.includes(A.toLowerCase()) && emails.includes(B.toLowerCase()), `A/B missing among ${emails.length} rows`);
      return `${rows.length} entries, TotalRecs ${stat.totalRecs}`;
    });

    await check('mapi: address book — ResolveNames finds B by address, an unknown name stays unresolved', async () => {
      const r = nspiDecode.resolveNames((await book.request('nspi', 'ResolveNames', nspiBody.resolveNames([B, `nobody-${Date.now()}@nowhere.invalid`], [SMTP_ADDRESS]))).mapi.body);
      assert(r.errorCode === 0, `ResolveNames 0x${r.errorCode.toString(16)}`);
      assert(r.mids[0] >= 0x10 && r.mids[1] === 0, `MIDs ${r.mids.join(',')}`);
      assert(r.rowSet.rows[0][0] === B.toLowerCase(), `row ${JSON.stringify(r.rowSet.rows[0])}`);
      const dn = nspiDecode.dnToMId((await book.request('nspi', 'DNToMId', nspiBody.dnToMId([LEGACY_DN + state.users.a.id]))).mapi.body);
      assert(dn.mids[0] >= 0x10, 'own legacy DN → MID');
      // Result bound: more than 1000 names in one ResolveNames → TableTooBig (0x80040403), no work done.
      const flood = nspiDecode.resolveNames((await book.request('nspi', 'ResolveNames', nspiBody.resolveNames(Array.from({ length: 1001 }, () => 'x'), [SMTP_ADDRESS]))).mapi.body);
      assert(flood.errorCode === 0x80040403, `ResolveNames with 1001 names 0x${flood.errorCode.toString(16)}`);
      const unbind = await book.request('nspi', 'Unbind', nspiBody.unbind());
      assert(unbind.responseCode === 0 && !book.cookies.has('NspiContext'), 'Unbind');
      return `B → MID 0x${r.mids[0].toString(16)}`;
    });

    await check('mapi: NotificationWait wakes within 3 s of a new mail; the next Execute carries RopNotify NewMail', async () => {
      const logon = await client.execute([rop.logon(0)], [U]);
      const reg = await client.execute([rop.registerNotification(0, 1, 0x0002)], [logon.rop.handles[0], U]);
      assert(reg.responseCode === 0 && responseHead(reg.rop.responses).returnValue === 0, 'RegisterNotification');
      const waiting = client.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
      await new Promise((r) => setTimeout(r, 500));
      await sendBtoA(B, c.userB, A, `E2E mapi notify ${Date.now()}`, 'Wakes the NotificationWait.');
      const accepted = Date.now();
      const woke = await waiting;
      const elapsed = Date.now() - accepted;
      assert(woke.responseCode === 0 && woke.mapi.body.readUInt32LE(8) === 1, `EventPending ${woke.mapi?.body.readUInt32LE(8)}`);
      assert(elapsed < 3000, `woken after ${elapsed} ms`);
      const events = await client.request('emsmdb', 'Execute', Buffer.alloc(0));
      const exec = parseExecuteResponse(events.mapi.body);
      const { notifications } = readNotifications(ropOutput(exec.ropBuffer).responses);
      assert(notifications.some((x) => (x.flags & 0x0fff) === 0x0002 && x.handle === reg.rop.handles[1]), 'RopNotify NewMail on the subscription');
      return `woken after ${elapsed} ms, ${notifications.length} notification(s)`;
    });

    await check('mapi: switch off → the running session is refused (403) and a new Connect too', async () => {
      assert(await setMapi(admin, state.users.a.id, 'off') === false, 'mapi still effective');
      const r = await client.execute([rop.logon(0)], [U]);
      assert(r.status === 403, `Execute after switch-off → ${r.status} code ${r.responseCode}`);
      const again = await new MapiHttpClient(BASE, A, passA).connect(LEGACY_DN + state.users.a.id);
      assert(again.status === 403, `Connect → ${again.status}`);
      return 'Execute 403, Connect 403';
    });

    await check('mapi: switch off → Autodiscover drops the mapiHttp block', async () => {
      await waitFor(async () => !/mapiHttp/.test(await autodiscover(A, passA)), { timeout: 45_000, interval: 2000, what: 'mapiHttp gone' });
      return 'IMAP/SMTP only';
    });
  } finally {
    await setMapi(admin, state.users.a.id, 'inherit').catch(() => undefined);
  }
}
