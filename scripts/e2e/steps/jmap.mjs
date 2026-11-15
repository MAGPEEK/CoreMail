// Step 6: JMAP (RFC 8620/8621) — discovery, query/get, draft + EmailSubmission, Bcc stripping, /changes after IMAP.
import { check, assert, creds, http, basic, imapCmd, imapQuote, waitFor } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

export async function jmap(auth, methodCalls) {
  const r = await http('POST', '/jmap/api', { headers: { Authorization: auth }, body: { using: USING, methodCalls } });
  if (r.status !== 200) throw new Error(`JMAP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json.methodResponses;
}
const resp = (rs, id) => { const x = rs.find((m) => m[2] === id); if (!x) throw new Error(`no response ${id}`); if (x[0] === 'error') throw new Error(`${id}: ${JSON.stringify(x[1])}`); return x[1]; };

export async function run(state) {
  const c = creds();
  const A = state.users.a.email, B = state.users.b.email, H = state.users.helpdesk.email;
  const authA = basic(A, state.mfaA ? state.appPwA : c.userA);
  const authB = basic(B, c.userB);

  let accA, accB;
  await check('jmap: /.well-known/jmap discovery → session', async () => {
    const wk = await http('GET', '/.well-known/jmap', { headers: { Authorization: authB } });
    assert([200, 301, 302, 307, 308].includes(wk.status), `well-known ${wk.status}`);
    const sess = await http('GET', '/jmap/session', { headers: { Authorization: authB } });
    assert(sess.status === 200 && sess.json?.apiUrl, `session ${sess.status} ${sess.text.slice(0, 200)}`);
    accB = sess.json.primaryAccounts['urn:ietf:params:jmap:mail'];
    const unauth = await http('GET', '/jmap/session');
    assert(unauth.status === 401, `unauthenticated session → ${unauth.status}`);
    return `well-known ${wk.status} ${wk.headers.get('location') ?? ''}; apiUrl ${sess.json.apiUrl}; unauth 401`;
  });
  accA = (await http('GET', '/jmap/session', { headers: { Authorization: authA } })).json?.primaryAccounts?.['urn:ietf:params:jmap:mail'];

  let inboxB;
  await check('jmap: Mailbox/get + Email/query + Email/get (B)', async () => {
    const rs = await jmap(authB, [
      ['Mailbox/get', { accountId: accB, ids: null, properties: ['name', 'role', 'totalEmails'] }, 'm'],
      ['Email/query', { accountId: accB, filter: { subject: state.a2b?.subject ?? 'E2E' }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 5 }, 'q'],
      ['Email/get', { accountId: accB, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'from', 'hasAttachment', 'attachments', 'mailboxIds', 'keywords', 'size'] }, 'g'],
    ]);
    const mbs = resp(rs, 'm').list;
    inboxB = mbs.find((m) => m.role === 'inbox');
    const emails = resp(rs, 'g').list;
    assert(inboxB, 'no inbox role');
    assert(emails.length >= 1, 'Email/query found nothing for the A→B subject');
    const e = emails[0];
    assert(e.hasAttachment && e.attachments?.some((a) => a.name === 'e2e-data.bin'), `attachment missing: ${JSON.stringify(e.attachments)}`);
    state.jmapEmailB = e.id;
    return `${mbs.length} mailboxes; email ${e.id} with e2e-data.bin, keywords ${JSON.stringify(e.keywords)}`;
  });

  await check('jmap: Email/set draft + EmailSubmission A→B (Bcc helpdesk), Bcc not in delivered message', async () => {
    const subject = `E2E jmap submission ${Date.now()}`;
    const rs0 = await jmap(authA, [
      ['Mailbox/get', { accountId: accA, ids: null, properties: ['role'] }, 'm'],
      ['Identity/get', { accountId: accA }, 'i'],
    ]);
    const drafts = resp(rs0, 'm').list.find((m) => m.role === 'drafts');
    const ident = resp(rs0, 'i').list.find((x) => x.email === A);
    assert(drafts && ident, `drafts=${!!drafts} identity=${!!ident}`);
    const rs = await jmap(authA, [
      ['Email/set', { accountId: accA, create: { d1: {
        mailboxIds: { [drafts.id]: true }, keywords: { $draft: true },
        from: [{ email: A, name: 'Alice' }], to: [{ email: B }], bcc: [{ email: H }],
        subject, textBody: [{ partId: 't', type: 'text/plain' }], bodyValues: { t: { value: 'Hello via JMAP' } },
      } } }, 'e'],
      ['EmailSubmission/set', { accountId: accA, create: { s1: { emailId: '#d1', identityId: ident.id } } }, 's'],
    ]);
    const created = resp(rs, 'e').created?.d1;
    assert(created, `Email/set: ${JSON.stringify(resp(rs, 'e').notCreated)}`);
    const sub = resp(rs, 's');
    assert(sub.created?.s1, `EmailSubmission/set: ${JSON.stringify(sub.notCreated)}`);
    // delivered to B and to the Bcc recipient — and the raw message carries no Bcc header
    const fetchRaw = async (user, pass) => {
      const im = await imapLogin(user, pass);
      try {
        await imapCmd(im, 'SELECT INBOX');
        return await waitFor(async () => {
          const x = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
          const id = (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean).at(-1);
          if (!id) return null;
          return (await imapCmd(im, `UID FETCH ${id} (BODY.PEEK[])`)).literals[0].toString('latin1');
        }, { timeout: 30000, what: `JMAP-submitted mail at ${user}` });
      } finally { im.close(); }
    };
    const rawB = await fetchRaw(B, c.userB);
    const rawH = await fetchRaw(H, c.helpdesk);
    const hdrB = rawB.split('\r\n\r\n')[0];
    const hdrH = rawH.split('\r\n\r\n')[0];
    assert(!/^bcc:/im.test(hdrB), 'Bcc header present in B\'s copy');
    assert(!/^bcc:/im.test(hdrH), 'Bcc header present in the Bcc recipient\'s copy');
    return `submission ${sub.created.s1.id}; delivered to B + Bcc recipient; no Bcc header`;
  });

  await check('jmap: Email/changes reports an IMAP flag change', async () => {
    const before = resp(await jmap(authB, [['Email/get', { accountId: accB, ids: [state.jmapEmailB], properties: ['keywords'] }, 'g']]), 'g');
    const oldState = before.state;
    // flip \Seen on that message over IMAP
    const im = await imapLogin(B, c.userB);
    let target;
    try {
      await imapCmd(im, 'SELECT INBOX');
      const x = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(state.pop3Subject ?? 'E2E pop3')}`);
      target = (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean).at(-1);
      assert(target, 'no IMAP target message');
      const st = await imapCmd(im, `UID STORE ${target} +FLAGS (\\Seen \\Answered)`);
      assert(st.status === 'OK', st.text);
    } finally { im.close(); }
    const ch = resp(await jmap(authB, [['Email/changes', { accountId: accB, sinceState: oldState }, 'c']]), 'c');
    const changed = [...(ch.updated ?? []), ...(ch.created ?? [])];
    assert(changed.length > 0, `Email/changes since ${oldState} → nothing (newState ${ch.newState})`);
    return `updated ${ch.updated?.length ?? 0}, created ${ch.created?.length ?? 0} (old ${oldState} → ${ch.newState})`;
  });

  await check('jmap: Basic auth with wrong password → 401', async () => {
    const r = await http('GET', '/jmap/session', { headers: { Authorization: basic(B, 'wrong-password-xyz') } });
    assert(r.status === 401, `${r.status}`);
    return '401';
  });
}
