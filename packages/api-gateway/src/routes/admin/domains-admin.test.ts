/**
 * BCP domain CRUD: domain names / DKIM selectors are validated and lower-cased, a
 * duplicate differing only in case is a 409, and a domain that still has mailboxes
 * cannot be renamed (addresses are stored in full and would be orphaned).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/domains-admin.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = { id: string; name: string; dkimSelector: string; active: boolean; primary: boolean };
let domains: Row[] = [];
let userCount = 0;
const creates: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];

installFakePrisma({
  user: {
    findUnique: () => ({ role: 'ORGANIZATION_MANAGEMENT', active: true }),
    count: () => userCount,
  },
  domain: {
    findUnique: (a: unknown) => {
      const w = (a as { where: { id?: string; name?: string } }).where;
      return domains.find((d) => (w.id !== undefined ? d.id === w.id : d.name === w.name)) ?? null;
    },
    count: () => domains.length,
    create: (a: unknown) => {
      const data = (a as { data: Record<string, unknown> }).data;
      creates.push(data);
      return { id: 'new', ...data, _count: { users: 0 } };
    },
    update: (a: unknown) => {
      const { where, data } = a as { where: { id: string }; data: Record<string, unknown> };
      updates.push(data);
      return { ...domains.find((d) => d.id === where.id), ...data, _count: { users: 0 } };
    },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminDomainsRouter } = await import('./domains.js');

const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's-admin', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/domains', requireAuth, adminDomainsRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });
beforeEach(() => {
  domains = [
    { id: 'd1', name: 'example.com', dkimSelector: 'coremail', active: true, primary: true },
    { id: 'd2', name: 'example.org', dkimSelector: 'coremail', active: true, primary: false },
  ];
  userCount = 0;
  creates.length = 0;
  updates.length = 0;
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const r = await fetch(`${base}/api/v1/admin/domains${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() as never };
}

test('create: invalid domain names and selectors are a readable 400', async () => {
  for (const name of ['nodot', 'bad domain.com', '-x.com', 'a..b.com', 'x'.repeat(64) + '.com', '']) {
    const r = await call('POST', '/', { name });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error, 'Invalid domain name', name);
  }
  const s = await call('POST', '/', { name: 'example.net', dkimSelector: 'bad selector' });
  assert.equal(s.status, 400);
  assert.match(s.body.error ?? '', /DKIM selector/);
  assert.equal(creates.length, 0);
});

test('create: name and selector are trimmed and lower-cased; case-only duplicates are a 409', async () => {
  const ok = await call('POST', '/', { name: '  Example.NET ', dkimSelector: 'Sel2026' });
  assert.equal(ok.status, 201);
  assert.equal(creates[0]!['name'], 'example.net');
  assert.equal(creates[0]!['dkimSelector'], 'sel2026');
  const dup = await call('POST', '/', { name: 'EXAMPLE.com' });
  assert.equal(dup.status, 409);
});

test('rename: blocked while the domain has mailboxes, allowed when empty', async () => {
  userCount = 2;
  const blocked = await call('PUT', '/d2', { name: 'example.info' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'DOMAIN_IN_USE');
  assert.equal(updates.length, 0);

  userCount = 0;
  const ok = await call('PUT', '/d2', { name: 'Example.Info' });
  assert.equal(ok.status, 200);
  assert.equal(updates[0]!['name'], 'example.info');
});

test('update: same name in another case is not a rename; selector-only change works with mailboxes', async () => {
  userCount = 5;
  const r = await call('PUT', '/d2', { name: 'EXAMPLE.org', dkimSelector: 'k2' });
  assert.equal(r.status, 200);
  assert.deepEqual(updates[0], { name: 'example.org', dkimSelector: 'k2' });
  const bad = await call('PUT', '/d2', { dkimSelector: 'a.b' });
  assert.equal(bad.status, 400);
});

test('make-primary: an inactive domain is refused with 409 DOMAIN_INACTIVE (live BCP test 9.2)', async () => {
  domains[1]!.active = false;
  const r = await call('POST', '/d2/make-primary', {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DOMAIN_INACTIVE');
  assert.equal(updates.length, 0);
  const missing = await call('POST', '/nope/make-primary', {});
  assert.equal(missing.status, 404);
});
