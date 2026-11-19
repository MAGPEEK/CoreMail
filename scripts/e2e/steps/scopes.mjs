// Step: admin management scopes (9.5, docs/rbac.md).
// A second domain with one mailbox is created; a HELP_DESK admin limited to the
// e2e domain sees and changes only that domain: other-domain mailboxes are 404
// (like unknown ids), server-wide routes 403, its own scope cannot be widened.
// The scope change is audited and ends the admin's sessions. Everything created
// here is removed at the end (the domain only after its admin scope is gone).
import { randomBytes } from 'node:crypto';
import { check, assert, creds, http, session, setCred, DOMAIN } from '../lib.mjs';

const OTHER = `scope-b.${DOMAIN}`;

export async function run(state) {
  const c = creds();
  if (!c.scopeHd) setCred('scopeHd', `Shd-${randomBytes(10).toString('hex')}`);
  const pass = creds().scopeHd;
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const s = (state.scopes ??= {});

  await check('scopes: second domain with one mailbox, scoped HELP_DESK admin', async () => {
    const doms = (await http('GET', '/api/v1/admin/domains?limit=200', { token: admin })).json?.domains ?? [];
    s.otherDomainId = doms.find((d) => d.name === OTHER)?.id;
    if (!s.otherDomainId) {
      const d = await http('POST', '/api/v1/admin/domains', { token: admin, body: { name: OTHER } });
      assert(d.status === 201, `domain ${d.status} ${d.text.slice(0, 200)}`);
      s.otherDomainId = d.json.id;
    }
    const list = (await http('GET', '/api/v1/admin/mailboxes', { token: admin })).json ?? [];
    const ensure = async (email, role, domainId) => {
      const found = list.find((u) => u.email === email);
      if (found) return found.id;
      const r = await http('POST', '/api/v1/admin/mailboxes', { token: admin, body: { email, displayName: email, password: pass, role, domainId } });
      assert(r.status === 201, `create ${email}: ${r.status} ${r.text.slice(0, 200)}`);
      return r.json.id;
    };
    s.otherUserId = await ensure(`other@${OTHER}`, 'USER', s.otherDomainId);
    s.hdId = await ensure(`scopehd@${DOMAIN}`, 'HELP_DESK', state.domainId);
    const r = await http('PUT', `/api/v1/admin/organisation/role-assignments/${s.hdId}/scope`, { token: admin, body: { domainIds: [state.domainId] } });
    assert(r.status === 200 && r.json?.scope?.kind === 'domains', `scope ${r.status} ${r.text.slice(0, 200)}`);
    return `scope ${r.json.scope.domains.map((d) => d.name).join(',')}`;
  });

  delete state.sessions?.scopeHd;
  const hd = await session(state, 'scopeHd', `scopehd@${DOMAIN}`, pass);

  await check('scopes: GET /admin/me/permissions reports the scope, no server-wide areas', async () => {
    const r = await http('GET', '/api/v1/admin/me/permissions', { token: hd });
    assert(r.status === 200, `${r.status}`);
    assert(r.json.scope?.kind === 'domains' && r.json.scope.domains.length === 1 && r.json.scope.domains[0].name === DOMAIN, JSON.stringify(r.json.scope));
    assert(!r.json.areas.servers && !r.json.areas.organisation, JSON.stringify(r.json.areas));
    return JSON.stringify(r.json.areas);
  });

  await check('scopes: mailbox list holds only the own domain', async () => {
    const r = await http('GET', '/api/v1/admin/mailboxes', { token: hd });
    assert(r.status === 200 && Array.isArray(r.json), `${r.status}`);
    const foreign = r.json.filter((u) => !u.email.endsWith(`@${DOMAIN}`));
    assert(foreign.length === 0, `foreign: ${foreign.map((u) => u.email).join(',')}`);
    return `${r.json.length} mailboxes`;
  });

  await check('scopes: other domain answers 404 exactly like an unknown id', async () => {
    const other = await http('GET', `/api/v1/admin/mailboxes/${s.otherUserId}`, { token: hd });
    const unknown = await http('GET', '/api/v1/admin/mailboxes/c000000000000000000000000', { token: hd });
    assert(other.status === 404 && other.text === unknown.text, `${other.status} ${other.text} vs ${unknown.text}`);
    const reset = await http('PUT', `/api/v1/admin/mailboxes/${s.otherUserId}`, { token: hd, body: { active: false } });
    assert(reset.status === 404, `disable other-domain user: ${reset.status}`);
    return 'GET + PUT 404';
  });

  await check('scopes: HELP_DESK action inside the scope still works', async () => {
    const r = await http('PUT', `/api/v1/admin/mailboxes/${state.users.a.id}`, { token: hd, body: { active: true } });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    return 'enable own-domain USER';
  });

  await check('scopes: grantees of another domain are redacted in detail views (w3)', async () => {
    const grant = await http('POST', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates`, {
      token: admin, body: { granteeId: s.otherUserId, permission: 'READ_ONLY', autoMap: false },
    });
    assert(grant.status === 201, `grant ${grant.status} ${grant.text.slice(0, 200)}`);
    try {
      const scoped = await http('GET', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates`, { token: hd });
      assert(scoped.status === 200, `${scoped.status}`);
      assert(!scoped.text.includes(OTHER), `other domain visible: ${scoped.text.slice(0, 300)}`);
      const row = scoped.json.find((d) => d.granteeId === s.otherUserId);
      assert(row?.grantee?.email === '(andere Domain)', JSON.stringify(row));
      const org = await http('GET', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates`, { token: admin });
      assert(org.text.includes(`other@${OTHER}`), 'organisation-wide admins see the address');
      return 'scoped: "(andere Domain)", organisation-wide: address';
    } finally {
      await http('DELETE', `/api/v1/admin/mailboxes/${state.users.a.id}/delegates/${s.otherUserId}`, { token: admin });
    }
  });

  await check('scopes: server-wide routes and scope changes are refused', async () => {
    const srv = await http('GET', '/api/v1/admin/servers/settings', { token: hd });
    const own = await http('PUT', `/api/v1/admin/organisation/role-assignments/${s.hdId}/scope`, { token: hd, body: { domainIds: [] } });
    assert(srv.status === 403 && own.status === 403, `servers ${srv.status}, own scope ${own.status}`);
    return 'servers 403, own scope 403';
  });

  await check('scopes: change audited (user.role.scope)', async () => {
    const r = await http('GET', `/api/v1/admin/audit-log?action=user.role.scope&targetId=${s.hdId}`, { token: admin });
    assert(r.status === 200 && (r.json?.entries ?? []).length > 0, `${r.status} ${r.text.slice(0, 200)}`);
    return `${r.json.entries.length} entries`;
  });

  await check('scopes: a domain that still scopes an admin cannot be deleted; cleanup', async () => {
    const del = await http('DELETE', `/api/v1/admin/mailboxes/${s.otherUserId}`, { token: admin });
    assert(del.status === 200, `delete other user ${del.status}`);
    const widen = await http('PUT', `/api/v1/admin/organisation/role-assignments/${s.hdId}/scope`, { token: admin, body: { domainIds: [state.domainId, s.otherDomainId] } });
    assert(widen.status === 200, `widen ${widen.status}`);
    // the scope change ends the scoped admin's open web/API session at once
    const stale = await http('GET', '/api/v1/admin/me/permissions', { token: hd });
    assert(stale.status === 401, `old session after the scope change: ${stale.status}`);
    delete state.sessions?.scopeHd;
    const refused = await http('DELETE', `/api/v1/admin/domains/${s.otherDomainId}`, { token: admin });
    assert(refused.status === 409 && refused.json?.code === 'DOMAIN_SCOPES_ADMINS', `${refused.status} ${refused.text}`);
    const gone = await http('DELETE', `/api/v1/admin/mailboxes/${s.hdId}`, { token: admin });
    assert(gone.status === 200, `delete scoped admin ${gone.status}`);
    const dom = await http('DELETE', `/api/v1/admin/domains/${s.otherDomainId}`, { token: admin });
    assert(dom.status === 200, `delete domain ${dom.status} ${dom.text}`);
    delete state.scopes;
    return 'domain delete 409 while scoped, then removed';
  });
}
