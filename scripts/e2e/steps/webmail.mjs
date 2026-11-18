// Step: webmail — shared / delegated mailboxes in the mail view (9.3), API level:
// folder-pane list + hide/show persistence (/user/accessible-mailboxes), folder and
// subfolder deletes (re-parent without ?recursive, subtree with it),
// message operations on a shared mailbox with FULL_ACCESS, READ_ONLY → every write
// 403 READ_ONLY (shared + delegated), SEND_AS-free users see nothing; 9.4 live
// stream (contacts / calendar / mailbox events), manifest + service worker. Grants made
// here are removed again at the end.
import { BASE, check, assert, creds, http, session, openSse } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  assert(state.shared?.id && state.users?.a?.id && state.users?.b?.id, 'needs the users step (shared mailbox, users A + B)');
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = await session(state, 'a', state.users.a.email, c.userA);
  const B = await session(state, 'b', state.users.b.email, c.userB);
  const sharedRef = `shared:${state.shared.id}`;
  const S = `/api/v1/mail/shared-mailboxes/${state.shared.id}`;
  const OLD = `/api/v1/user/shared-mailboxes/${state.shared.id}`; // pre-9.3 contract (compat)
  const vis = (ref) => `/api/v1/user/accessible-mailboxes/${encodeURIComponent(ref)}`;
  const listOf = async (tok) => (await http('GET', '/api/v1/user/accessible-mailboxes', { token: tok })).json ?? [];

  await check('webmail: accessible mailboxes list the shared mailbox with German-mappable permissions', async () => {
    const entry = (await listOf(A)).find((e) => e.ref === sharedRef);
    assert(entry, 'shared mailbox missing for A');
    assert(entry.readOnly === false && entry.permissions.includes('FULL_ACCESS') && entry.permissions.includes('SEND_AS'),
      `entry ${JSON.stringify(entry)}`);
    assert(!(await listOf(B)).some((e) => e.ref === sharedRef), 'B (no grant) must not see the shared mailbox');
    return `${entry.ref} ${entry.permissions.join('+')}`;
  });

  await check('webmail: hide / show persists server-side', async () => {
    const h = await http('PATCH', vis(sharedRef), { token: A, body: { hidden: true } });
    assert(h.status === 200 && h.json?.hidden === true, `hide ${h.status} ${h.text.slice(0, 200)}`);
    assert((await listOf(A)).find((e) => e.ref === sharedRef)?.hidden === true, 'hidden flag not persisted');
    const s = await http('PATCH', vis(sharedRef), { token: A, body: { hidden: false } });
    assert(s.status === 200 && s.json?.hidden === false, `show ${s.status}`);
    assert((await listOf(A)).find((e) => e.ref === sharedRef)?.hidden === false, 'show not persisted');
    const foreign = await http('PATCH', vis(sharedRef), { token: B, body: { hidden: true } });
    assert(foreign.status === 404, `B hiding a mailbox without access → ${foreign.status}`);
    const bad = await http('PATCH', vis('team'), { token: A, body: { hidden: true } });
    assert(bad.status === 400, `invalid ref → ${bad.status}`);
    return 'hide → hidden, show → visible; no access 404, bad ref 400';
  });

  let folderId;
  await check('webmail: FULL_ACCESS — folders, list, search, folder create/rename/delete in the shared mailbox', async () => {
    const f = await http('GET', `${S}/folders`, { token: A });
    assert(f.status === 200 && Array.isArray(f.json), `folders ${f.status}`);
    const inbox = f.json.find((x) => x.name === 'INBOX');
    assert(inbox && inbox.isSystem === true, 'INBOX missing');
    const l = await http('GET', `${S}/folders/${inbox.id}/messages?limit=5`, { token: A });
    assert(l.status === 200 && typeof l.json?.total === 'number' && Array.isArray(l.json.messages), `list ${l.status}`);
    const q = await http('GET', `${S}/search?q=${encodeURIComponent('E2E')}`, { token: A });
    assert(q.status === 200 && Array.isArray(q.json?.messages), `search ${q.status}`);
    const name = `E2E-Webmail-${Date.now()}`;
    const cr = await http('POST', `${S}/folders`, { token: A, body: { name, parentId: inbox.id } });
    assert(cr.status === 201 && cr.json?.id, `create ${cr.status} ${cr.text.slice(0, 200)}`);
    folderId = cr.json.id;
    const rn = await http('PATCH', `${S}/folders/${folderId}`, { token: A, body: { name: `${name}-x` } });
    assert(rn.status === 200, `rename ${rn.status}`);
    const own = (await http('GET', '/api/v1/mail/folders', { token: A })).json ?? [];
    assert(!own.some((x) => x.id === folderId), 'shared folder must not appear in the own mailbox');
    const mv = await http('PATCH', `${S}/folders/${folderId}`, { token: A, body: { parentId: own.find((x) => x.name === 'INBOX')?.id } });
    assert(mv.status === 404, `reparent into the own mailbox → ${mv.status}`);
    return `inbox total ${l.json.total}; folder created + renamed`;
  });

  await check('webmail: pre-9.3 /user/shared-mailboxes/:id routes keep their contract (compat)', async () => {
    const f = await http('GET', `${OLD}/folders`, { token: A });
    assert(f.status === 200 && Array.isArray(f.json) && f.json.every((x) => !('isSystem' in x)), `old folders ${f.status}`);
    const inbox = f.json.find((x) => x.name === 'INBOX');
    const l = await http('GET', `${OLD}/folders/${inbox.id}/messages?limit=5`, { token: A });
    assert(l.status === 200 && typeof l.json?.total === 'number' && Array.isArray(l.json.messages)
      && !('limit' in l.json), `old list ${l.status} ${l.text.slice(0, 200)}`);
    const sys = await http('DELETE', `${OLD}/folders/${inbox.id}`, { token: A });
    assert(sys.status === 403, `old protected delete → ${sys.status}`);
    const cr = await http('POST', `${OLD}/folders`, { token: A, body: { displayName: `E2E-Compat-${Date.now()}` } });
    assert(cr.status === 201 && cr.json?.id, `old create ${cr.status}`);
    const d = await http('DELETE', `${OLD}/folders/${cr.json.id}`, { token: A });
    assert(d.status === 204, `old delete → ${d.status}`);
    return 'array folders, {total,messages}, 403 protected, 201 create, 204 delete';
  });

  await check('webmail: folder with subfolders (depth 3) — without recursive the subfolder moves up, ?recursive=true deletes the subtree', async () => {
    const stamp = Date.now();
    const ids = [];
    for (let depth = 0; depth < 4; depth++) {
      const cr = await http('POST', '/api/v1/mail/folders', { token: A, body: { name: `E2E-Tree-${stamp}-${depth}`, parentId: ids[depth - 1] ?? null } });
      assert(cr.status === 200 && cr.json?.id, `create depth ${depth} → ${cr.status} ${cr.text.slice(0, 200)}`);
      ids.push(cr.json.id);
    }
    // 9.3 contract: 200 without ?recursive — only the folder goes, its subfolder moves up to its parent
    const one = await http('DELETE', `/api/v1/mail/folders/${ids[1]}?force=true`, { token: A });
    assert(one.status === 200 && one.json?.folders === 1 && one.json?.reparented === 1, `without recursive → ${one.status} ${one.text.slice(0, 200)}`);
    const mid = ((await http('GET', '/api/v1/mail/folders', { token: A })).json ?? []).find((x) => x.id === ids[2]);
    assert(mid?.parentId === ids[0], `subfolder parent ${mid?.parentId}, expected ${ids[0]}`);
    const d = await http('DELETE', `/api/v1/mail/folders/${ids[0]}?recursive=true&force=true`, { token: A });
    assert(d.status === 200 && d.json?.folders === 3, `recursive → ${d.status} ${d.text.slice(0, 200)}`);
    const left = ((await http('GET', '/api/v1/mail/folders', { token: A })).json ?? []).filter((x) => ids.includes(x.id));
    assert(left.length === 0, `left over: ${left.map((x) => x.name).join(', ')}`);
    return 'non-recursive delete re-parented 1, recursive delete removed 3 folders, no orphans';
  });

  await check('webmail: READ_ONLY on the shared mailbox — reads ok, every write 403 READ_ONLY', async () => {
    const g = await http('POST', `/api/v1/admin/shared-mailboxes/${state.shared.id}/permissions`, { token: admin, body: { userId: state.users.b.id, permissions: ['READ_ONLY'] } });
    assert(g.status === 201, `grant ${g.status} ${g.text.slice(0, 200)}`);
    try {
      const entry = (await listOf(B)).find((e) => e.ref === sharedRef);
      assert(entry?.readOnly === true, `B entry ${JSON.stringify(entry)}`);
      const f = await http('GET', `${S}/folders`, { token: B });
      assert(f.status === 200 && f.json.some((x) => x.id === folderId), `B folders ${f.status}`);
      const inbox = f.json.find((x) => x.name === 'INBOX');
      const writes = [
        ['POST', `${S}/folders`, { name: 'nope' }],
        ['PATCH', `${S}/folders/${folderId}`, { name: 'nope' }],
        ['DELETE', `${S}/folders/${folderId}?force=true`, undefined],
        ['POST', `${S}/folders/${inbox.id}/empty`, {}],
        ['POST', `${S}/messages/bulk`, { ids: ['x'], action: 'read' }],
        ['PATCH', `${S}/messages/x`, { read: true }],
        ['DELETE', `${S}/messages/x`, undefined],
      ];
      for (const [method, path, body] of writes) {
        const r = await http(method, path, { token: B, body });
        assert(r.status === 403 && r.json?.code === 'READ_ONLY', `${method} ${path} → ${r.status} ${r.json?.code}`);
      }
      return `${writes.length} write routes → 403 READ_ONLY`;
    } finally {
      await http('DELETE', `/api/v1/admin/shared-mailboxes/${state.shared.id}/permissions/${state.users.b.id}`, { token: admin });
    }
  });

  await check('webmail: READ_ONLY delegation — B reads A\'s mailbox, writes 403', async () => {
    const g = await http('POST', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates`, { token: admin, body: { granteeId: state.users.b.id, permission: 'READ_ONLY' } });
    assert(g.status === 200 || g.status === 201, `delegate ${g.status} ${g.text.slice(0, 200)}`);
    try {
      const entry = (await listOf(B)).find((e) => e.kind === 'delegated' && e.email === state.users.a.email.toLowerCase());
      assert(entry?.readOnly === true && entry.ref === `delegated:${entry.id}`, `entry ${JSON.stringify(entry)}`);
      const D = `/api/v1/mail/delegated-mailboxes/${entry.id}`;
      const f = await http('GET', `${D}/folders`, { token: B });
      assert(f.status === 200 && f.json.some((x) => x.name === 'INBOX'), `folders ${f.status}`);
      const w = await http('POST', `${D}/folders`, { token: B, body: { name: 'nope' } });
      assert(w.status === 403 && w.json?.code === 'READ_ONLY', `create → ${w.status}`);
      const h = await http('PATCH', vis(entry.ref), { token: B, body: { hidden: true } });
      assert(h.status === 200, `hide delegated ${h.status}`);
      await http('PATCH', vis(entry.ref), { token: B, body: { hidden: false } });
      return `${entry.ref}: read ok, write 403, hide ok`;
    } finally {
      await http('DELETE', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates/${state.users.b.id}`, { token: admin });
    }
  });

  // 9.4 live updates: writes from another client reach the open webmail stream
  const live = await openSse(A);
  try {
    await check('webmail: live stream gets a contacts event when a contact is created', async () => {
      const r = await http('POST', '/api/v1/contacts', { token: A, body: { displayName: `E2E Live ${Date.now()}`, email: `live-${Date.now()}@example.test` } });
      assert(r.status === 201 || r.status === 200, `create contact ${r.status} ${r.text.slice(0, 200)}`);
      const ev = await live.next('contacts', { match: (d) => d?.action === 'create' });
      if (r.json?.id) await http('DELETE', `/api/v1/contacts/${r.json.id}`, { token: A });
      return `contacts ${JSON.stringify(ev)}`;
    });

    await check('webmail: live stream gets a calendar event when an event is created and changed', async () => {
      const cals = await http('GET', '/api/v1/calendar', { token: A });
      const calId = (Array.isArray(cals.json) ? cals.json : []).find((x) => !x.shared)?.id;
      assert(calId, `no calendar: ${cals.status}`);
      const start = new Date(Date.now() + 3 * 864e5);
      const ev = await http('POST', '/api/v1/calendar/events', { token: A, body: {
        calendarId: calId, summary: `E2E Live ${Date.now()}`, dtStart: start.toISOString(), dtEnd: new Date(start.getTime() + 36e5).toISOString(),
      } });
      assert(ev.status === 201, `create event ${ev.status} ${ev.text.slice(0, 200)}`);
      const created = await live.next('calendar', { match: (d) => d?.action === 'create' && d?.ids?.includes(ev.json.id) });
      const up = await http('PUT', `/api/v1/calendar/events/${ev.json.id}`, { token: A, body: { summary: 'E2E Live renamed' } });
      assert(up.status === 200, `update event ${up.status}`);
      await live.next('calendar', { match: (d) => d?.action === 'update' && d?.ids?.includes(ev.json.id) });
      await http('DELETE', `/api/v1/calendar/events/${ev.json.id}`, { token: A });
      return `create + update (${JSON.stringify(created.calendarIds)})`;
    });

    await check('webmail: live stream gets a mailbox event for a folder created in the shared mailbox', async () => {
      const inbox = ((await http('GET', `${S}/folders`, { token: A })).json ?? []).find((x) => x.name === 'INBOX');
      const cr = await http('POST', `${S}/folders`, { token: A, body: { name: `E2E-Live-${Date.now()}`, parentId: inbox?.id } });
      assert(cr.status === 201, `create ${cr.status}`);
      const ev = await live.next('mailbox', { match: (d) => d?.mailbox === sharedRef && d?.kinds?.includes('folders') });
      await http('DELETE', `${S}/folders/${cr.json.id}?force=true`, { token: A });
      return JSON.stringify(ev);
    });
  } finally {
    live.close();
  }

  await check('webmail: installable — /manifest.webmanifest from the branding, service worker served uncached', async () => {
    const m = await http('GET', '/manifest.webmanifest');
    assert(m.status === 200 && /manifest\+json/.test(m.headers.get('content-type') ?? ''), `manifest ${m.status}`);
    assert(m.json?.name && m.json.start_url === '/mail' && m.json.icons?.length, `manifest ${m.text.slice(0, 200)}`);
    // 9.4: PNG icons 192 + 512 (built-in or scaled from a PNG favicon), each one served as a PNG
    const sizes = new Set(m.json.icons.filter((i) => i.type === 'image/png').map((i) => i.sizes));
    assert(sizes.has('192x192') && sizes.has('512x512'), `icon sizes ${[...sizes].join(',')}`);
    for (const icon of m.json.icons) {
      const r = await fetch(new URL(icon.src, BASE));
      const bytes = Buffer.from(await r.arrayBuffer());
      assert(r.status === 200 && bytes.subarray(1, 4).toString('latin1') === 'PNG', `icon ${icon.src} → ${r.status}`);
    }
    const sw = await http('GET', '/sw.js');
    assert(sw.status === 200 && /no-cache/.test(sw.headers.get('cache-control') ?? ''), `sw.js ${sw.status} ${sw.headers.get('cache-control')}`);
    return `${m.json.name}; sw.js no-cache`;
  });

  await check('webmail: access revoked → shared mailbox API 403 NO_ACCESS for B', async () => {
    const r = await http('GET', `${S}/folders`, { token: B });
    assert(r.status === 403 && r.json?.code === 'NO_ACCESS', `${r.status} ${r.json?.code}`);
    if (folderId) {
      const d = await http('DELETE', `${S}/folders/${folderId}?force=true`, { token: A });
      assert(d.status === 200, `cleanup delete ${d.status}`);
    }
    return 'revoked → 403; test folder removed';
  });

  // 9.4: inline compose — a draft in its own window (/compose/<id>) is loaded and saved
  // through the server-draft API; the quote marker (folding of long quotes) survives a save.
  await check('webmail: compose window round trip — /compose/<id> serves the webmail, GET loads the draft, PUT replaces it', async () => {
    const quote = '<blockquote data-cm-quote=""><hr><p><strong>Von:</strong> e2e@example.test</p><p>alt</p></blockquote>';
    // 9.4: importance (Importance / X-Priority headers) and a table travel with the draft
    const table = '<table style="border-collapse: collapse"><tbody><tr><th>A</th></tr><tr><td>1</td></tr></tbody></table>';
    const body = { to: [state.users.b.email], cc: [], bcc: [], subject: `E2E-Compose-${Date.now()}`, bodyHtml: `<p>neu</p>${table}${quote}`, bodyText: 'neu', keepAttachmentIds: [], importance: 'high' };
    const mk = await http('POST', '/api/v1/mail/drafts', { token: A, body });
    assert(mk.status === 201 && mk.json?.id, `create ${mk.status} ${mk.text.slice(0, 200)}`);
    let id = mk.json.id;
    try {
      const page = await http('GET', `/compose/${encodeURIComponent(id)}`);
      assert(page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? ''), `/compose/<id> → ${page.status} ${page.headers.get('content-type')}`);
      const got = await http('GET', `/api/v1/mail/drafts/${id}`, { token: A });
      assert(got.status === 200 && got.json.subject === body.subject && got.json.to.includes(state.users.b.email), `load ${got.status} ${got.text.slice(0, 200)}`);
      assert(/data-cm-quote/.test(got.json.bodyHtml), 'quote marker lost');
      assert(got.json.importance === 'high', `importance ${got.json.importance}`);
      assert(/<table[\s>]/.test(got.json.bodyHtml) && /<td>1<\/td>/.test(got.json.bodyHtml), 'table lost');
      const foreign = await http('GET', `/api/v1/mail/drafts/${id}`, { token: B });
      assert(foreign.status === 404, `other user loads the draft → ${foreign.status}`);
      const put = await http('PUT', `/api/v1/mail/drafts/${id}`, { token: A, body: { ...body, bodyText: 'neu 2', importance: 'low' } });
      assert(put.status === 200 && put.json?.id && put.json.id !== id && put.json.supersedes === id, `replace ${put.status} ${put.text.slice(0, 200)}`);
      const old = id;
      id = put.json.id;
      const stale = await http('GET', `/api/v1/mail/drafts/${old}`, { token: A });
      assert(stale.status === 404, `replaced version still loadable → ${stale.status}`);
      const low = await http('GET', `/api/v1/mail/drafts/${id}`, { token: A });
      assert(low.json?.importance === 'low', `importance after replace ${low.json?.importance}`);
    } finally {
      const del = await http('DELETE', `/api/v1/mail/drafts/${id}`, { token: A });
      assert(del.status === 200, `delete ${del.status}`);
    }
    return 'window page 200, draft loaded (quote marker, table, importance kept), 404 for others, replaced + old id gone, deleted';
  });

  // 9.4: named signatures with defaults per identity (own + shared mailbox)
  await check('webmail: signatures — create, defaults per identity, legacy /user/signature mirror, delete', async () => {
    const mk = await http('POST', '/api/v1/user/signatures', { token: A, body: { name: `E2E-${Date.now()}`, html: '<p>E2E Gruß</p>' } });
    assert(mk.status === 201 && mk.json?.id, `create ${mk.status} ${mk.text.slice(0, 200)}`);
    const id = mk.json.id;
    try {
      const d = await http('PATCH', '/api/v1/user/preferences', { token: A, body: { preferences: { signatures: { defaults: { own: { newId: id, replyId: null }, [sharedRef]: { newId: id, replyId: id } } } } } });
      assert(d.status === 200, `defaults ${d.status} ${d.text.slice(0, 200)}`);
      const list = await http('GET', '/api/v1/user/signatures', { token: A });
      assert(list.json.signatures.some((s) => s.id === id) && list.json.defaults[sharedRef]?.replyId === id, 'defaults not stored');
      const legacy = await http('GET', '/api/v1/user/signature', { token: A });
      assert(legacy.json.signature === '<p>E2E Gruß</p>' && legacy.json.autoNew === true, `legacy mirror ${JSON.stringify(legacy.json).slice(0, 200)}`);
      const foreign = await http('PUT', `/api/v1/user/signatures/${id}`, { token: B, body: { name: 'x' } });
      assert(foreign.status === 404, `other user edits → ${foreign.status}`);
    } finally {
      const del = await http('DELETE', `/api/v1/user/signatures/${id}`, { token: A });
      assert(del.status === 200, `delete ${del.status}`);
    }
    const after = await http('GET', '/api/v1/user/signatures', { token: A });
    assert(!after.json.defaults[sharedRef], 'defaults still point at the deleted signature');
    return 'created, defaults own + shared, legacy mirror, 404 for others, deleted + defaults cleared';
  });
}
