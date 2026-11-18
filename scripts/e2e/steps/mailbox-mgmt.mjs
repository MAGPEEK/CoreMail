// Step: 9.4 mailbox management — hidden from the address list, admin forwarding
// with / without a kept copy, reject-from refused with 550 5.7.1 on port 25,
// send-as copy in the shared mailbox's Sent folder, auto-mapping and the
// mailbox access audit ("Postfachzugriffe").
import {
  check, assert, creds, http, session, buildMime, imapCmd, imapQuote, waitFor, sleep, PORTS, DOMAIN,
  smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend,
} from '../lib.mjs';
import { imapLogin } from './imap.mjs';

async function findSubject(user, pass, subject, folder = 'INBOX') {
  const im = await imapLogin(user, pass);
  try {
    const sel = await imapCmd(im, `EXAMINE ${imapQuote(folder)}`);
    if (sel.status !== 'OK') return [];
    const x = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
    return (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
  } finally { im.close(); }
}

/** Submission (587) as `user`, envelope sender `envelopeFrom`. */
async function submitAs(user, pass, envelopeFrom, rcpts, raw) {
  const s = await smtpOpen(PORTS.submission);
  try {
    await smtpStartTls(s);
    const a = await smtpAuthPlain(s, user, pass);
    assert(a.code === 235, `AUTH ${a.text}`);
    return await smtpSend(s, envelopeFrom, rcpts, raw);
  } finally { s.close(); }
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = await session(state, 'a', state.users.a.email, c.userA);
  const B = await session(state, 'b', state.users.b.email, c.userB);
  const userA = state.users.a.email, userB = state.users.b.email;
  const flowB = `/api/v1/admin/mailboxes/${state.users.b.id}/mail-flow`;
  const reset = () => http('PUT', flowB, {
    token: admin,
    body: { hiddenFromGal: false, forwardTo: null, forwardKeepCopy: true, acceptFrom: [], rejectFrom: [], maxReceiveSizeMb: null },
  });

  await check('mailbox-mgmt: hidden from the address list → not in GAL / autocomplete; shown again after reset', async () => {
    const h = await http('PUT', flowB, { token: admin, body: { hiddenFromGal: true } });
    assert(h.status === 200 && h.json?.hiddenFromGal === true, `PUT ${h.status} ${h.text.slice(0, 200)}`);
    const gal = (await http('GET', '/api/v1/contacts/gal?limit=500', { token: A })).json?.entries ?? [];
    assert(!gal.some((e) => e.email === userB), 'B still in the GAL');
    const auto = (await http('GET', `/api/v1/contacts?q=${encodeURIComponent(userB.split('@')[0])}`, { token: A })).json ?? [];
    assert(!auto.some((e) => e.email === userB), 'B still in the autocomplete');
    await reset();
    const back = (await http('GET', '/api/v1/contacts/gal?limit=500', { token: A })).json?.entries ?? [];
    assert(back.some((e) => e.email === userB), 'B missing after reset');
    return 'hidden → absent, reset → listed';
  });

  await check('mailbox-mgmt: admin forwarding B → A keeps a copy; forward-only does not', async () => {
    const f = await http('PUT', flowB, { token: admin, body: { forwardTo: userA, forwardKeepCopy: true } });
    assert(f.status === 200, `PUT ${f.status} ${f.text.slice(0, 200)}`);
    const s1 = `E2E fwd keep ${Date.now()}`;
    const r1 = await submitAs(userA, c.userA, userA, [userB], buildMime({ from: userA, to: userB, subject: s1, text: 'forward me' }));
    assert(r1.code === 250, `${r1.stage}: ${r1.text}`);
    await waitFor(async () => (await findSubject(userB, c.userB, s1)).length > 0, { timeout: 30000, what: 'copy in B INBOX' });
    await waitFor(async () => (await findSubject(userA, c.userA, s1)).length > 0, { timeout: 30000, what: 'forward in A INBOX' });

    await http('PUT', flowB, { token: admin, body: { forwardKeepCopy: false } });
    const s2 = `E2E fwd only ${Date.now()}`;
    const r2 = await submitAs(userA, c.userA, userA, [userB], buildMime({ from: userA, to: userB, subject: s2, text: 'forward only' }));
    assert(r2.code === 250, `${r2.stage}: ${r2.text}`);
    await waitFor(async () => (await findSubject(userA, c.userA, s2)).length > 0, { timeout: 30000, what: 'forward-only in A INBOX' });
    await sleep(1500);
    assert((await findSubject(userB, c.userB, s2)).length === 0, 'forward-only left a copy in B');
    await reset();
    return 'keep copy: B + A; forward only: A';
  });

  await check('mailbox-mgmt: reject-from refuses the sender on port 25 with 550 5.7.1', async () => {
    const p = await http('PUT', flowB, { token: admin, body: { rejectFrom: ['blocked.example'] } });
    assert(p.status === 200, `PUT ${p.status}`);
    const s = await smtpOpen(PORTS.smtp);
    try {
      const r = await smtpSend(s, 'sender@blocked.example', [userB], buildMime({ from: 'sender@blocked.example', to: userB, subject: 'blocked', text: 'x' }));
      assert(r.stage === 'RCPT' && r.code === 550 && /5\.7\.1/.test(r.text), `${r.stage}: ${r.text}`);
      return r.text.split('\n').at(-1);
    } finally {
      s.close();
      await reset();
    }
  });

  await check('mailbox-mgmt: send-as copy is stored in the shared mailbox Sent folder', async () => {
    const u = await http('PUT', `/api/v1/admin/shared-mailboxes/${state.shared.id}`, { token: admin, body: { sentCopySendAs: true } });
    assert(u.status === 200 && u.json?.sentCopySendAs === true, `PUT ${u.status} ${u.text.slice(0, 200)}`);
    const subject = `E2E send-as copy ${Date.now()}`;
    const r = await submitAs(userA, c.userA, state.shared.email, [userB], buildMime({ from: `Team <${state.shared.email}>`, to: userB, subject, text: 'copy me' }));
    assert(r.code === 250, `${r.stage}: ${r.text}`);
    await waitFor(async () => (await findSubject(userA, c.userA, subject, `Shared/${state.shared.email}/Sent`)).length > 0,
      { timeout: 30000, what: 'copy in Shared/<team>/Sent' });
    await http('PUT', `/api/v1/admin/shared-mailboxes/${state.shared.id}`, { token: admin, body: { sentCopySendAs: false } });
    return `Shared/${state.shared.email}/Sent`;
  });

  await check('mailbox-mgmt: mailbox access audit lists the send-as ("Postfachzugriffe" filter)', async () => {
    const rows = await waitFor(async () => {
      const r = await http('GET', '/api/v1/admin/audit-log?category=mailbox-access&limit=100', { token: admin });
      const list = r.json?.entries ?? [];
      return list.some((e) => e.action === 'mailbox.foreign.send_as') ? list : null;
    }, { timeout: 15000, what: 'mailbox.foreign.send_as audit entry' });
    assert(rows.every((e) => String(e.action).startsWith('mailbox.foreign.')), 'category filter leaked other actions');
    return `${rows.length} entries`;
  });

  await check('mailbox-mgmt: a grant without auto-mapping stays hidden until the user adds it', async () => {
    const ref = `shared:${state.shared.id}`;
    const g = await http('POST', `/api/v1/admin/shared-mailboxes/${state.shared.id}/permissions`,
      { token: admin, body: { userId: state.users.b.id, permissions: ['READ_ONLY'], autoMap: false } });
    assert(g.status === 201, `grant ${g.status} ${g.text.slice(0, 200)}`);
    try {
      const list = async () => (await http('GET', '/api/v1/user/accessible-mailboxes', { token: B })).json ?? [];
      assert((await list()).find((e) => e.ref === ref)?.hidden === true, 'not hidden without auto-mapping');
      const add = await http('PATCH', `/api/v1/user/accessible-mailboxes/${encodeURIComponent(ref)}`, { token: B, body: { hidden: false } });
      assert(add.status === 200, `add ${add.status}`);
      assert((await list()).find((e) => e.ref === ref)?.hidden === false, 'still hidden after adding');
      return 'hidden → added → shown';
    } finally {
      await http('DELETE', `/api/v1/admin/shared-mailboxes/${state.shared.id}/permissions/${state.users.b.id}`, { token: admin });
    }
  });

  await check('mailbox-mgmt: owner access log answers for the own mailbox', async () => {
    const r = await http('GET', '/api/v1/user/mailbox-access-log', { token: A });
    assert(r.status === 200 && Array.isArray(r.json?.entries), `${r.status} ${r.text.slice(0, 200)}`);
    return `${r.json.entries.length} entries (domain ${DOMAIN})`;
  });
}
