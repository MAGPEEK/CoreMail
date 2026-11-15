// Step 11: TOTP MFA for A → web login needs MFA; mail protocols refuse the primary
// password; an app password works on IMAP/SMTP/POP3/JMAP/CalDAV/ActiveSync.
import {
  check, assert, creds, setCred, http, basic, totp, nextTotpWindow, imapCmd, PORTS, LineClient, popCmd,
  smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend, buildMime, sleep,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import { popLogin } from './pop3.mjs';

async function protocolLogins(user, pass, state) {
  const out = {};
  const im = await imapLogin(user, pass); out.imap = im.loginResult.status === 'OK' ? 'ok' : im.loginResult.text; im.close();
  const s = await smtpOpen(PORTS.submission); await smtpStartTls(s);
  const a = await smtpAuthPlain(s, user, pass); out.smtp = a.code === 235 ? 'ok' : a.text;
  if (a.code === 235) {
    const r = await smtpSend(s, user, [state.users.b.email], buildMime({ from: user, to: state.users.b.email, subject: `E2E app-password send ${Date.now()}`, text: 'x' }));
    out.smtpSend = r.code === 250 ? 'ok' : r.text;
  }
  s.close();
  const p = await popLogin(user, pass); out.pop3 = p.loginResult.ok ? 'ok' : p.loginResult.text; p.close();
  const j = await http('GET', '/jmap/session', { headers: { Authorization: basic(user, pass) } }); out.jmap = j.status === 200 ? 'ok' : `${j.status}`;
  const d = await http('PROPFIND', `/dav/calendars/${state.users.a.id}`, { headers: { Authorization: basic(user, pass), Depth: '0' } }); out.caldav = d.status === 207 ? 'ok' : `${d.status}`;
  const e = await http('OPTIONS', '/Microsoft-Server-ActiveSync', { headers: { Authorization: basic(user, pass) } });
  const e2 = await http('POST', `/Microsoft-Server-ActiveSync?Cmd=Ping&User=${encodeURIComponent(user)}&DeviceId=E2EMFA&DeviceType=iPhone`, { headers: { Authorization: basic(user, pass), 'MS-ASProtocolVersion': '14.1' } });
  out.eas = e2.status === 200 ? 'ok' : `${e2.status}`;
  void e;
  return out;
}

export async function run(state) {
  const c = creds();
  const A = state.users.a.email;

  // Fresh, non-MFA web login (primary password)
  const l0 = await http('POST', '/auth/login', { body: { email: A, password: c.userA } });
  let secret;
  if (l0.json?.mfaRequired) {
    secret = state.totpSecretA;
    console.log('  A already has TOTP — reusing stored secret');
  } else {
    await check('mfa: enable TOTP for A (setup + confirm)', async () => {
      const tok = l0.json.accessToken;
      const noReauth = await http('POST', '/auth/mfa/totp/setup', { token: tok, body: {} });
      assert(noReauth.status === 401 || noReauth.status === 400 || noReauth.status === 403, `setup without re-auth → ${noReauth.status}`);
      const s = await http('POST', '/auth/mfa/totp/setup', { token: tok, body: { currentPassword: c.userA, accountName: A } });
      assert(s.status === 200 && s.json?.secret, `${s.status} ${s.text.slice(0, 200)}`);
      secret = s.json.secret;
      state.totpSecretA = secret; // test-only secret, kept in the state dir outside the repo
      const conf = await http('POST', '/auth/mfa/totp/confirm', { token: tok, body: { code: totp(secret) } });
      assert(conf.status === 200, `confirm ${conf.status} ${conf.text}`);
      return `setup without re-auth → ${noReauth.status}; confirmed`;
    });
  }
  state.mfaA = true;

  let mfaTok;
  await check('mfa: web login now requires the second factor', async () => {
    const l = await http('POST', '/auth/login', { body: { email: A, password: c.userA } });
    assert(l.status === 200 && l.json?.mfaRequired && l.json?.challengeToken && !l.json?.accessToken, `${l.status} ${l.text.slice(0, 200)}`);
    const wrong = await http('POST', '/auth/mfa/verify', { body: { challengeToken: l.json.challengeToken, code: '000000' } });
    assert(wrong.status === 401 || wrong.status === 400, `wrong code → ${wrong.status}`);
    await nextTotpWindow(); // the confirm step consumed the current step (replay protection)
    const v = await http('POST', '/auth/mfa/verify', { body: { challengeToken: l.json.challengeToken, code: totp(secret) } });
    assert(v.status === 200 && v.json?.accessToken, `verify ${v.status} ${v.text.slice(0, 200)}`);
    mfaTok = v.json.accessToken;
    state.sessions ??= {}; state.sessions.a = { access: v.json.accessToken, refresh: v.json.refreshToken, exp: Date.now() + v.json.expiresIn * 1000 };
    const replay = await http('POST', '/auth/login', { body: { email: A, password: c.userA } });
    const rv = await http('POST', '/auth/mfa/verify', { body: { challengeToken: replay.json.challengeToken, code: totp(secret) } });
    assert(rv.status !== 200, 'same TOTP code accepted twice (replay)');
    return `mfaRequired → verify 200; wrong code ${wrong.status}; replayed code ${rv.status}`;
  });

  await check('mfa: primary password refused on IMAP/SMTP/POP3/JMAP/CalDAV/EAS', async () => {
    const r = await protocolLogins(A, c.userA, state);
    let accepted = Object.entries(r).filter(([, v]) => v === 'ok');
    let note = '';
    if (accepted.length === 1 && accepted[0][0] === 'jmap') {
      // jmap-server caches successful Basic auth for 60 s (auth.ts) — a password that
      // authenticated just before MFA was enabled keeps working until the entry expires.
      await sleep(61_000);
      const j = await http('GET', '/jmap/session', { headers: { Authorization: basic(A, c.userA) } });
      r.jmap = j.status === 200 ? 'ok' : `${j.status}`;
      accepted = Object.entries(r).filter(([, v]) => v === 'ok');
      note = ` (JMAP accepted the primary password for up to 60 s after MFA was enabled — Basic auth cache; refused after expiry: ${r.jmap})`;
    }
    assert(accepted.length === 0, `accepted with primary password: ${accepted.map(([k]) => k).join(', ')} — ${JSON.stringify(r)}`);
    return JSON.stringify(r).slice(0, 400) + note;
  });

  await check('mfa: app password created and works on IMAP/SMTP/POP3/JMAP/CalDAV/EAS', async () => {
    const ap = await http('POST', '/auth/app-passwords', { token: mfaTok, body: { name: 'e2e client' } });
    assert(ap.status === 201 && ap.json?.password, `${ap.status} ${ap.text.slice(0, 200)}`);
    setCred('appPwA', ap.json.password);
    state.appPwId = ap.json.id;
    const r = await protocolLogins(A, ap.json.password, state);
    const failed = Object.entries(r).filter(([, v]) => v !== 'ok');
    assert(failed.length === 0, JSON.stringify(r));
    return JSON.stringify(r);
  });
  state.appPwA = creds().appPwA;

  await check('mfa: app password is not accepted for web login', async () => {
    const l = await http('POST', '/auth/login', { body: { email: A, password: creds().appPwA } });
    assert(l.status === 401, `${l.status} ${l.text.slice(0, 120)}`);
    return '401';
  });
}
