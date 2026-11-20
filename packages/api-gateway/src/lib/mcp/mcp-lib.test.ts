/**
 * Admin MCP interface (10.3) — pure parts: JSON-RPC classification and version
 * negotiation, IP allowlist + Origin check, result shaping (secret filter, size
 * cap, audit arguments), tool catalogue (mode / role filter, JSON Schemas).
 * Run: node --import tsx --test src/lib/mcp/mcp-lib.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();

const protocol = await import('./protocol.js');
const net = await import('./net.js');
const result = await import('./result.js');
const tools = await import('./tools.js');
const settings = await import('./settings.js');
const { USER_ROLES } = await import('../rbac.js');

test('classifyMessage: requests, notifications, responses, batches and garbage', () => {
  assert.deepEqual(protocol.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    { kind: 'request', id: 1, method: 'tools/list', params: {} });
  assert.deepEqual(protocol.classifyMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    { kind: 'notification', method: 'notifications/initialized', params: {} });
  assert.deepEqual(protocol.classifyMessage({ jsonrpc: '2.0', id: 'a', result: {} }), { kind: 'response' });
  assert.equal(protocol.classifyMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).kind, 'invalid', 'no batches');
  assert.equal(protocol.classifyMessage({ jsonrpc: '2.0', id: null, method: 'ping' }).kind, 'invalid', 'id must not be null');
  assert.equal(protocol.classifyMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }).kind, 'invalid');
  assert.equal(protocol.classifyMessage({ jsonrpc: '2.0', id: 1, method: 'x', params: [1] }).kind, 'invalid', 'params must be an object');
  assert.equal(protocol.classifyMessage('text').kind, 'invalid');
});

test('version negotiation and headers', () => {
  assert.equal(protocol.negotiateVersion('2025-06-18'), '2025-06-18');
  assert.equal(protocol.negotiateVersion('2025-03-26'), '2025-03-26');
  assert.equal(protocol.negotiateVersion('2099-01-01'), protocol.MCP_PROTOCOL_VERSION, 'unknown → ours');
  assert.equal(protocol.negotiateVersion(undefined), protocol.MCP_PROTOCOL_VERSION);
  assert.equal(protocol.headerVersionSupported(undefined), true, 'absent header → transport default');
  assert.equal(protocol.headerVersionSupported('2025-06-18'), true);
  assert.equal(protocol.headerVersionSupported('1999-01-01'), false);
  assert.equal(protocol.acceptsJson('application/json, text/event-stream'), true);
  assert.equal(protocol.acceptsJson('text/event-stream'), false);
  assert.equal(protocol.acceptsJson(undefined), true);
  assert.equal(protocol.isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(protocol.isJsonContentType('text/plain'), false);
});

test('IP allowlist: validation, canonical form, IPv4 / IPv6 / mapped addresses', () => {
  assert.deepEqual(net.normalizeAllowlist([' 10.0.0.0/8 ', '192.0.2.7', '192.0.2.7/32', '2001:db8::/32']),
    { ok: true, entries: ['10.0.0.0/8', '192.0.2.7', '2001:db8::/32'] });
  assert.equal(net.normalizeAllowlist(['10.0.0.0/33']).ok, false);
  assert.equal(net.normalizeAllowlist(['example.com']).ok, false);
  assert.equal(net.normalizeAllowlist(Array.from({ length: 101 }, (_, i) => `10.0.0.${i % 250}`)).ok, false);
  assert.equal(net.ipAllowed('203.0.113.9', []), true, 'empty list = every IP');
  assert.equal(net.ipAllowed('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(net.ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8']), true, 'IPv4-mapped');
  assert.equal(net.ipAllowed('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(net.ipAllowed('2001:db8::1', ['2001:db8::/32']), true);
  assert.equal(net.ipAllowed('', ['10.0.0.0/8']), false);
  assert.equal(net.ipAllowed('10.1.2.3', ['garbage']), false, 'only invalid entries → nobody');
});

test('Origin check (DNS rebinding): configured host names only, never the request Host', () => {
  const hosts = ['mail.example.com'];
  assert.equal(net.originAllowed(undefined, hosts), true, 'no Origin (non-browser client)');
  assert.equal(net.originAllowed('https://mail.example.com', hosts), true);
  assert.equal(net.originAllowed('https://MAIL.example.com:8443', hosts), true, 'port and case do not matter');
  assert.equal(net.originAllowed('https://evil.example', hosts), false);
  assert.equal(net.originAllowed('null', hosts), false);
  assert.equal(net.originAllowed('file:///x', hosts), false);
  assert.equal(net.originAllowed('not a url', hosts), false);
  assert.equal(net.originAllowed('http://localhost:6274', hosts, ['http://localhost:6274']), true, 'MCP_ALLOWED_ORIGINS');
  assert.deepEqual(net.parseOriginList(' http://a.test, https://b.test '), ['http://a.test', 'https://b.test']);
});

test('stripSecrets removes secret fields at any depth; capResult keeps the size cap', () => {
  const out = result.stripSecrets({
    id: 'u1', password: 'x', nested: { dkimPrivateKey: 'k', keyPem: 'p', ok: 1, list: [{ tokenHash: 'h', name: 'n' }] },
    when: new Date('2026-01-01T00:00:00Z'), big: 5n,
  });
  assert.deepEqual(out, { id: 'u1', nested: { ok: 1, list: [{ name: 'n' }] }, when: '2026-01-01T00:00:00.000Z', big: 5 });
  const small = result.capResult({ a: 1 }, 1000);
  assert.equal(small, '{"a":1}');
  const big = { total: 500, items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) })) };
  const capped = JSON.parse(result.capResult(big, 5000)) as { truncated: boolean; returned: number; of: number; items: unknown[] };
  assert.equal(capped.truncated, true);
  assert.equal(capped.of, 500);
  assert.ok(capped.returned > 0 && capped.returned < 500 && capped.items.length === capped.returned);
  assert.ok(Buffer.byteLength(result.capResult(big, 5000)) <= 5000);
  const scalar = JSON.parse(result.capResult({ text: 'y'.repeat(10_000) }, 2000)) as { truncated: boolean };
  assert.equal(scalar.truncated, true);
  assert.deepEqual(result.redactArguments({ email: 'a@b.test', password: 'secret', quotaBytes: 5, list: ['x'] }),
    { email: 'a@b.test', password: '[redacted]', quotaBytes: 5, list: '["x"]' });
});

test('tool catalogue: read tokens see read tools only, roles see what they can use', () => {
  const names = (mode: 'read' | 'write', role: string, scoped = false) => tools.toolsFor(mode, role, scoped).map((t) => t.name);
  const orgWrite = names('write', 'ORGANIZATION_MANAGEMENT');
  assert.equal(orgWrite.length, tools.MCP_TOOLS.length, 'Organization Management: every tool');
  const orgRead = names('read', 'ORGANIZATION_MANAGEMENT');
  assert.ok(orgRead.every((n) => tools.MCP_TOOLS.find((t) => t.name === n)!.mode === 'read'));
  assert.ok(!orgRead.includes('create_mailbox') && orgRead.includes('list_mailboxes'));
  const view = names('write', 'VIEW_ONLY_ORG');
  assert.ok(view.every((n) => tools.MCP_TOOLS.find((t) => t.name === n)!.mode === 'read'), 'VIEW_ONLY_ORG: no write tool even with a write token');
  assert.ok(!view.includes('message_trace_search'), 'no compliance data for VIEW_ONLY_ORG');
  const helpDesk = names('write', 'HELP_DESK');
  assert.ok(helpDesk.includes('update_mailbox') && !helpDesk.includes('create_mailbox'), 'help desk: enable/disable only');
  const scopedRm = names('write', 'RECIPIENT_MANAGEMENT', true);
  assert.ok(scopedRm.includes('create_mailbox') && !scopedRm.includes('queue_status') && !scopedRm.includes('list_certificates'));
  assert.ok(!names('write', 'COMPLIANCE_MANAGEMENT', true).includes('assign_retention_policy'), 'retention is organisation-wide');
  assert.ok(names('write', 'COMPLIANCE_MANAGEMENT').includes('assign_retention_policy'));
  assert.deepEqual(names('write', 'USER'), [], 'USER: nothing');
  for (const role of USER_ROLES.filter((r) => r !== 'USER')) {
    assert.ok(names('read', role).includes('server_status'), `${role}: server_status`);
  }
});

test('every tool has an object JSON Schema without $schema and a description', () => {
  for (const t of tools.MCP_TOOLS) {
    const d = tools.describeTool(t) as { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> };
    assert.equal(d.inputSchema['type'], 'object', t.name);
    assert.equal(d.inputSchema['$schema'], undefined, t.name);
    assert.ok(d.description.length > 20, t.name);
    assert.equal(d.annotations['readOnlyHint'], t.mode === 'read', t.name);
    assert.match(t.name, /^[a-z_]+$/);
  }
  const create = tools.describeTool(tools.MCP_TOOLS.find((t) => t.name === 'create_mailbox')!) as { inputSchema: { required: string[]; properties: Record<string, unknown> } };
  assert.deepEqual(create.inputSchema.required.sort(), ['displayName', 'email']);
  assert.ok('password' in create.inputSchema.properties);
});

test('generated passwords and the endpoint URL', () => {
  const p = tools.generatePassword();
  assert.equal(p.length, 32);
  assert.notEqual(p, tools.generatePassword());
  assert.equal(settings.endpointUrl({ publicHostname: 'mail.example.com', useHttps: true, httpPort: 443 }), 'https://mail.example.com/mcp');
  assert.equal(settings.endpointUrl({ publicHostname: 'mail.example.com', useHttps: false, httpPort: 8080 }), 'http://mail.example.com:8080/mcp');
  assert.equal(settings.isMcpReload('{"type":"mcp"}'), true);
  assert.equal(settings.isMcpReload('{"type":"branding"}'), false);
  assert.equal(settings.isMcpReload('x'), false);
});

test('expectOk turns route refusals into tool errors with the route message', () => {
  assert.deepEqual(tools.expectOk({ status: 200, body: { a: 1 } }), { a: 1 });
  assert.throws(() => tools.expectOk({ status: 404, body: { error: 'Not found' } }), (e: unknown) => e instanceof tools.ToolError && e.status === 404 && e.message === 'Not found');
  assert.throws(() => tools.expectOk({ status: 403, body: { error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' } }),
    (e: unknown) => e instanceof tools.ToolError && e.code === 'FORBIDDEN_ROLE');
  assert.throws(() => tools.expectOk({ status: 400, body: { error: 'Invalid request', details: [{ message: 'Too small', path: ['quotaBytes'] }] } }),
    /Invalid request: Too small \(quotaBytes\)/);
});
