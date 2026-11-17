/**
 * 9.3: GET /admin/security/capabilities — hygiene RBAC (read roles allowed),
 * reply shape, whitelisting of the security filter's reply (no hosts/URLs),
 * filter down → 503. Fake filter on loopback.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/security-capabilities.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminSecurityRouter } = await import('./security.js');
const { sanitizeCapabilities } = await import('./security-capabilities.js');

const token = (role: string) => core.signAccessToken({ // role cast: test roles are UserRole values
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let filter: Server;
let base = '';
let filterReply: unknown;
let filterStatus = 200;
let filterUrl = '';

before(async () => {
  const f = express();
  f.get('/capabilities', (_q, r) => { r.status(filterStatus).json(filterReply); });
  filter = f.listen(0, '127.0.0.1');
  await new Promise((r) => filter.once('listening', r));
  filterUrl = `http://127.0.0.1:${(filter.address() as AddressInfo).port}`;

  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/security', requireAuth, adminSecurityRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/security/capabilities`;
});
after(() => { server?.close(); filter?.close(); });
beforeEach(() => {
  process.env['SECURITY_FILTER_URL'] = filterUrl;
  filterStatus = 200;
  filterReply = {
    rspamd: { state: 'absent', reason: 'disabled-by-config', checkedAt: '2026-11-17T08:00:00.000Z' },
    clamav: { state: 'unavailable', reason: 'host-not-found', detail: 'ENOTFOUND', checkedAt: '2026-11-17T08:00:00.000Z' },
  };
});

const get = (role?: string) => fetch(base, role ? { headers: { authorization: `Bearer ${token(role)}` } } : {});

test('hygiene read roles get the capabilities; other roles 403, anonymous 401', async () => {
  for (const role of ['HYGIENE_MANAGEMENT', 'VIEW_ONLY_ORG', 'ORGANIZATION_MANAGEMENT']) {
    assert.equal((await get(role)).status, 200, role);
  }
  for (const role of ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT']) {
    assert.equal((await get(role)).status, 403, role);
  }
  assert.equal((await get()).status, 401);
});

test('shape: { rspamd, clamav } with state, reason, detail, checkedAt', async () => {
  const r = await get('HYGIENE_MANAGEMENT');
  assert.deepEqual(await r.json(), {
    rspamd: { state: 'absent', reason: 'disabled-by-config', checkedAt: '2026-11-17T08:00:00.000Z' },
    clamav: { state: 'unavailable', reason: 'host-not-found', detail: 'ENOTFOUND', checkedAt: '2026-11-17T08:00:00.000Z' },
  });
});

test('the reply is whitelisted: no host, URL or free-text detail passes through', async () => {
  filterReply = {
    rspamd: { state: 'available', reason: 'ok', checkedAt: '2026-11-17T08:00:00.000Z', host: 'rspamd', url: 'http://admin:secret@rspamd:11334' },
    clamav: { state: 'unavailable', reason: 'connect-failed', detail: 'connect ECONNREFUSED 10.0.0.5:3310', checkedAt: 'x' },
    extra: { password: 'secret' },
  };
  const body = await (await get('VIEW_ONLY_ORG')).json() as Record<string, unknown>;
  assert.deepEqual(body, {
    rspamd: { state: 'available', reason: 'ok', checkedAt: '2026-11-17T08:00:00.000Z' },
    clamav: { state: 'unavailable', reason: 'connect-failed', checkedAt: null },
  });
  assert.doesNotMatch(JSON.stringify(body), /secret|rspamd:11334|10\.0\.0\.5/);
});

test('unknown states from the filter are reported as not checked (nothing gets hidden)', () => {
  assert.deepEqual(sanitizeCapabilities({ rspamd: { state: 'gone', reason: 'ok' }, clamav: null }), {
    rspamd: { state: 'unavailable', reason: 'not-checked', checkedAt: null },
    clamav: { state: 'unavailable', reason: 'not-checked', checkedAt: null },
  });
});

test('security filter down → 503, filter error → 502', async () => {
  filterStatus = 500;
  assert.equal((await get('HYGIENE_MANAGEMENT')).status, 502);
  process.env['SECURITY_FILTER_URL'] = 'http://127.0.0.1:1';
  const r = await get('HYGIENE_MANAGEMENT');
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'security-filter unavailable' });
});
