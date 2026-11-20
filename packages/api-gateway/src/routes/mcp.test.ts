/**
 * Admin MCP interface (10.3) — end-to-end over Express with an in-memory
 * Prisma: the switch (off → 404, sessions end), the BCP token API, bearer
 * auth (401 + WWW-Authenticate, IP lockout), the full MCP handshake
 * (initialize → tools/list → tools/call), read tokens, management scope and
 * redaction through the real admin routes, Origin check, IP allowlist, per-token
 * rate limit, forced admin 2FA, audit entries, and token revocation / expiry /
 * role loss.
 * Run: node --import tsx --test --test-force-exit src/routes/mcp.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';
import { memoryModel, type Row } from '../test-support/memory-model.js';

setTestEnv();
process.env['MCP_RATE_LIMIT_PER_MINUTE'] = '10';
process.env['MAIL_AUTH_IP_MAX_FAILURES'] = '3';
process.env['BACKUP_SERVICE_URL'] = 'http://127.0.0.1:1';
delete process.env['MCP_ALLOWED_ORIGINS'];

const dom = (id: string, name: string, primary: boolean) => ({
  id, name, active: true, primary, dkimSelector: 'coremail', dkimPrivateKey: '-----BEGIN PRIVATE KEY-----SECRET', createdAt: new Date(),
});
const dA = dom('dA', 'a.example', true);
const dB = dom('dB', 'b.example', false);
const user = (id: string, role: string, d: { id: string; name: string }, extra: Row = {}): Row => ({
  id, email: `${id}@${d.name}`, displayName: id, role, active: true, domainId: d.id, passwordHash: 'HASHED-PASSWORD',
  quotaBytes: 1000n, usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null,
  createdAt: new Date(), lastLoginAt: null, mailbox: { id: `mb-${id}`, folders: [] }, ...extra,
});

const db: Record<string, Row[]> = {
  domain: [dA, dB],
  user: [
    user('org', 'ORGANIZATION_MANAGEMENT', dA),
    user('srv', 'SERVER_MANAGEMENT', dA),
    user('rmA', 'RECIPIENT_MANAGEMENT', dA), // scoped to a.example
    user('coA', 'COMPLIANCE_MANAGEMENT', dA), // scoped to a.example
    user('voA', 'VIEW_ONLY_ORG', dA),
    user('lost', 'HYGIENE_MANAGEMENT', dA),
    user('ua1', 'USER', dA),
    user('ub1', 'USER', dB),
  ],
  adminScope: ['rmA', 'coA'].map((u) => ({ id: `sc-${u}`, userId: u, domainId: 'dA', domain: { id: 'dA', name: 'a.example' } })),
  emailAlias: [{
    id: 'alA', address: 'x@a.example', localPart: 'x', description: '', active: true, domainId: 'dA',
    targetUserId: 'ua1', targetSharedId: null, domain: { id: 'dA', name: 'a.example' },
    targetUser: { id: 'ua1', email: 'ua1@a.example', displayName: 'ua1', domainId: 'dA' }, targetShared: null,
  }],
  systemLog: [{
    id: 'trace1', category: 'MAIL_FLOW', timestamp: new Date(), level: 'INFO', message: 'Delivered from ub1@b.example',
    metadata: { sender: 'ub1@b.example', recipient: 'ua1@a.example', status: 'DELIVERED', subject: 'Hello' }, userId: null,
  }],
  mcpToken: [],
  auditLog: [],
  session: [],
  userMfa: [],
  sharedMailbox: [],
  blacklist: [],
};
const settings: Row = {
  id: 'singleton', mcpEnabled: false, mcpAllowedIps: [], publicHostname: 'mail.a.example', useHttps: true, httpPort: 443,
  requireMfaForAdmins: false, auditLogEnabled: true, minPasswordLength: 8,
};

const models: Record<string, Record<string, (...a: unknown[]) => unknown>> = Object.fromEntries(
  Object.entries(db).map(([name, rows]) => [name, memoryModel(rows)]),
);
models['serverSettings'] = {
  findUnique: () => ({ ...settings }),
  upsert: (a) => { Object.assign(settings, (a as { update: Row }).update); return { ...settings }; },
};
models['message'] = { aggregate: () => ({ _sum: { rawSize: 0 } }) };
// MCP tokens embed their owner (the memory model has no relations): a live reference to the user row
const tokenCreate = models['mcpToken']!['create']!;
models['mcpToken']!['create'] = (a) => {
  const q = a as { data: Row; select?: Row };
  const data: Row = { revokedAt: null, revokedReason: null, lastUsedAt: null, lastUsedIp: null, createdAt: new Date(), ...q.data };
  data['user'] = db['user']!.find((u) => u['id'] === data['userId']) ?? null;
  return tokenCreate({ ...q, data });
};
installFakePrisma(models);

const { createFakeRedis } = await import('@coremail/storage/auth/testing');
const g = globalThis as Record<string, unknown>;
g['__mailAuthRedis'] = createFakeRedis();
const counters = new Map<string, number>();
g['__rateLimitRedis'] = {
  async incr(k: string) { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
  async expire() { return 1; },
};
const published: string[] = [];
g['__mcpSettingsPublish'] = (_channel: string, message: string) => { published.push(message); };

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./admin/index.js');
const { createMcpRouter } = await import('../lib/mcp/handler.js');
const { mcpLiveConnections, sessionCount } = await import('../lib/mcp/sessions.js');
const { clearCurrentRoleCache } = await import('../middleware/auth.js');
const { invalidateMcpSettings } = await import('../lib/mcp/settings.js');

const roleOf = (id: string): string => String(db['user']!.find((u) => u['id'] === id)?.['role']);
const jwt = (id: string, mfaVerified = true) => core.signAccessToken({
  sub: id, email: String(db['user']!.find((u) => u['id'] === id)?.['email']),
  role: roleOf(id) as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'dA', sessionId: `${id}-s-${Math.random()}`, mfaVerified,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  mcpLiveConnections.attachInvalidation();
  const app = express();
  app.set('trust proxy', 'loopback'); // lets a test choose its client IP via X-Forwarded-For
  app.use('/mcp', createMcpRouter());
  app.use(express.json());
  mountAdminRoutes(app);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function bcp(actor: string, method: string, path: string, body?: unknown, mfaVerified = true): Promise<{ status: number; json: Row; headers: Headers }> {
  const r = await fetch(`${base}/api/v1/admin${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt(actor, mfaVerified)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json, headers: r.headers };
}

interface McpReply { status: number; json: Row; headers: Headers }
async function post(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<McpReply> {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json, headers: r.headers };
}

let rpcId = 0;
async function initialize(token: string, headers: Record<string, string> = {}): Promise<string> {
  const r = await post(token, {
    jsonrpc: '2.0', id: ++rpcId, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
  }, headers);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sid = r.headers.get('mcp-session-id');
  assert.ok(sid && sid.length >= 32);
  return sid!;
}
const rpc = (token: string, sid: string, method: string, params: Row = {}, headers: Record<string, string> = {}) =>
  post(token, { jsonrpc: '2.0', id: ++rpcId, method, params }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18', ...headers });

interface ToolReply { status: number; isError: boolean; text: string; data: Row & Row[] }
async function callTool(token: string, sid: string, name: string, args: Row = {}): Promise<ToolReply> {
  const r = await rpc(token, sid, 'tools/call', { name, arguments: args });
  const result = r.json['result'] as { content?: Array<{ text: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? JSON.stringify(r.json);
  let data: unknown = {};
  try { data = JSON.parse(text); } catch { /* error text */ }
  return { status: r.status, isError: result?.isError ?? true, text, data: data as Row & Row[] };
}

async function newToken(actor: string, mode: 'read' | 'write', mfaVerified = true): Promise<{ token: string; id: string }> {
  const r = await bcp(actor, 'POST', '/mcp/tokens', { name: `${actor}-${mode}-${Math.random().toString(36).slice(2, 6)}`, mode }, mfaVerified);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { token: String(r.json['token']), id: String(r.json['id']) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const auditRows = (action: string) => db['auditLog']!.filter((a) => a['action'] === action);

// ── switch ────────────────────────────────────────────────────────────────────

test('switch off: /mcp answers 404 for every method, with the body of an unknown path', async () => {
  const p = await post(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(p.status, 404);
  assert.deepEqual(p.json, { error: 'Not found' });
  for (const method of ['GET', 'DELETE']) {
    const r = await fetch(`${base}/mcp`, { method });
    assert.equal(r.status, 404, method);
  }
  assert.equal((await post(`cm_mcp_${'A'.repeat(43)}`, {})).status, 404, 'no token check while off');
});

test('settings: switch + allowlist need servers write; the view depends on the role', async () => {
  assert.equal((await bcp('rmA', 'PUT', '/mcp/settings', { enabled: true })).status, 403, 'scoped recipients admin');
  assert.equal((await bcp('voA', 'PUT', '/mcp/settings', { enabled: true })).status, 403, 'read-only role');
  assert.equal((await bcp('srv', 'PUT', '/mcp/settings', { allowedIps: ['10.0.0.0/33'] })).status, 400, 'invalid CIDR');
  const on = await bcp('srv', 'PUT', '/mcp/settings', { enabled: true, allowedIps: [] });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(settings['mcpEnabled'], true);
  assert.ok(published.includes('{"type":"mcp"}'), 'other instances are told');
  const asRm = await bcp('rmA', 'GET', '/mcp/settings');
  assert.equal(asRm.status, 200);
  assert.equal(asRm.json['enabled'], true);
  assert.equal(asRm.json['endpointUrl'], 'https://mail.a.example/mcp');
  assert.equal(asRm.json['allowedIps'], undefined, 'the allowlist is servers-area information');
  assert.equal(asRm.json['canManage'], false);
  assert.equal(asRm.json['canCreateWriteTokens'], true);
  const asSrv = await bcp('srv', 'GET', '/mcp/settings');
  assert.deepEqual(asSrv.json['allowedIps'], []);
  assert.equal(asSrv.json['canManage'], true);
  assert.equal((await bcp('voA', 'GET', '/mcp/settings')).json['canCreateWriteTokens'], false);
  await settle();
  assert.ok(auditRows('mcp.settings.update').length >= 1);
});

// ── tokens ────────────────────────────────────────────────────────────────────

test('tokens: shown once, stored as sha256 only, listed without secrets; limits per role', async () => {
  const created = await bcp('org', 'POST', '/mcp/tokens', { name: 'Laptop', mode: 'write', expiresInDays: 30 });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const token = String(created.json['token']);
  assert.match(token, /^cm_mcp_[A-Za-z0-9_-]{43}$/);
  const row = db['mcpToken']!.find((t) => t['id'] === created.json['id'])!;
  assert.equal(row['tokenHash'], createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify({ ...row, user: undefined }).includes(token), 'the token itself is never stored');
  assert.equal(row['mfaVerified'], true);
  const days = (new Date(row['expiresAt'] as Date).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30);

  const list = await bcp('org', 'GET', '/mcp/tokens');
  const listed = (list.json['tokens'] as Row[]).find((t) => t['id'] === created.json['id'])!;
  assert.equal(listed['prefix'], token.slice(0, 13));
  assert.equal(listed['status'], 'active');
  assert.ok(!JSON.stringify(list.json).includes(token) && !JSON.stringify(list.json).includes('tokenHash'));

  assert.equal((await bcp('voA', 'POST', '/mcp/tokens', { name: 'x', mode: 'write' })).status, 403, 'no write token for a read-only role');
  assert.equal((await bcp('voA', 'POST', '/mcp/tokens', { name: 'x', mode: 'read' })).status, 201);
  assert.equal((await bcp('org', 'POST', '/mcp/tokens', { name: 'x', mode: 'read', expiresInDays: 400 })).status, 400, 'max 365 days');
  assert.equal((await bcp('org', 'POST', '/mcp/tokens', { name: '  ', mode: 'read' })).status, 400);
  assert.equal((await bcp('ua1', 'POST', '/mcp/tokens', { name: 'x', mode: 'read' })).status, 403, 'USER has no admin role');
  assert.equal((await bcp('rmA', 'GET', '/mcp/tokens?all=true')).status, 403, 'only Organization Management sees all tokens');
  const all = await bcp('org', 'GET', '/mcp/tokens?all=true');
  assert.ok((all.json['tokens'] as Row[]).some((t) => t['owner'] === 'voA@a.example'));
  await settle();
  const audited = auditRows('mcp.token.create');
  assert.ok(audited.length >= 2);
  assert.ok(!JSON.stringify(audited).includes(token), 'the audit log never holds the token');
});

// ── bearer auth ───────────────────────────────────────────────────────────────

test('auth: 401 with WWW-Authenticate Bearer; guessed tokens lock the client IP (shared lockout)', async () => {
  const none = await post(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="CoreMail MCP"');
  const bad = await post(`cm_mcp_${'B'.repeat(43)}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  assert.equal((await post('a-jwt-or-anything', {})).status, 401);

  const { token } = await newToken('org', 'read');
  const ip = { 'x-forwarded-for': '198.51.100.7' };
  for (let i = 0; i < 3; i++) assert.equal((await post(`cm_mcp_${String(i).repeat(43)}`, {}, ip)).status, 401);
  const locked = await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ip);
  assert.equal(locked.status, 429, 'the IP is locked — even for a valid token');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 200, 'other IPs are not affected');
});

// ── protocol ──────────────────────────────────────────────────────────────────

test('full MCP handshake: initialize → initialized → tools/list → tools/call, plus transport errors', async () => {
  const { token } = await newToken('org', 'write');
  const init = await post(token, {
    jsonrpc: '2.0', id: 'init-1', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
  });
  assert.equal(init.status, 200);
  const result = init.json['result'] as Row;
  assert.equal(init.json['id'], 'init-1');
  assert.equal(result['protocolVersion'], '2025-06-18');
  assert.deepEqual(result['capabilities'], { tools: { listChanged: false } });
  assert.equal((result['serverInfo'] as Row)['name'], 'coremail-admin');
  const sid = init.headers.get('mcp-session-id')!;
  assert.ok(sid);

  const notified = await post(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
  assert.equal(notified.status, 202);

  const list = await rpc(token, sid, 'tools/list');
  const tools = ((list.json['result'] as Row)['tools'] as Row[]);
  const names = tools.map((t) => t['name']);
  for (const n of ['server_status', 'list_domains', 'list_mailboxes', 'create_mailbox', 'set_protocol_access', 'assign_retention_policy']) {
    assert.ok(names.includes(n), n);
  }
  const create = tools.find((t) => t['name'] === 'create_mailbox')!;
  assert.equal((create['inputSchema'] as Row)['type'], 'object');

  const domains = await callTool(token, sid, 'list_domains');
  assert.equal(domains.isError, false, domains.text);
  assert.deepEqual((domains.data['domains'] as Row[]).map((d) => d['name']).sort(), ['a.example', 'b.example']);
  assert.ok(!domains.text.includes('PRIVATE KEY') && !domains.text.includes('dkimPrivateKey'));

  assert.deepEqual((await rpc(token, sid, 'ping')).json['result'], {});
  assert.equal(((await rpc(token, sid, 'resources/list')).json['error'] as Row)['code'], -32601);
  const unknownTool = await rpc(token, sid, 'tools/call', { name: 'delete_everything', arguments: {} });
  assert.equal((unknownTool.json['error'] as Row)['code'], -32602);
  const badArgs = await callTool(token, sid, 'list_domains', { limit: 'many' });
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.text, /Invalid arguments/);

  // transport errors
  assert.equal((await post(token, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status, 400, 'no session header');
  assert.equal((await rpc(token, 'unknown-session', 'tools/list')).status, 404, 'unknown session');
  assert.equal((await rpc(token, sid, 'tools/list', {}, { 'mcp-protocol-version': '1999-01-01' })).status, 400, 'unsupported version');
  assert.equal((await post(token, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { 'mcp-session-id': sid })).status, 400, 'no batches');
  assert.equal((await post(token, '{not json', { 'mcp-session-id': sid })).status, 400, 'parse error');
  assert.equal((await post(token, 'x'.repeat(70_000), { 'mcp-session-id': sid })).status, 413, 'body limit');
  const plain = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);
  const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(get.status, 405, 'no server-initiated stream');
  assert.equal(get.headers.get('allow'), 'POST, DELETE');

  // a session belongs to its token
  const other = await newToken('org', 'write');
  assert.equal((await rpc(other.token, sid, 'tools/list')).status, 404, "another token's session is unknown");

  const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid } });
  assert.equal(del.status, 204);
  assert.equal((await rpc(token, sid, 'tools/list')).status, 404, 'ended session');
});

test('Origin header: configured host names only (DNS rebinding protection)', async () => {
  const { token } = await newToken('org', 'read');
  const evil = await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const own = await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'https://mail.a.example' });
  assert.equal(own.status, 200);
});

test('read token: write tools are neither listed nor callable', async () => {
  const { token } = await newToken('org', 'read');
  const sid = await initialize(token);
  const names = (((await rpc(token, sid, 'tools/list')).json['result'] as Row)['tools'] as Row[]).map((t) => t['name']);
  assert.ok(names.includes('list_mailboxes'));
  for (const w of ['create_mailbox', 'update_mailbox', 'add_alias', 'remove_alias', 'set_quota', 'set_protocol_access', 'create_domain', 'sender_list_add', 'sender_list_remove', 'assign_retention_policy']) {
    assert.ok(!names.includes(w), w);
  }
  const before = db['user']!.length;
  const r = await rpc(token, sid, 'tools/call', { name: 'create_mailbox', arguments: { email: 'n@a.example', displayName: 'N' } });
  assert.equal((r.json['error'] as Row)['code'], -32602, 'unknown tool for a read token');
  assert.equal(db['user']!.length, before);
});

// ── scope + redaction + audit ─────────────────────────────────────────────────

test('domain-scoped admin: only its domains, other domains not found / redacted — through the admin routes', async () => {
  const { token, id: tokenId } = await newToken('rmA', 'write');
  const sid = await initialize(token);
  const names = (((await rpc(token, sid, 'tools/list')).json['result'] as Row)['tools'] as Row[]).map((t) => t['name']);
  assert.ok(!names.includes('list_certificates') && !names.includes('queue_status') && !names.includes('create_domain'), 'no server-wide tools');

  const status = await callTool(token, sid, 'server_status');
  assert.equal(status.isError, false, status.text);
  assert.equal(status.data['health'], null, 'no servers area for a scoped admin');

  const list = await callTool(token, sid, 'list_mailboxes');
  assert.equal(list.isError, false, list.text);
  const emails = (list.data['items'] as Row[]).map((u) => String(u['email']));
  assert.ok(emails.length > 0 && emails.every((e) => e.endsWith('@a.example')), emails.join());
  assert.ok(!list.text.includes('HASHED-PASSWORD'));

  const foreign = await callTool(token, sid, 'get_mailbox', { mailbox: 'ub1@b.example' });
  assert.equal(foreign.isError, true);
  assert.match(foreign.text, /not found/i);
  const foreignById = await callTool(token, sid, 'get_mailbox', { mailbox: 'ub1' });
  assert.equal(foreignById.isError, true, 'an out-of-scope id is "not found" like an unknown one');
  const own = await callTool(token, sid, 'get_mailbox', { mailbox: 'ua1@a.example' });
  assert.equal(own.isError, false, own.text);
  assert.deepEqual((own.data['aliases'] as Row[]).map((a) => a['address']), ['x@a.example']);

  const outside = await callTool(token, sid, 'create_mailbox', { email: 'new@b.example', displayName: 'New' });
  assert.equal(outside.isError, true);
  assert.equal(db['user']!.some((u) => u['email'] === 'new@b.example'), false);

  const created = await callTool(token, sid, 'create_mailbox', { email: 'new@a.example', displayName: 'New A' });
  assert.equal(created.isError, false, created.text);
  assert.equal(String(created.data['initialPassword']).length, 32, 'generated password returned once');
  const row = db['user']!.find((u) => u['email'] === 'new@a.example')!;
  assert.equal(row['domainId'], 'dA');
  assert.notEqual(row['passwordHash'], created.data['initialPassword'], 'stored as a hash');

  const role = await callTool(token, sid, 'update_mailbox', { mailbox: 'ua1@a.example', role: 'SERVER_MANAGEMENT' });
  assert.equal(role.isError, true, 'role changes stay Organization Management only');
  assert.equal(roleOf('ua1'), 'USER');

  await settle();
  const audited = auditRows('mcp.tool.create_mailbox');
  const ok = audited.find((a) => a['success'] === true)!;
  assert.equal(ok['actorId'], 'rmA');
  assert.equal((ok['changes'] as Row)['tokenId'], tokenId);
  assert.equal(((ok['changes'] as Row)['passwordGenerated']), true);
  assert.ok(!JSON.stringify(audited).includes(String(created.data['initialPassword'])), 'the generated password is never audited');
  assert.ok(audited.some((a) => a['success'] === false), 'refused calls are audited too');
  assert.ok(auditRows('mcp.tool.update_mailbox').some((a) => a['success'] === false && String(a['errorMsg']).length > 0));
});

test('scoped compliance admin: message trace of other domains is redacted', async () => {
  const { token } = await newToken('coA', 'read');
  const sid = await initialize(token);
  const r = await callTool(token, sid, 'message_trace_search', { recipient: 'ua1' });
  assert.equal(r.isError, false, r.text);
  assert.equal((r.data['items'] as Row[]).length, 1);
  assert.ok(!r.text.includes('ub1@b.example'), 'the address of the other hosted domain is hidden');
  assert.ok(r.text.includes('andere Domain'));
  const detail = await callTool(token, sid, 'message_trace_detail', { id: 'trace1' });
  assert.equal(detail.isError, false, detail.text);
  assert.ok(!detail.text.includes('ub1@b.example'));
});

test('audit: explicit passwords are never logged', async () => {
  const { token } = await newToken('org', 'write');
  const sid = await initialize(token);
  const r = await callTool(token, sid, 'create_mailbox', { email: 'pw@a.example', displayName: 'PW', password: 'Sup3r-Secret-Pw!' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data['initialPassword'], undefined, 'a given password is not echoed');
  await settle();
  const row = auditRows('mcp.tool.create_mailbox').find((a) => (a['changes'] as Row)['arguments'] && ((a['changes'] as Row)['arguments'] as Row)['email'] === 'pw@a.example')!;
  assert.equal(((row['changes'] as Row)['arguments'] as Row)['password'], '[redacted]');
  assert.ok(!JSON.stringify(db['auditLog']).includes('Sup3r-Secret-Pw!'));
});

test('rate limit per token: tool calls above the limit answer 429', async () => {
  const { token } = await newToken('org', 'read');
  const sid = await initialize(token);
  for (let i = 0; i < 10; i++) assert.equal((await callTool(token, sid, 'list_domains')).status, 200);
  const limited = await rpc(token, sid, 'tools/call', { name: 'list_domains', arguments: {} });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const other = await newToken('org', 'read');
  const sid2 = await initialize(other.token);
  assert.equal((await callTool(other.token, sid2, 'list_domains')).isError, false, 'the limit is per token');
});

test('forced admin 2FA: a token from a session without MFA stops working', async () => {
  const noMfa = await newToken('org', 'read', false);
  const withMfa = await newToken('org', 'read', true);
  db['userMfa']!.push({ id: 'mfa-org', userId: 'org', totpEnabled: true, webAuthnCredentials: [] });
  settings['requireMfaForAdmins'] = true;
  try {
    const r = await post(noMfa.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json['code'], 'MFA_NOT_VERIFIED');
    assert.equal((await post(withMfa.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 200);
  } finally {
    settings['requireMfaForAdmins'] = false;
  }
});

test('IP allowlist: other client IPs get 404', async () => {
  const { token } = await newToken('org', 'read');
  assert.equal((await bcp('srv', 'PUT', '/mcp/settings', { allowedIps: ['10.0.0.0/8'] })).status, 200);
  try {
    assert.equal((await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 404);
    assert.equal((await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { 'x-forwarded-for': '10.1.2.3' })).status, 200);
  } finally {
    await bcp('srv', 'PUT', '/mcp/settings', { allowedIps: [] });
  }
});

// ── revocation ────────────────────────────────────────────────────────────────

test('revoking a token ends its sessions; only the owner or Organization Management may revoke', async () => {
  const mine = await newToken('rmA', 'read');
  const sid = await initialize(mine.token);
  assert.equal(sessionCount(mine.id), 1);
  const orgTok = await newToken('org', 'read');
  assert.equal((await bcp('rmA', 'DELETE', `/mcp/tokens/${orgTok.id}`)).status, 404, "another admin's token is not found");
  const r = await bcp('rmA', 'DELETE', `/mcp/tokens/${mine.id}`);
  assert.equal(r.status, 200);
  assert.equal(sessionCount(mine.id), 0, 'sessions ended');
  assert.equal((await rpc(mine.token, sid, 'tools/list')).status, 401);
  assert.equal((await bcp('org', 'DELETE', `/mcp/tokens/${orgTok.id}`)).status, 200);
  await settle();
  assert.ok(auditRows('mcp.token.revoke').length >= 2);
});

test('expired tokens stop working', async () => {
  const t = await newToken('org', 'read');
  db['mcpToken']!.find((x) => x['id'] === t.id)!['expiresAt'] = new Date(Date.now() - 1000);
  assert.equal((await post(t.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401);
});

test('role loss (revoke all sessions) revokes the token and ends its sessions at once', async () => {
  const t = await newToken('lost', 'write');
  const sid = await initialize(t.token);
  assert.equal(sessionCount(t.id), 1);
  const r = await bcp('org', 'PUT', '/mailboxes/lost', { role: 'USER' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = db['mcpToken']!.find((x) => x['id'] === t.id)!;
  assert.ok(row['revokedAt'], 'revoked in the database');
  assert.equal(row['revokedReason'], 'role-change');
  assert.equal(sessionCount(t.id), 0, 'live session ended');
  assert.equal((await rpc(t.token, sid, 'tools/list')).status, 401);
});

test('a deactivated admin or a lost admin role refuses the token even without an event', async () => {
  const t = await newToken('voA', 'read');
  assert.equal((await post(t.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 200);
  const voA = db['user']!.find((u) => u['id'] === 'voA')!;
  voA['active'] = false;
  clearCurrentRoleCache();
  try {
    assert.equal((await post(t.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401);
  } finally {
    voA['active'] = true;
    clearCurrentRoleCache();
  }
  voA['role'] = 'USER';
  clearCurrentRoleCache();
  try {
    assert.equal((await post(t.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401);
  } finally {
    voA['role'] = 'VIEW_ONLY_ORG';
    clearCurrentRoleCache();
  }
});

// ── switch off ends sessions (last: leaves the endpoint off) ───────────────────

test('switching the interface off ends every open session; /mcp is 404 again', async () => {
  const t = await newToken('org', 'read');
  const sid = await initialize(t.token);
  assert.ok(sessionCount() >= 1);
  const off = await bcp('srv', 'PUT', '/mcp/settings', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(sessionCount(), 0, 'all sessions ended immediately');
  assert.equal((await rpc(t.token, sid, 'tools/list')).status, 404);
  // another instance: a reload message alone ends the sessions too
  settings['mcpEnabled'] = true;
  invalidateMcpSettings();
  const sid2 = await initialize(t.token);
  settings['mcpEnabled'] = false;
  const { handleMcpReload } = await import('../lib/mcp/settings.js');
  handleMcpReload('{"type":"mcp"}');
  await settle();
  assert.equal(sessionCount(), 0);
  assert.equal((await rpc(t.token, sid2, 'tools/list')).status, 404);
});
