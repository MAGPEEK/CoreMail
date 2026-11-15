// Step 2: users (API + admin CLI), shared mailbox, HELP_DESK RBAC.
import { execFileSync } from 'node:child_process';
import { check, assert, http, creds, DOMAIN, CONTAINER, session } from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  state.users ??= {};
  const want = {
    a: { email: `alice@${DOMAIN}`, displayName: 'Alice E2E', password: c.userA, role: 'USER' },
    helpdesk: { email: `helpdesk@${DOMAIN}`, displayName: 'Help Desk E2E', password: c.helpdesk, role: 'HELP_DESK' },
  };
  const list = async () => (await http('GET', '/api/v1/admin/mailboxes', { token: admin })).json ?? [];

  for (const [key, u] of Object.entries(want)) {
    await check(`users: create ${key} (${u.role}) via admin API`, async () => {
      const existing = (await list()).find((x) => x.email === u.email);
      if (existing) { state.users[key] = { id: existing.id, email: u.email }; return 'already exists'; }
      const r = await http('POST', '/api/v1/admin/mailboxes', { token: admin, body: { ...u, domainId: state.domainId } });
      assert(r.status === 201, `${r.status} ${r.text.slice(0, 300)}`);
      state.users[key] = { id: r.json.id, email: u.email };
      return `id ${r.json.id}`;
    });
  }

  await check('users: create B via admin CLI (docker exec coremail …)', async () => {
    const email = `bob@${DOMAIN}`;
    const existing = (await list()).find((x) => x.email === email);
    if (!existing) {
      const out = execFileSync('docker', ['exec', '-e', `COREMAIL_TOKEN=${admin}`, CONTAINER,
        'coremail', 'user', 'create', email, '--name', 'Bob E2E', '--password', c.userB], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('  cli:', out.trim().split('\n').slice(0, 3).join(' | '));
    }
    const b = (await list()).find((x) => x.email === email);
    assert(b, 'user B not listed after CLI create');
    state.users.b = { id: b.id, email };
    const cl = execFileSync('docker', ['exec', '-e', `COREMAIL_TOKEN=${admin}`, CONTAINER, 'coremail', 'user', 'list'], { encoding: 'utf8' });
    assert(cl.includes(email), 'CLI user list does not show B');
    return 'created + listed via CLI';
  });

  await check('users: shared mailbox + FULL_ACCESS/SEND_AS for A', async () => {
    const email = `team@${DOMAIN}`;
    let sm = (await http('GET', '/api/v1/admin/shared-mailboxes', { token: admin })).json?.items?.find((x) => x.email === email);
    if (!sm) {
      const r = await http('POST', '/api/v1/admin/shared-mailboxes', { token: admin, body: { email, displayName: 'Team E2E', domainId: state.domainId } });
      assert(r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
      sm = r.json;
    }
    const p = await http('POST', `/api/v1/admin/shared-mailboxes/${sm.id}/permissions`, { token: admin, body: { userId: state.users.a.id, permissions: ['FULL_ACCESS', 'SEND_AS'] } });
    assert(p.status === 201, `perm ${p.status} ${p.text}`);
    state.shared = { id: sm.id, email };
    return `shared ${email}`;
  });

  // ── RBAC (HELP_DESK) ───────────────────────────────────────────────────────
  const hd = await session(state, 'helpdesk', want.helpdesk.email, c.helpdesk);
  await check('rbac: HELP_DESK GET /admin/servers/settings → 403', async () => {
    const r = await http('GET', '/api/v1/admin/servers/settings', { token: hd });
    assert(r.status === 403, `got ${r.status}`);
    return '403';
  });
  await check('rbac: HELP_DESK PUT /admin/smtp-config/settings → 403', async () => {
    const r = await http('PUT', '/api/v1/admin/smtp-config/settings', { token: hd, body: { maxRecipients: 5 } });
    assert(r.status === 403, `got ${r.status}`);
    return '403';
  });
  await check('rbac: HELP_DESK may reset a USER password', async () => {
    const r = await http('PUT', `/api/v1/admin/mailboxes/${state.users.b.id}`, { token: hd, body: { password: c.userB } });
    assert(r.status === 200, `got ${r.status} ${r.text}`);
    return '200';
  });
  await check('rbac: HELP_DESK may not change a role / reset an admin password', async () => {
    const r1 = await http('PUT', `/api/v1/admin/mailboxes/${state.users.b.id}`, { token: hd, body: { role: 'ORGANIZATION_MANAGEMENT' } });
    const adminId = (await list()).find((x) => x.email === state.adminEmail)?.id;
    const r2 = await http('PUT', `/api/v1/admin/mailboxes/${adminId}`, { token: hd, body: { password: 'Pwned-123456789' } });
    assert(r1.status === 403 && r2.status === 403, `role change ${r1.status}, admin pw ${r2.status}`);
    return 'both 403';
  });
  await check('rbac: HELP_DESK may not create users', async () => {
    const r = await http('POST', '/api/v1/admin/mailboxes', { token: hd, body: { email: `x@${DOMAIN}`, displayName: 'x', password: 'Xx-123456789012', domainId: state.domainId } });
    assert(r.status === 403, `got ${r.status}`);
    return '403';
  });
  await check('rbac: /user/me areas for HELP_DESK vs USER', async () => {
    const me = await http('GET', '/api/v1/user/me', { token: hd });
    const a = await session(state, 'a', want.a.email, c.userA);
    const meA = await http('GET', '/api/v1/user/me', { token: a });
    const r = await http('GET', '/api/v1/admin/mailboxes', { token: a });
    assert(me.status === 200 && meA.status === 200, 'me failed');
    assert(r.status === 403, `USER on admin API: ${r.status}`);
    assert(me.json?.adminAreas?.recipients === 'read' && !me.json?.adminAreas?.servers, `helpdesk adminAreas ${JSON.stringify(me.json?.adminAreas)}`);
    return `helpdesk adminAreas=${JSON.stringify(me.json?.adminAreas)}; USER admin → 403`;
  });
  // the session cache for B is populated after the HELP_DESK reset (it revoked sessions)
  delete state.sessions?.b;
}
