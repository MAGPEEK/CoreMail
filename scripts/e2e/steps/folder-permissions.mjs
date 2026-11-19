// Step: w3 folder permissions — A grants B "Reviewer" on a subfolder of A's
// mailbox; B reads it over REST and IMAP (Other Users/), cannot write, does not
// see A's other folders; the change is audited; A revokes → B gets 403 over
// REST and the selected IMAP folder is closed / NO.
import { check, assert, creds, http, session, buildMime, imapCmd, imapQuote, waitFor } from '../lib.mjs';
import { imapLogin } from './imap.mjs';

const OTHER_USERS = process.env.IMAP_NAMESPACE_OTHER_USERS ?? 'Other Users';

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = await session(state, 'a', state.users.a.email, c.userA);
  const B = await session(state, 'b', state.users.b.email, c.userB);
  const userA = state.users.a.email, userB = state.users.b.email;
  const passA = state.mfaA ? state.appPwA : c.userA; // MFA users need an app password on IMAP
  const stamp = Date.now();
  const parent = `E2E-Freigabe-${stamp}`;
  const sub = `${parent}.Projekt`;
  const subject = `E2E folder permission ${stamp}`;
  const foreignSub = `${OTHER_USERS}/${userA}/${parent}/Projekt`;
  const ctx = {};

  await check('folder-permissions: A creates a folder with a subfolder and a message (IMAP)', async () => {
    const im = await imapLogin(userA, passA);
    try {
      for (const name of [parent, sub]) {
        const r = await imapCmd(im, `CREATE ${imapQuote(name)}`);
        assert(r.status === 'OK', `CREATE ${name}: ${r.text}`);
      }
      const raw = buildMime({ from: userA, to: userA, subject, text: 'shared through a folder permission' });
      const ap = await imapCmd(im, `APPEND ${imapQuote(sub)} ()`, { literal: raw });
      assert(ap.status === 'OK', `APPEND ${ap.text}`);
    } finally { im.close(); }
    const folders = (await http('GET', '/api/v1/mail/folders', { token: A })).json ?? [];
    ctx.sub = folders.find((f) => f.name === sub);
    ctx.parent = folders.find((f) => f.name === parent);
    ctx.inbox = folders.find((f) => f.name === 'INBOX');
    assert(ctx.sub && ctx.parent && ctx.inbox, `folders not found: ${folders.map((f) => f.name).join(', ')}`);
    return ctx.sub.id;
  });

  await check('folder-permissions: A grants B "Reviewer" on the subfolder (REST), audited', async () => {
    const r = await http('PUT', `/api/v1/mail/folders/${ctx.sub.id}/permissions`, {
      token: A, body: { entries: [{ grantee: 'default', role: 'none' }, { grantee: { email: userB }, role: 'reviewer' }] },
    });
    assert(r.status === 200, `PUT ${r.status} ${r.text.slice(0, 200)}`);
    const entry = (r.json?.entries ?? []).find((e) => e.user?.email === userB);
    assert(entry?.role === 'reviewer', `entry ${JSON.stringify(entry)}`);
    await waitFor(async () => {
      const a = await http('GET', `/api/v1/admin/audit-log?searchText=${encodeURIComponent('mailbox.folder.permission.set')}&limit=50`, { token: admin });
      return (a.json?.entries ?? []).some((e) => e.targetId === ctx.sub.id);
    }, { timeout: 15000, what: 'mailbox.folder.permission.set audit entry' });
    return 'granted + audited';
  });

  await check('folder-permissions: B reads the subfolder over REST, cannot write, sees no other folder', async () => {
    const list = (await http('GET', '/api/v1/user/accessible-mailboxes', { token: B })).json ?? [];
    const box = list.find((e) => e.email === userA.toLowerCase());
    assert(box?.folderScoped === true, `accessible mailbox ${JSON.stringify(box)}`);
    ctx.base = `/api/v1/mail/delegated-mailboxes/${box.id}`;
    const folders = (await http('GET', `${ctx.base}/folders`, { token: B })).json ?? [];
    const shown = folders.map((f) => [f.name, f.noSelect]);
    assert(folders.some((f) => f.id === ctx.sub.id && f.noSelect === false), `subfolder missing: ${JSON.stringify(shown)}`);
    assert(folders.every((f) => f.id === ctx.sub.id || f.noSelect === true), `other folders visible: ${JSON.stringify(shown)}`);
    const msgs = (await http('GET', `${ctx.base}/folders/${ctx.sub.id}/messages`, { token: B })).json?.messages ?? [];
    const msg = msgs.find((m) => m.subject === subject);
    assert(msg, 'message not listed');
    const patch = await http('PATCH', `${ctx.base}/messages/${msg.id}`, { token: B, body: { flagged: true } });
    assert(patch.status === 403, `PATCH → ${patch.status}`);
    const inbox = await http('GET', `${ctx.base}/folders/${ctx.inbox.id}/messages`, { token: B });
    assert(inbox.status === 404, `A's INBOX → ${inbox.status}`);
    ctx.messageId = msg.id;
    return `${folders.length} folder(s) listed, write 403, INBOX 404`;
  });

  await check('folder-permissions: B reads the subfolder over IMAP (read-only), A\'s INBOX does not exist for B', async () => {
    const im = await imapLogin(userB, c.userB);
    try {
      const list = await imapCmd(im, `LIST "" ${imapQuote(`${OTHER_USERS}/${userA}/*`)}`);
      assert(list.lines.some((l) => l.includes(foreignSub)), `LIST: ${list.lines.join(' | ')}`);
      assert(!list.lines.some((l) => l.endsWith(`${userA}/INBOX"`)), 'INBOX listed');
      const sel = await imapCmd(im, `SELECT ${imapQuote(foreignSub)}`);
      assert(sel.status === 'OK' && /READ-ONLY/.test(sel.text), `SELECT ${sel.text}`);
      const s = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
      const uid = (s.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ')[2];
      assert(uid, 'message not found over IMAP');
      const store = await imapCmd(im, `UID STORE ${uid} +FLAGS (\\Flagged)`);
      assert(store.status === 'NO' && /NOPERM/.test(store.text), `STORE ${store.text}`);
      const my = await imapCmd(im, `MYRIGHTS ${imapQuote(foreignSub)}`);
      assert(my.lines.some((l) => / lr$/.test(l)), `MYRIGHTS ${my.lines.join(' | ')}`);
      const inbox = await imapCmd(im, `EXAMINE ${imapQuote(`${OTHER_USERS}/${userA}/INBOX`)}`);
      assert(inbox.status === 'NO', `INBOX ${inbox.text}`);

      // revoke while B has the folder selected
      await imapCmd(im, `SELECT ${imapQuote(foreignSub)}`);
      const r = await http('PUT', `/api/v1/mail/folders/${ctx.sub.id}/permissions`, { token: A, body: { entries: [] } });
      assert(r.status === 200, `revoke PUT ${r.status}`);
      const after = await waitFor(async () => {
        const f = await imapCmd(im, `UID FETCH ${uid} (FLAGS)`);
        return f.status === 'NO' || f.lines.some((l) => l.includes('[CLOSED]')) ? f : null;
      }, { timeout: 35000, what: 'selected folder closed after the revocation' });
      return `revoked: ${after.text}`;
    } finally { im.close(); }
  });

  await check('folder-permissions: after the revocation B gets 403 over REST', async () => {
    const r = await http('GET', `${ctx.base}/folders/${ctx.sub.id}/messages`, { token: B });
    assert(r.status === 403, `→ ${r.status}`);
    const m = await http('GET', `${ctx.base}/messages/${ctx.messageId}`, { token: B });
    assert(m.status === 403, `message → ${m.status}`);
    return '403';
  });

  await check('folder-permissions: a SEND_AS delegation reveals no folders of A (GET /mail/delegated-mailboxes)', async () => {
    const g = await http('POST', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates`, {
      token: admin, body: { granteeId: state.users.b.id, permission: 'SEND_AS' },
    });
    assert(g.status === 201, `grant SEND_AS ${g.status} ${g.text.slice(0, 200)}`);
    try {
      const list = (await http('GET', '/api/v1/mail/delegated-mailboxes', { token: B })).json ?? [];
      const entry = list.find((d) => d.mailboxOwner?.id === state.users.a.id);
      assert(entry?.permission === 'SEND_AS', `delegation ${JSON.stringify(entry)}`);
      assert(Array.isArray(entry.folders) && entry.folders.length === 0, `folders listed: ${entry.folders?.length}`);
      return 'no folders';
    } finally {
      await http('DELETE', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates/${state.users.b.id}`, { token: admin });
    }
  });

  await check('folder-permissions: unknown and hidden addresses get the same answer (w3, no address oracle)', async () => {
    const put = (email) => http('PUT', `/api/v1/mail/folders/${ctx.sub.id}/permissions`, {
      token: A, body: { entries: [{ grantee: { email }, role: 'reviewer' }] },
    });
    const unknown = await put(`nobody-${stamp}@${userA.split('@')[1]}`);
    assert(unknown.status === 400 && unknown.json?.code === 'UNKNOWN_GRANTEE', `unknown ${unknown.status} ${unknown.text}`);
    const flowB = `/api/v1/admin/mailboxes/${state.users.b.id}/mail-flow`;
    const h = await http('PUT', flowB, { token: admin, body: { hiddenFromGal: true } });
    assert(h.status === 200, `hide B ${h.status}`);
    try {
      const hidden = await put(userB);
      assert(hidden.status === unknown.status && hidden.text === unknown.text, `hidden ${hidden.status} ${hidden.text} vs ${unknown.text}`);
    } finally {
      await http('PUT', flowB, { token: admin, body: { hiddenFromGal: false } });
    }
    return 'unknown = hidden: 400 UNKNOWN_GRANTEE';
  });

  await check('folder-permissions: a grantee cannot probe hidden folder names (w3, REST 403 / IMAP NOPERM)', async () => {
    // B may create subfolders in the parent, but cannot see the existing subfolder "Projekt"
    const g = await http('PUT', `/api/v1/mail/folders/${ctx.parent.id}/permissions`, {
      token: A, body: { entries: [{ grantee: { email: userB }, role: 'publishingEditor' }] },
    });
    assert(g.status === 200, `grant ${g.status} ${g.text.slice(0, 200)}`);
    try {
      const rest = await http('POST', `${ctx.base}/folders`, { token: B, body: { name: sub, parentId: ctx.parent.id } });
      assert(rest.status === 403 && rest.json?.code === 'NO_PERMISSION', `REST create over a hidden name → ${rest.status} ${rest.text}`);
      const im = await imapLogin(userB, c.userB);
      try {
        const cr = await imapCmd(im, `CREATE ${imapQuote(foreignSub)}`);
        assert(cr.status === 'NO' && /NOPERM/.test(cr.text) && !/ALREADYEXISTS/.test(cr.text), `IMAP CREATE ${cr.text}`);
      } finally { im.close(); }
      return 'REST 403 NO_PERMISSION, IMAP NO [NOPERM]';
    } finally {
      await http('PUT', `/api/v1/mail/folders/${ctx.parent.id}/permissions`, { token: A, body: { entries: [] } });
    }
  });

  await check('folder-permissions: admin overview lists the folders of A\'s mailbox', async () => {
    const r = await http('GET', `/api/v1/admin/mailboxes/${state.users.a.id}/folder-permissions`, { token: admin });
    assert(r.status === 200 && Array.isArray(r.json) && r.json.some((f) => f.id === ctx.sub.id), `GET ${r.status}`);
    const im = await imapLogin(userA, passA);
    try {
      for (const name of [sub, parent]) await imapCmd(im, `DELETE ${imapQuote(name)}`);
    } finally { im.close(); }
    return `${r.json.length} folders`;
  });
}
