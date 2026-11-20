/**
 * Throwaway mock of the admin API for looking at the BCP edit panels in a real browser
 * (no database, no containers): `node dev/mock-api.mjs`, then `pnpm dev` in the same
 * package. Listens on 3000 (/api) and 3003 (/auth) — the ports the Vite dev proxy uses.
 * Everything lives in memory; PUTs echo/merge the body. Sign-in is automatic: /auth/refresh
 * always hands out an access token for an organisation admin.
 */
import { createServer } from 'node:http';

const DOMAIN = { id: 'd1', name: 'example.test', active: true, primary: true, dkimSelector: 'coremail', createdAt: '2026-01-01T00:00:00Z', _count: { users: 3 } };
const USERS = [
  { id: 'u1', email: 'anna@example.test', displayName: 'Anna Beispiel', role: 'USER', active: true, quotaBytes: 5 * 2 ** 30, usedBytes: 1.2 * 2 ** 30, domainId: 'd1', createdAt: '2026-01-02T00:00:00Z', lastLoginAt: null, quotaWarningBytes: null, quotaProhibitSendBytes: null },
  { id: 'u2', email: 'ben@example.test', displayName: 'Ben Muster', role: 'USER', active: true, quotaBytes: 5 * 2 ** 30, usedBytes: 2 ** 20, domainId: 'd1', createdAt: '2026-01-03T00:00:00Z', lastLoginAt: null },
];
const SHARED = [
  { id: 's1', email: 'team@example.test', displayName: 'Team-Postfach', domainId: 'd1', quotaBytes: 2 ** 30, usedBytes: 0, active: true, createdAt: '2026-01-04T00:00:00Z', permissions: [] },
];

const FOLDERS = [
  { id: 'f-inbox', name: 'INBOX', parentId: null }, { id: 'f-sent', name: 'Sent', parentId: null },
  { id: 'f-drafts', name: 'Drafts', parentId: null }, { id: 'f-trash', name: 'Trash', parentId: null },
];
for (let i = 1; i <= 196; i += 1) FOLDERS.push({ id: `f-${i}`, name: `Projekt ${String(i).padStart(3, '0')}`, parentId: i % 7 === 0 ? 'f-inbox' : null });

const SYSTEM = (id) => ({ granteeKey: id, user: null, rights: 0, role: 'none', applyToSubfolders: false });
const folderEntries = (id) => (id === 'f-inbox'
  ? [{ granteeKey: 'default', user: null, rights: 0, role: 'none', applyToSubfolders: false },
     { granteeKey: 'anonymous', user: null, rights: 0, role: 'none', applyToSubfolders: false, fixed: true },
     { granteeKey: 'user:u2', user: { id: 'u2', email: 'ben@example.test', displayName: 'Ben Muster' }, rights: 0x47b, role: 'editor', applyToSubfolders: true }]
  : [SYSTEM('default'), { ...SYSTEM('anonymous'), fixed: true }]);
const folderOverview = (grants) => FOLDERS.map((f) => ({ ...f, entries: grants ? folderEntries(f.id) : [SYSTEM('default'), { ...SYSTEM('anonymous'), fixed: true }] }));

const PROTOCOLS = ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'];
const FEATURES = ['calendar', 'contacts', 'tasks', 'notes', 'rules', 'signatures', 'categories', 'recoverItems', 'changePassword', 'themes', 'externalClients', 'appPasswords', 'sharedMailboxes'];
const record = (keys, v) => Object.fromEntries(keys.map((k) => [k, v]));
const protocolView = (level, id) => ({
  level, id, protocols: PROTOCOLS, settings: record(PROTOCOLS, level === 'global' ? 'on' : 'inherit'),
  inherited: record(PROTOCOLS, true), inheritedFrom: record(PROTOCOLS, 'server'), effective: record(PROTOCOLS, true),
});
const policyView = (level, id) => ({
  level, id, features: FEATURES,
  settings: { features: record(FEATURES, 'inherit'), content: { blockedExtensions: null, downloadOnlyExtensions: null, maxUploadMb: null, externalImages: null } },
  inherited: { features: record(FEATURES, true), content: { blockedExtensions: ['exe'], downloadOnlyExtensions: [], maxUploadMb: 25, externalImages: 'ask' } },
  effective: { features: record(FEATURES, true), content: { blockedExtensions: ['exe'], downloadOnlyExtensions: [], maxUploadMb: 25, externalImages: 'ask' } },
  sources: { features: record(FEATURES, 'default'), content: { blockedExtensions: 'default', downloadOnlyExtensions: 'default', maxUploadMb: 'default', externalImages: 'default' } },
});
const mailFlow = () => ({ hiddenFromGal: false, forwardTo: null, forwardKeepCopy: false, acceptFrom: [], rejectFrom: [], maxReceiveSizeMb: null, maxSendSizeMb: null, maxRecipients: null });

const jwt = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86_400 })}.x`;
};

/** MOCK_NO_GRANTS=1 answers the folder overview without any grant (empty state of the folder list). */
const grants = process.env['MOCK_NO_GRANTS'] !== '1';
const state = {
  users: structuredClone(USERS), shared: structuredClone(SHARED), domain: structuredClone(DOMAIN),
  mcp: { enabled: false, allowedIps: [] },
  mcpTokens: [{
    id: 't0', userId: 'me', name: 'Notebook', prefix: 'cm_mcp_Ab12Cd', mode: 'read', mfaVerified: true,
    expiresAt: '2027-02-01T00:00:00Z', lastUsedAt: '2026-11-19T09:12:00Z', lastUsedIp: '192.0.2.10',
    createdAt: '2026-11-01T00:00:00Z', revokedAt: null, revokedReason: null, status: 'active', owner: 'admin@example.test',
  }],
};

function route(method, url, body) {
  const path = url.split('?')[0];
  let m;
  if (path === '/auth/refresh') return { accessToken: jwt() };
  if (path === '/admin/me/permissions') {
    const areas = Object.fromEntries(['dashboard', 'organisation', 'identity', 'servers', 'recipients', 'domains', 'hygiene', 'compliance'].map((a) => [a, 'write']));
    return { role: 'ORGANIZATION_MANAGEMENT', areas, scope: { kind: 'organisation' }, mfaVerified: true };
  }
  if (path === '/admin/mailboxes') return state.users;
  if ((m = path.match(/^\/admin\/mailboxes\/([^/]+)$/))) {
    const u = state.users.find((x) => x.id === m[1]);
    if (method === 'PUT') { Object.assign(u, body); return u; }
    return u;
  }
  if (path === '/admin/domains') return { domains: [state.domain], total: 1, page: 1, limit: 200 };
  if ((m = path.match(/^\/admin\/domains\/([^/]+)$/)) && method === 'PUT') { Object.assign(state.domain, body); return state.domain; }
  if (path === '/admin/shared-mailboxes') return { items: state.shared, total: state.shared.length };
  if ((m = path.match(/^\/admin\/shared-mailboxes\/([^/]+)$/)) && method === 'PUT') { Object.assign(state.shared[0], body); return state.shared[0]; }
  if (/\/folder-permissions$/.test(path)) return folderOverview(grants);
  if ((m = path.match(/\/folders\/([^/]+)\/permissions$/))) {
    const id = decodeURIComponent(m[1]);
    const f = FOLDERS.find((x) => x.id === id);
    return { folderId: id, folderName: f?.name ?? id, entries: folderEntries(id), inherited: [] };
  }
  if (/\/aliases$/.test(path)) return [];
  if (/\/delegates$/.test(path)) return [];
  if (/\/mail-flow$/.test(path)) return method === 'PUT' ? { ...mailFlow(), ...body } : mailFlow();
  if (path.startsWith('/admin/protocol-access/')) return protocolView(path.includes('/users/') ? 'user' : 'domain', 'x');
  if (path.startsWith('/admin/webmail-policies/')) return policyView(path.includes('/users/') ? 'user' : 'domain', 'x');
  // 10.3: MCP interface page
  if (path === '/admin/mcp/settings') {
    if (method === 'PUT') Object.assign(state.mcp, body);
    return {
      enabled: state.mcp.enabled, endpointUrl: 'https://mail.example.test/mcp', allowedIps: state.mcp.allowedIps, openSessions: 0,
      canManage: true, canSeeAllTokens: true, canCreateWriteTokens: true,
      limits: { tokenDefaultDays: 90, tokenMaxDays: 365, tokensPerAdmin: 20, toolCallsPerMinute: 60 },
    };
  }
  if (path === '/admin/mcp/tokens' && method === 'POST') {
    const id = `t${state.mcpTokens.length + 1}`;
    const token = `cm_mcp_${'x'.repeat(43)}`;
    const now = new Date().toISOString();
    const row = { id, userId: 'me', name: body.name, prefix: token.slice(0, 13), mode: body.mode, mfaVerified: true,
      expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString(), lastUsedAt: null, lastUsedIp: null,
      createdAt: now, revokedAt: null, revokedReason: null, status: 'active', owner: 'admin@example.test' };
    state.mcpTokens.push(row);
    return { ...row, token };
  }
  if (path === '/admin/mcp/tokens') return { tokens: state.mcpTokens };
  if ((m = path.match(/^\/admin\/mcp\/tokens\/([^/]+)$/)) && method === 'DELETE') {
    const t = state.mcpTokens.find((x) => x.id === m[1]);
    if (t) Object.assign(t, { status: 'revoked', revokedAt: new Date().toISOString() });
    return { ok: true, revoked: true };
  }
  return {};
}

function serve(port) {
  createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
      const url = req.url ?? '/';
      const path = url.replace(/^\/api\/v1/, '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(route(req.method ?? 'GET', path, body)));
    });
  }).listen(port, () => console.log(`mock api on ${port}`));
}

serve(3000);
serve(3003);
