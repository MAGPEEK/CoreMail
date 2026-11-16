/**
 * BCP certificates review fixes:
 *  - self-signed: a real X.509 certificate (no "public key as certPem" fallback),
 *    matching key, unique serial per certificate;
 *  - upload: a private key that does not belong to the certificate is a 400;
 *  - services are SMTP/IMAP/POP3 only, domains are validated (400 with a readable error);
 *  - DELETE /:id/activate-https on an unknown id is a 404 (was a silent 200).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/certificates-admin.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const created: Row[] = [];
installFakePrisma({
  user: { findUnique: () => ({ role: 'ORGANIZATION_MANAGEMENT', active: true }) },
  certificate: {
    create: (a) => { const d = (a as { data: Row }).data; created.push(d); return { id: `c${created.length}`, ...d }; },
    findMany: () => [],
    updateMany: () => ({ count: 0 }),
  },
});
// publishTlsReload swallows Redis errors (no Redis in the test → ECONNREFUSED log lines only)

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../../middleware/auth.js');
const { adminCertificatesRouter, pemKeyMismatch } = await import('./certificates.js');

const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/admin/certificates', requireAuth, adminCertificatesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { created.length = 0; });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}/api/v1/admin/certificates${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json };
}

test('self-signed: a real certificate for the key, unique serials, normalised domains', async () => {
  const a = await call('POST', '/self-signed', { name: 'a', domains: ['Mail.Example.com', 'localhost'], services: ['SMTP', 'SMTP'] });
  const b = await call('POST', '/self-signed', { name: 'b', domains: ['mail.example.com'] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const [ca, cb] = created as Array<{ certPem: string; keyPem: string; domains: string[]; services: string[] }>;
  const xa = new X509Certificate(ca!.certPem);
  assert.equal(pemKeyMismatch(ca!.certPem, ca!.keyPem), null);
  assert.match(xa.subjectAltName ?? '', /DNS:mail\.example\.com/);
  assert.deepEqual(ca!.domains, ['mail.example.com', 'localhost']);
  assert.deepEqual(ca!.services, ['SMTP']);
  assert.notEqual(xa.serialNumber, new X509Certificate(cb!.certPem).serialNumber);
  assert.equal('keyPem' in a.json, false, 'private key never returned');
});

test('upload: a key that does not belong to the certificate is refused', async () => {
  await call('POST', '/self-signed', { name: 'src', domains: ['mail.example.com'] });
  const { certPem, keyPem } = created[0] as { certPem: string; keyPem: string };
  created.length = 0;
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const bad = await call('POST', '/upload', { name: 'x', domains: ['mail.example.com'], certPem, keyPem: other });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json['error']), /private key/i);
  assert.equal(created.length, 0);
  const ok = await call('POST', '/upload', { name: 'x', domains: ['mail.example.com'], certPem, keyPem });
  assert.equal(ok.status, 201);
});

test('services and domains are validated with a readable error', async () => {
  const s = await call('POST', '/self-signed', { name: 'x', domains: ['mail.example.com'], services: ['HTTPS'] });
  assert.equal(s.status, 400);
  const d = await call('POST', '/self-signed', { name: 'x', domains: ['bad domain'] });
  assert.equal(d.status, 400);
  assert.equal(d.json['error'], 'Invalid domain name');
  const w = await call('POST', '/letsencrypt', { name: 'x', domains: ['*.example.com'], email: 'a@example.com' });
  assert.equal(w.status, 400);
  assert.match(String(w.json['error']), /Wildcard/);
  assert.equal(created.length, 0);
});

test('deactivating HTTPS on an unknown certificate is a 404', async () => {
  assert.equal((await call('DELETE', '/nope/activate-https')).status, 404);
});
