/**
 * 9.4: admin API of the per-protocol access switches — levels, inherit/effective
 * view, RBAC (server/domain: servers area, user: recipients area, admin accounts
 * ORGANIZATION_MANAGEMENT only), validation, audit with before/after, change
 * events for the affected users, the JMAP server level = ServerSettings.jmapEnabled.
 * Loopback Express app, in-memory Prisma (@coremail/storage/auth/testing).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/protocol-access.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
const { createFakePrisma, FakeTable } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
db['auditLog'] = new FakeTable(() => ({ createdAt: new Date(), success: true }));
(globalThis as Record<string, unknown>)['__prisma'] = db;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');

const events: Array<{ userId: string; reason: string; disabledProtocols?: string[] }> = [];
core.onAuthInvalidation((e) => { events.push(e); });

const tokens: Record<string, string> = {};
let server: Server;
let base = '';
before(async () => {
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  for (const [id, role] of [['org', 'ORGANIZATION_MANAGEMENT'], ['srv', 'SERVER_MANAGEMENT'], ['rcp', 'RECIPIENT_MANAGEMENT'],
    ['help', 'HELP_DESK'], ['bob', 'USER']] as const) {
    await db.user.create({ data: { id, email: `${id}@one.test`, role, domainId: 'd1' } });
    tokens[id] = core.signAccessToken({ sub: id, email: `${id}@one.test`, role, domainId: 'd1', sessionId: `s-${id}`, mfaVerified: true });
  }
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  mountAdminRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/protocol-access`;
});
after(() => server?.close());

async function call(method: string, path: string, as: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[as]}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

test('server level: two-state with the built-in defaults, MAPI off, JMAP = ServerSettings.jmapEnabled', async () => {
  const r = await call('GET', '', 'srv');
  assert.equal(r.status, 200);
  assert.equal(r.body['level'], 'global');
  assert.deepEqual(r.body['protocols'], ['imap', 'pop3', 'smtp', 'activesync', 'jmap', 'dav', 'webmail', 'mapi']);
  assert.equal(r.body['settings'].imap, 'on', 'a never-written server switch shows its default');
  assert.equal(r.body['settings'].mapi, 'off');
  assert.equal(r.body['settings'].jmap, 'on');
  assert.equal(r.body['effective'].mapi, false);
  assert.equal(r.body['inherited'].imap, true, 'inherited = built-in defaults on the server level');

  const off = await call('PUT', '', 'srv', { jmap: 'off' });
  assert.equal(off.status, 200);
  assert.equal(db.serverSettings.rows[0]?.['jmapEnabled'], false);
  assert.equal(off.body['settings'].jmap, 'off');
  assert.equal(off.body['effective'].jmap, false);
  const inherit = await call('PUT', '', 'srv', { jmap: 'inherit' });
  assert.equal(inherit.status, 400, 'no inherit on the server level');
  assert.equal(db.serverSettings.rows[0]?.['jmapEnabled'], false, 'nothing written');
  assert.equal((await call('PUT', '', 'srv', { jmap: 'on' })).body['settings'].jmap, 'on');
});

test('domain level: change events for the domain users, audit with before/after', async () => {
  events.length = 0;
  const r = await call('PUT', '/domains/d1', 'srv', { imap: 'off', pop3: 'off' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body['level'], 'domain');
  assert.equal(r.body['settings'].imap, 'off');
  assert.equal(r.body['inherited'].imap, true);
  assert.equal(r.body['effective'].imap, false);
  assert.equal(r.body['changedUsers'], 5);
  const bob = events.find((e) => e.userId === 'bob');
  assert.equal(bob?.reason, 'protocol-access-change');
  assert.deepEqual(bob?.disabledProtocols, ['imap', 'pop3', 'mapi']);
  await new Promise((resolve) => setTimeout(resolve, 20)); // audit() is fire-and-forget
  const row = (db['auditLog'] as InstanceType<typeof FakeTable>).rows.at(-1)!;
  assert.equal(row['action'], 'settings.protocol-access.update');
  assert.equal(row['targetId'], 'd1');
  assert.equal(row['targetName'], 'one.test');
  assert.deepEqual((row['changes'] as Record<string, any>)['switches'], {
    imap: { before: 'inherit', after: 'off' }, pop3: { before: 'inherit', after: 'off' },
  });
});

test('user level: overrides the domain, inherit shows the domain value', async () => {
  const r = await call('PUT', '/users/bob', 'rcp', { imap: 'on' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body['settings'].imap, 'on');
  assert.equal(r.body['inherited'].imap, false, 'the domain switched IMAP off');
  assert.equal(r.body['effective'].imap, true);
  assert.equal(r.body['effective'].pop3, false);
  const view = await call('GET', '/users/bob', 'help');
  assert.equal(view.status, 200, 'HELP_DESK reads recipients');
  assert.equal(view.body['settings'].pop3, 'inherit');
  assert.equal((await call('GET', '/users/nobody', 'rcp')).status, 404);
});

test('RBAC: domain writes need servers, admin accounts need ORGANIZATION_MANAGEMENT, users get 403', async () => {
  assert.equal((await call('PUT', '/domains/d1', 'rcp', { imap: 'on' })).status, 403);
  assert.equal((await call('GET', '/domains/d1', 'rcp')).status, 200, 'domain readers see the domain level');
  assert.equal((await call('PUT', '', 'rcp', { imap: 'on' })).status, 403);
  const admin = await call('PUT', '/users/help', 'rcp', { webmail: 'off' });
  assert.equal(admin.status, 403);
  assert.equal(admin.body['code'], 'FORBIDDEN_ROLE');
  assert.equal((await call('PUT', '/users/help', 'org', { webmail: 'off' })).status, 200);
  assert.equal((await call('GET', '', 'bob')).status, 403);
  assert.equal((await call('PUT', '/users/bob', 'bob', { imap: 'on' })).status, 403);
});

test('validation: unknown protocols, unknown values and empty bodies are refused', async () => {
  assert.equal((await call('PUT', '', 'org', {})).status, 400);
  assert.equal((await call('PUT', '', 'org', { imap: 'maybe' })).status, 400);
  assert.equal((await call('PUT', '', 'org', { ews: 'off' })).status, 400);
  assert.equal((await call('PUT', '/domains/nope', 'org', { imap: 'off' })).status, 404);
});

test('level views name where inherit takes its value from (inheritedFrom)', async () => {
  const user = await call('GET', '/users/bob', 'rcp');
  assert.equal(user.body['inheritedFrom'].imap, 'domain', 'one.test sets IMAP');
  assert.equal(user.body['inheritedFrom'].jmap, 'server');
  assert.equal((await call('GET', '/domains/d1', 'srv')).body['inheritedFrom'].imap, 'server');
  assert.equal((await call('GET', '', 'srv')).body['inheritedFrom'].imap, 'default');
});

test('overview (w2b): ports, overrides and warnings in one answer; servers area only', async () => {
  const listeners = new FakeTable(() => ({ address: '0.0.0.0', allowLegacyTls: false, active: true }));
  const certificates = new FakeTable(() => ({ acmeStaging: false, status: 'ACTIVE', certPem: null }));
  db['serviceListener'] = listeners;
  db['certificate'] = certificates;
  for (const [port, service, ssl, active] of [[25, 'SMTP_RECEIVE', false, true], [587, 'SMTP_RECEIVE', false, true],
    [993, 'IMAP', true, true], [110, 'POP3', false, false]] as const) {
    await listeners.create({ data: { service, port, ssl, active } });
  }
  await certificates.create({ data: { name: 'self', type: 'SELF_SIGNED', isActiveHttps: true } });
  const r = await call('GET', '/overview', 'srv');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (p: string) => (r.body['protocols'] as Array<Record<string, any>>).find((x) => x['protocol'] === p)!;
  assert.deepEqual(row('imap')['activePorts'], [993]);
  assert.deepEqual(row('smtp')['activePorts'], [587]);
  assert.deepEqual(r.body['smtpInbound'].activePorts, [25]);
  assert.equal(row('imap')['overrides'].domains.total, 1, 'one.test switched IMAP off (domain test above)');
  assert.equal(row('imap')['overrides'].users.differing, 1, 'bob switched IMAP back on');
  assert.equal(r.body['https'].active, false);
  assert.equal(r.body['https'].cert.name, 'self');
  assert.equal(r.body['https'].cert.trusted, false);
  const codes = (r.body['warnings'] as Array<Record<string, string>>).map((w) => `${w['protocol']}:${w['code']}`);
  assert.ok(codes.includes('pop3:no-active-port'), codes.join(', '));

  assert.equal((await call('GET', '/overview', 'org')).status, 200);
  assert.equal((await call('GET', '/overview', 'rcp')).status, 403, 'recipients admins do not read the server view');
  assert.equal((await call('GET', '/overview', 'help')).status, 403);
  assert.equal((await call('GET', '/overview', 'bob')).status, 403);
});
