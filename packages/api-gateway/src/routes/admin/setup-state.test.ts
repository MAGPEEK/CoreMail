/**
 * 10.4.2: /admin/setup-state — BCP dashboard card "Zertifikat einrichten".
 * Visibility rule (no trusted certificate covers the public host name, not
 * dismissed, only for roles that may manage certificates), RBAC (area servers:
 * read GET, write dismiss; USER and anonymous refused), "Später".
 * Run: node --import tsx --test --test-force-exit src/routes/admin/setup-state.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import forge from 'node-forge';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let settings: Row = {};
let certs: Row[] = [];

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
  certificate: { findMany: () => certs },
  adminScope: { findMany: () => [] },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminSetupStateRouter } = await import('./setup-state.js');
const { certificateCardVisible, isIssuableHostname } = await import('../../lib/setup-state.js');

const token = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

/** A certificate for `cn`, issued by `issuer` (issuer = cn → self-issued). */
function certRow(id: string, cn: string, issuer: string, over: Row = {}): Row {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 30 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: issuer }]);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: cn }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    id, name: cn, type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: false, isActiveHttps: false, createdAt: new Date(),
    certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey), chainPem: null, domains: [cn],
    ...over,
  };
}

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
beforeEach(() => { settings = { publicHostname: 'mail.example.test', adminEmail: 'certs@example.test' }; certs = []; });

async function call(method: string, path: string, role?: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${token(role)}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) as Row | null };
}

test('visibility rule (pure)', () => {
  const on = { publicHostname: 'mail.example.test', servedTrusted: false, dismissedAt: null, canManageCertificates: true };
  assert.equal(certificateCardVisible(on), true);
  assert.equal(certificateCardVisible({ ...on, servedTrusted: true }), false, 'a trusted certificate covers the host');
  assert.equal(certificateCardVisible({ ...on, dismissedAt: new Date() }), false, '"Später"');
  assert.equal(certificateCardVisible({ ...on, canManageCertificates: false }), false, 'read-only role');
  for (const h of [null, '', 'mail.local', 'mail.localhost', 'localhost', 'box.localhost', 'nodot']) {
    assert.equal(certificateCardVisible({ ...on, publicHostname: h }), false, String(h));
  }
  assert.equal(isIssuableHostname('Mail.Example.test'), true);
});

test('anonymous 401, non-server roles 403, VIEW_ONLY_ORG may read (never sees the card) but not dismiss', async () => {
  assert.equal((await call('GET', '/')).status, 401);
  assert.equal((await call('POST', '/certificate-hint/dismiss')).status, 401);
  for (const role of ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT']) {
    assert.equal((await call('GET', '/', role)).status, 403, role);
    assert.equal((await call('POST', '/certificate-hint/dismiss', role)).status, 403, role);
  }
  const ro = await call('GET', '/', 'VIEW_ONLY_ORG');
  assert.equal(ro.status, 200);
  assert.deepEqual(ro.json, { certificateCard: false, publicHostname: 'mail.example.test', acmeEmail: 'certs@example.test' });
  assert.equal((await call('POST', '/certificate-hint/dismiss', 'VIEW_ONLY_ORG')).status, 403);
  assert.equal(settings['setupCertificateHintDismissedAt'], undefined, 'nothing written');
});

test('no certificate, or only self-signed / staging / other names → card shows', async () => {
  assert.deepEqual((await call('GET', '/', 'ORGANIZATION_MANAGEMENT')).json, { certificateCard: true, publicHostname: 'mail.example.test', acmeEmail: 'certs@example.test' });
  certs = [
    certRow('self', 'mail.example.test', 'mail.example.test', { type: 'SELF_SIGNED' }),
    certRow('stage', 'mail.example.test', 'Staging CA', { acmeStaging: true }),
    certRow('other', 'other.example.test', 'Test CA', { isActiveHttps: true }),
  ];
  assert.deepEqual((await call('GET', '/', 'SERVER_MANAGEMENT')).json, { certificateCard: true, publicHostname: 'mail.example.test', acmeEmail: 'certs@example.test' });
});

test('a trusted certificate for the public host name hides the card', async () => {
  certs = [certRow('le', 'mail.example.test', 'Test CA')];
  assert.deepEqual((await call('GET', '/', 'ORGANIZATION_MANAGEMENT')).json, { certificateCard: false, publicHostname: 'mail.example.test', acmeEmail: 'certs@example.test' });
});

test('placeholder host name → no card, publicHostname null', async () => {
  settings = { publicHostname: 'mail.local' };
  assert.deepEqual((await call('GET', '/', 'ORGANIZATION_MANAGEMENT')).json, { certificateCard: false, publicHostname: null, acmeEmail: 'actor-ORGANIZATION_MANAGEMENT@ex.com' }, 'no adminEmail → the own address');
});

test('"Später" hides the card for everyone', async () => {
  const r = await call('POST', '/certificate-hint/dismiss', 'SERVER_MANAGEMENT');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { certificateCard: false, publicHostname: 'mail.example.test', acmeEmail: 'certs@example.test' });
  assert.ok(settings['setupCertificateHintDismissedAt'] instanceof Date);
  assert.equal((await call('GET', '/', 'ORGANIZATION_MANAGEMENT')).json?.['certificateCard'], false);
});

test('the certificate choice of 10.4 is gone', async () => {
  assert.equal((await call('PUT', '/certificate-choice', 'ORGANIZATION_MANAGEMENT', { choice: 'later' })).status, 404);
});
