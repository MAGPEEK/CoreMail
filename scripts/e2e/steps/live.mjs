// Step: live protocol sessions after a credential change (v7.1.0).
// B holds an IMAP IDLE connection, an authenticated SMTP submission session
// and a POP3 session; B changes the password in the web client → IMAP gets
// "* BYE Credentials changed …", SMTP "421 4.7.0 …", POP3 "-ERR [AUTH] …",
// all three are closed. A's IMAP IDLE (app password) is not affected.
import { randomBytes } from 'node:crypto';
import {
  check, assert, creds, setCred, http, session, imapCmd, PORTS, smtpOpen, smtpStartTls, smtpAuthPlain, smtpRead,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import { popLogin } from './pop3.mjs';

/** Starts IDLE on a logged-in IMAP connection (expects the "+" continuation). */
async function idle(c) {
  c.write('LIVE1 IDLE\r\n');
  const cont = await c.readLine(10_000);
  if (!cont.startsWith('+')) throw new Error(`IDLE: ${cont}`);
}

/** Next line or the information that the server closed the connection. */
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
  const B = state.users.b.email;
  const A = state.users.a.email;
  const tokB = await session(state, 'b', B, c.userB);

  const imapB = await imapLogin(B, c.userB);
  const imapA = c.appPwA ? await imapLogin(A, c.appPwA) : null;
  const smtpB = await smtpOpen(PORTS.submission);
  const popB = await popLogin(B, c.userB);
  try {
    await check('live: B (password) IDLE + SMTP AUTH + POP3, A (app password) IDLE', async () => {
      assert(imapB.loginResult.status === 'OK', `IMAP B: ${imapB.loginResult.text}`);
      await idle(imapB);
      if (imapA) { assert(imapA.loginResult.status === 'OK', `IMAP A: ${imapA.loginResult.text}`); await idle(imapA); }
      await smtpStartTls(smtpB);
      const a = await smtpAuthPlain(smtpB, B, c.userB);
      assert(a.code === 235, `SMTP AUTH B: ${a.text}`);
      assert(popB.loginResult.ok, `POP3 B: ${popB.loginResult.text}`);
      return `IDLE B${imapA ? ' + IDLE A' : ''}, SMTP 235, POP3 +OK`;
    });

    const newPw = `UsB-${randomBytes(10).toString('hex')}`;
    await check('live: B changes the password (web)', async () => {
      const r = await http('POST', '/api/v1/user/change-password', { token: tokB, body: { currentPassword: c.userB, newPassword: newPw } });
      assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
      setCred('userB', newPw); // later steps / re-runs use the new password
      return '200';
    });

    await check('live: IMAP IDLE connection of B gets BYE and is closed', async () => {
      const l = await nextLineOrClose(imapB);
      assert(l === '* BYE Credentials changed, please log in again', `got ${l}`);
      assert(await waitClosed(imapB), 'connection still open after BYE');
      return l;
    });

    await check('live: SMTP submission session of B gets 421 4.7.0 and is closed', async () => {
      const r = await smtpRead(smtpB);
      assert(r.code === 421 && /4\.7\.0/.test(r.text), `got ${r.code} ${r.text}`);
      assert(await waitClosed(smtpB), 'connection still open after 421');
      return r.text;
    });

    await check('live: POP3 session of B gets -ERR [AUTH] and is closed', async () => {
      const l = await nextLineOrClose(popB);
      assert(/^-ERR \[AUTH\] Credentials changed/.test(l), `got ${l}`);
      assert(await waitClosed(popB), 'connection still open after -ERR');
      return l;
    });

    if (imapA) {
      await check('live: A\'s IDLE connection (other user) stays usable', async () => {
        imapA.write('DONE\r\n');
        const l = await nextLineOrClose(imapA);
        assert(/^LIVE1 OK/.test(l), `got ${l}`);
        const n = await imapCmd(imapA, 'NOOP');
        assert(n.status === 'OK', n.text);
        return 'DONE → OK, NOOP OK';
      });
    }

    await check('live: old password refused, new password accepted (IMAP)', async () => {
      const old = await imapLogin(B, c.userB);
      const fresh = await imapLogin(B, newPw);
      try {
        assert(old.loginResult.status === 'NO', `old password: ${old.loginResult.text}`);
        assert(fresh.loginResult.status === 'OK', `new password: ${fresh.loginResult.text}`);
        return 'NO / OK';
      } finally { old.close(); fresh.close(); }
    });
  } finally {
    imapB.close(); imapA?.close(); smtpB.close(); popB.close();
  }
}
