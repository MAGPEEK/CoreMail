// Step: MAPI over HTTP (classic Outlook, docs/mapi.md). The MAPI switch is off by
// default; the admin turns it on for A. B sends A a mail (SMTP submission); A
// connects over MAPI (Connect → Execute Logon → Inbox → contents table) and sees
// it, opens it and reads the body through a stream, then composes a message in
// the Outbox and submits it to B (checked over IMAP). With the switch off again,
// a running MAPI session is refused (403) and a new Connect as well.
import {
  check, assert, creds, http, session, waitFor, BASE, PORTS, buildMime, smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend,
  imapCmd, imapQuote,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import {
  MapiHttpClient, rop, decodeLogon, decodeQueryRows, decodeOpenMessage, responseHead, TAG, HANDLE_UNUSED,
} from '../../../packages/mapi-server/src/testing/mapi-client.ts';

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

  try {
    await check('mapi: switch on for A (user level)', async () => {
      assert(await setMapi(admin, state.users.a.id, 'on') === true, 'mapi not effective');
      return 'effective on';
    });

    await check('mapi: B → A mail over SMTP submission', async () => {
      const s = await smtpOpen(PORTS.submission);
      try {
        await smtpStartTls(s);
        const auth = await smtpAuthPlain(s, B, c.userB);
        assert(auth.code === 235, `AUTH ${auth.text}`);
        const r = await smtpSend(s, B, [A], buildMime({ from: `Bob E2E <${B}>`, to: A, subject, text: 'Body read over MAPI.' }));
        assert(r.code === 250, `${r.stage}: ${r.text}`);
        return r.text.split('\n').at(-1);
      } finally { s.close(); }
    });

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

    await check('mapi: switch off → the running session is refused (403) and a new Connect too', async () => {
      assert(await setMapi(admin, state.users.a.id, 'off') === false, 'mapi still effective');
      const r = await client.execute([rop.logon(0)], [U]);
      assert(r.status === 403, `Execute after switch-off → ${r.status} code ${r.responseCode}`);
      const again = await new MapiHttpClient(BASE, A, passA).connect(LEGACY_DN + state.users.a.id);
      assert(again.status === 403, `Connect → ${again.status}`);
      return 'Execute 403, Connect 403';
    });
  } finally {
    await setMapi(admin, state.users.a.id, 'inherit').catch(() => undefined);
  }
}
