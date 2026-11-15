// Step 5: POP3 110 (STLS) + 995.
import { randomBytes } from 'node:crypto';
import {
  check, assert, creds, PORTS, LineClient, popCmd, smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend, buildMime, waitFor,
} from '../lib.mjs';

export async function submit(from, pass, to, raw) {
  const s = await smtpOpen(PORTS.submission);
  try {
    await smtpStartTls(s);
    const a = await smtpAuthPlain(s, from, pass);
    if (a.code !== 235) throw new Error(`AUTH ${a.text}`);
    const r = await smtpSend(s, from, Array.isArray(to) ? to : [to], raw);
    if (r.code !== 250) throw new Error(`${r.stage}: ${r.text}`);
  } finally { s.close(); }
}

export async function popLogin(user, pass, { implicitTls = false } = {}) {
  const c = await LineClient.connect(implicitTls ? PORTS.pop3s : PORTS.pop3, { implicitTls });
  c.greeting = await c.readLine();
  if (!implicitTls) {
    const st = await popCmd(c, 'STLS');
    if (!st.ok) throw new Error(`STLS: ${st.text}`);
    await c.startTls();
  }
  const u = await popCmd(c, `USER ${user}`);
  const p = u.ok ? await popCmd(c, `PASS ${pass}`) : u;
  c.loginResult = p;
  return c;
}

export async function run(state) {
  const c = creds();
  const A = state.users.a.email, B = state.users.b.email;
  const subject = `E2E pop3 ${Date.now()}`;
  const raw = buildMime({ from: A, to: B, subject, text: 'pop3 body\r\n.dot line\r\n', attachment: { filename: 'p.bin', contentType: 'application/octet-stream', data: randomBytes(5000) } });
  await submit(A, c.userA, B, raw);
  const sent = Buffer.from(raw, 'latin1');

  await check('pop3-110: USER before STLS refused, STLS advertised', async () => {
    const s = await LineClient.connect(PORTS.pop3);
    try {
      await s.readLine();
      const capa = await popCmd(s, 'CAPA', { multi: true });
      const u = await popCmd(s, `USER ${B}`);
      assert(!u.ok, `USER accepted before STLS: ${u.text}`);
      return `CAPA STLS=${capa.lines?.includes('STLS')}; USER → ${u.text}`;
    } finally { s.close(); }
  });

  const s = await popLogin(B, c.userB);
  try {
    await check('pop3-110: STLS + USER/PASS as B', async () => { assert(s.loginResult.ok, s.loginResult.text); return s.loginResult.text; });
    let n;
    await check('pop3: STAT / LIST consistent', async () => {
      const st = await popCmd(s, 'STAT');
      const [, count, size] = st.text.split(' ');
      const list = await popCmd(s, 'LIST', { multi: true });
      const total = list.lines.reduce((a, l) => a + +l.split(' ')[1], 0);
      assert(+count === list.lines.length && +size === total, `STAT ${st.text} vs LIST ${list.lines.length}/${total}`);
      return `${st.text}`;
    });
    await check('pop3: RETR returns the submitted message byte-exact (after trace headers)', async () => {
      const list = await popCmd(s, 'LIST', { multi: true });
      // find the message by subject via TOP 0
      for (const l of list.lines) {
        const id = l.split(' ')[0];
        const top = await popCmd(s, `TOP ${id} 0`, { multi: true });
        if (top.body.includes(subject)) { n = { id, size: +l.split(' ')[1] }; }
      }
      assert(n, 'message not found via TOP');
      const r = await popCmd(s, `RETR ${n.id}`, { multi: true });
      const got = Buffer.from(r.body, 'latin1');
      const suffix = got.subarray(got.length - sent.length).equals(sent);
      assert(suffix, `RETR body (${got.length} B) does not end with the sent message (${sent.length} B)`);
      assert(n.size === got.length, `LIST size ${n.size} != RETR octets ${got.length}`);
      return `msg ${n.id}: ${got.length} B, LIST size matches, attachment intact`;
    });
    await check('pop3: UIDL works', async () => {
      const u = await popCmd(s, 'UIDL', { multi: true });
      assert(u.ok && u.lines.length > 0, u.text);
      return `${u.lines.length} uids`;
    });
    await popCmd(s, 'QUIT');
  } finally { s.close(); }

  await check('pop3-995: implicit TLS login + STAT', async () => {
    const t = await popLogin(B, c.userB, { implicitTls: true });
    try {
      assert(t.loginResult.ok, t.loginResult.text);
      const st = await popCmd(t, 'STAT');
      assert(st.ok, st.text);
      return st.text;
    } finally { t.close(); }
  });
  await waitFor(async () => true);
}
