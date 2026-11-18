// Step: per-protocol access switches (9.4, docs/protocol-access.md).
// The admin switches IMAP off for B → B's IMAP IDLE session gets
// "* BYE IMAP access has been disabled …" and is closed, a new IMAP login with
// the correct password gets NO [AUTHORIZATIONFAILED], a wrong password still
// NO [AUTHENTICATIONFAILED]. Webmail off for B → web login 403 PROTOCOL_DISABLED
// and B's existing session gets 403 on the webmail API. Back to inherit → both work.
import { check, assert, creds, http, session } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

const ADMIN_PATH = '/api/v1/admin/protocol-access';

async function nextLineOrClose(c, timeout = 10_000) {
  try { return await c.readLine(timeout); } catch (err) { return c.closed ? '<closed>' : `<${err.message}>`; }
}

async function waitClosed(c, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!c.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return c.closed;
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const B = state.users.b.email;
  const userPath = `${ADMIN_PATH}/users/${state.users.b.id}`;
  const setB = (body) => http('PUT', userPath, { token: admin, body });

  await check('protocols: server level readable, MAPI off by default', async () => {
    const r = await http('GET', ADMIN_PATH, { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.effective.mapi === false && r.json.effective.imap === true, JSON.stringify(r.json.effective));
    return `imap ${r.json.settings.imap}, mapi ${r.json.settings.mapi}`;
  });

  await check('protocols: combined overview lists ports, access and warnings per protocol', async () => {
    const r = await http('GET', `${ADMIN_PATH}/overview`, { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const names = (r.json.protocols ?? []).map((p) => p.protocol);
    assert(['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'].every((p) => names.includes(p)), names.join(','));
    const imap = r.json.protocols.find((p) => p.protocol === 'imap');
    assert(imap.transport === 'listener' && imap.server === 'on' && imap.activePorts.length > 0, JSON.stringify(imap));
    assert(r.json.protocols.find((p) => p.protocol === 'activesync').transport === 'http', 'ActiveSync runs on the HTTP server');
    assert(Array.isArray(r.json.smtpInbound?.activePorts) && Array.isArray(r.json.warnings), 'smtpInbound / warnings');
    assert(!r.json.warnings.some((w) => w.protocol === 'imap'), `IMAP warns: ${JSON.stringify(r.json.warnings)}`);
    assert(Array.isArray(r.json.notices), 'notices');
    for (const n of r.json.notices) {
      const p = r.json.protocols.find((x) => x.protocol === n.protocol);
      assert(n.code === 'port-open-access-limited' && p.server === 'off' && p.activePorts.length > 0, `notice ${JSON.stringify(n)}`);
    }
    return `imap ${imap.activePorts.join('/')}, inbound ${r.json.smtpInbound.activePorts.join('/')}, ${r.json.warnings.length} warning(s)`;
  });

  await check('protocols: the server level is two-state (inherit refused)', async () => {
    const r = await http('PUT', ADMIN_PATH, { token: admin, body: { imap: 'inherit' } });
    assert(r.status === 400, `${r.status} ${r.text.slice(0, 200)}`);
    return '400';
  });

  const imapB = await imapLogin(B, c.userB);
  try {
    await check('protocols: IMAP off for B ends B\'s IDLE session with BYE', async () => {
      assert(imapB.loginResult.status === 'OK', `IMAP B: ${imapB.loginResult.text}`);
      imapB.write('PROTO1 IDLE\r\n');
      const cont = await imapB.readLine(10_000);
      assert(cont.startsWith('+'), `IDLE: ${cont}`);
      const r = await setB({ imap: 'off' });
      assert(r.status === 200 && r.json.effective.imap === false, `${r.status} ${r.text.slice(0, 200)}`);
      const l = await nextLineOrClose(imapB);
      assert(l === '* BYE IMAP access has been disabled for this account', `got ${l}`);
      assert(await waitClosed(imapB), 'connection still open after BYE');
      return l;
    });

    await check('protocols: IMAP login refused after the correct password only', async () => {
      const ok = await imapLogin(B, c.userB);
      const wrong = await imapLogin(B, `${c.userB}-wrong`);
      try {
        assert(ok.loginResult.status === 'NO' && /\[AUTHORIZATIONFAILED\] IMAP access is disabled/.test(ok.loginResult.text), `correct: ${ok.loginResult.text}`);
        assert(wrong.loginResult.status === 'NO' && /AUTHENTICATIONFAILED/.test(wrong.loginResult.text), `wrong: ${wrong.loginResult.text}`);
        return 'AUTHORIZATIONFAILED / AUTHENTICATIONFAILED';
      } finally { ok.close(); wrong.close(); }
    });

    const tokB = await session(state, 'b', B, c.userB);
    await check('protocols: B\'s external clients page leaves IMAP out', async () => {
      const r = await http('GET', '/api/v1/user/client-config', { token: tokB });
      assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
      assert(r.json.protocols?.imap === false && r.json.mail?.imap === null && r.json.mail?.pop3?.host,
        JSON.stringify({ protocols: r.json.protocols, mail: r.json.mail }));
      return 'imap null, pop3 listed';
    });

    await check('protocols: the overview counts B as a mailbox that differs for IMAP', async () => {
      const r = await http('GET', `${ADMIN_PATH}/overview`, { token: admin });
      assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
      const users = r.json.protocols.find((p) => p.protocol === 'imap').overrides.users;
      const entry = users.entries.find((e) => e.name === B);
      assert(users.differing >= 1 && entry?.setting === 'off' && entry.differs === true, JSON.stringify(users));
      const view = await http('GET', userPath, { token: admin });
      assert(view.json.inheritedFrom?.imap === 'server', `inheritedFrom ${JSON.stringify(view.json.inheritedFrom)}`);
      return `${users.differing} mailbox(es) differ`;
    });

    await check('protocols: Webmail off for B → web login 403 PROTOCOL_DISABLED, existing session refused', async () => {
      const r = await setB({ imap: 'inherit', webmail: 'off' });
      assert(r.status === 200 && r.json.effective.webmail === false && r.json.effective.imap === true, `${r.status} ${r.text.slice(0, 200)}`);
      const login = await http('POST', '/auth/login', { body: { email: B, password: c.userB } });
      assert(login.status === 403 && login.json?.code === 'PROTOCOL_DISABLED', `login ${login.status} ${login.text.slice(0, 200)}`);
      const api = await http('GET', '/api/v1/mail/folders', { token: tokB });
      assert(api.status === 403 && api.json?.code === 'PROTOCOL_DISABLED', `API ${api.status} ${api.text.slice(0, 200)}`);
      return 'login 403, API 403';
    });

    await check('protocols: back to inherit → web login and IMAP work again', async () => {
      const r = await setB({ webmail: 'inherit' });
      assert(r.status === 200 && r.json.effective.webmail === true, `${r.status} ${r.text.slice(0, 200)}`);
      const login = await http('POST', '/auth/login', { body: { email: B, password: c.userB } });
      assert(login.status === 200 && login.json?.accessToken, `login ${login.status} ${login.text.slice(0, 200)}`);
      const imap = await imapLogin(B, c.userB);
      try {
        assert(imap.loginResult.status === 'OK', `IMAP: ${imap.loginResult.text}`);
      } finally { imap.close(); }
      return 'web 200, IMAP OK';
    });
  } finally {
    imapB.close();
    // Leave B with every switch inherited, whatever failed above.
    await setB({ imap: 'inherit', webmail: 'inherit' }).catch(() => undefined);
  }
}
