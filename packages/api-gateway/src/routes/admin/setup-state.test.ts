/**
 * 10.4: /admin/setup-state — certificate choice of the setup wizard and the
 * dashboard hint after "later". RBAC (area servers: write for
 * ORGANIZATION_MANAGEMENT / SERVER_MANAGEMENT, read for VIEW_ONLY_ORG, USER and
 * anonymous refused), validation, idempotence, hint logic.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/setup-state.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let settings: Row = {};
let trustedCerts = 0;

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  serverSettings: {
    findUnique: (a) => applySelect({ id: 'singleton', ...settings }, (a as { select?: Row }).select),
    update: (a) => { settings = { ...settings, ...(a as { data: Row }).data }; return settings; },
  },
  certificate: {
    count: (a) => {
      const w = (a as { where: Row }).where;
      // the route must only count trusted certificates
      assert.deepEqual(w['type'], { not: 'SELF_SIGNED' });
      assert.equal(w['acmeStaging'], false);
      return trustedCerts;
    },
  },
  adminScope: { findMany: () => [] },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminSetupStateRouter } = await import('./setup-state.js');
const { certificateHintVisible, isCertificateChoice } = await import('../../lib/setup-state.js');

const token = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/setup-state', requireAuth, adminSetupStateRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/setup-state`;
});
after(() => server?.close());
beforeEach(() => { settings = {}; trustedCerts = 0; });

async function call(method: string, path: string, role?: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${token(role)}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) as Row | null };
}

test('pure hint logic', () => {
  assert.equal(certificateHintVisible('later', null, false), true);
  assert.equal(certificateHintVisible('later', new Date(), false), false, 'dismissed');
  assert.equal(certificateHintVisible('later', null, true), false, 'trusted certificate exists');
  assert.equal(certificateHintVisible('proxy', null, false), false);
  assert.equal(certificateHintVisible('letsencrypt', null, false), false);
  assert.equal(certificateHintVisible(null, null, false), false, 'never asked (pre-10.4)');
  assert.equal(isCertificateChoice('later'), true);
  assert.equal(isCertificateChoice('none'), false);
});

test('anonymous 401, non-server roles 403, VIEW_ONLY_ORG may read but not write', async () => {
  assert.equal((await call('GET', '/')).status, 401);
  assert.equal((await call('PUT', '/certificate-choice', undefined, { choice: 'later' })).status, 401);
  for (const role of ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT']) {
    assert.equal((await call('GET', '/', role)).status, 403, role);
    assert.equal((await call('PUT', '/certificate-choice', role, { choice: 'later' })).status, 403, role);
  }
  assert.equal((await call('GET', '/', 'VIEW_ONLY_ORG')).status, 200);
  assert.equal((await call('PUT', '/certificate-choice', 'VIEW_ONLY_ORG', { choice: 'later' })).status, 403);
  assert.equal((await call('POST', '/certificate-hint/dismiss', 'VIEW_ONLY_ORG')).status, 403);
  assert.equal(settings['setupCertificateChoice'], undefined, 'nothing written');
});

test('fresh / pre-10.4 installation: no choice, no hint', async () => {
  const r = await call('GET', '/', 'ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { certificateChoice: null, certificateHint: false });
});

test('"later" shows the hint until dismissed; a trusted certificate hides it', async () => {
  const set = await call('PUT', '/certificate-choice', 'ORGANIZATION_MANAGEMENT', { choice: 'later' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { certificateChoice: 'later', certificateHint: true });

  trustedCerts = 1;
  assert.deepEqual((await call('GET', '/', 'SERVER_MANAGEMENT')).json, { certificateChoice: 'later', certificateHint: false });
  trustedCerts = 0;

  const dismissed = await call('POST', '/certificate-hint/dismiss', 'SERVER_MANAGEMENT');
  assert.equal(dismissed.status, 200);
  assert.deepEqual(dismissed.json, { certificateChoice: 'later', certificateHint: false });
  assert.ok(settings['setupCertificateHintDismissedAt'] instanceof Date);
});

test('choice is idempotent and validated; reverse proxy never shows the hint', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await call('PUT', '/certificate-choice', 'ORGANIZATION_MANAGEMENT', { choice: 'proxy' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { certificateChoice: 'proxy', certificateHint: false });
  }
  for (const bad of [{}, { choice: 'none' }, { choice: 'later', extra: 1 }, { choice: 1 }]) {
    assert.equal((await call('PUT', '/certificate-choice', 'ORGANIZATION_MANAGEMENT', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(settings['setupCertificateChoice'], 'proxy');
});
