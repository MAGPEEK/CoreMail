// Step: webmail — shared / delegated mailboxes in the mail view (9.3), API level:
// folder-pane list + hide/show persistence (/user/accessible-mailboxes), folder and
// message operations on a shared mailbox with FULL_ACCESS, READ_ONLY → every write
// 403 READ_ONLY (shared + delegated), SEND_AS-free users see nothing. Grants made
// here are removed again at the end.
import { check, assert, creds, http, session } from '../lib.mjs';

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

  await check('webmail: access revoked → shared mailbox API 403 NO_ACCESS for B', async () => {
    const r = await http('GET', `${S}/folders`, { token: B });
    assert(r.status === 403 && r.json?.code === 'NO_ACCESS', `${r.status} ${r.json?.code}`);
    if (folderId) {
      const d = await http('DELETE', `${S}/folders/${folderId}?force=true`, { token: A });
      assert(d.status === 200, `cleanup delete ${d.status}`);
    }
    return 'revoked → 403; test folder removed';
  });
}
