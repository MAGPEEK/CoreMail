/**
 * v8.1: POST /api/v1/admin/audit-log/verify-export — checks the signature of
 * an audit export; AUDIT_EXPORT_SIGNING_KEY overrides the JWT_SECRET+PEPPER key.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/audit-verify.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
type Row = Record<string, unknown>;
installFakePrisma({
  user: {
    // token actors "actor-<ROLE>" exist with that role (admin guards re-check the DB role)
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect(id.startsWith('actor-') ? { id, role: id.slice(6), active: true } : null, q.select);
    },
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins: false }) },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mountAdminRoutes } = await import('./index.js');
const { exportSignature } = await import('../../lib/export-safety.js');

const tok = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId: 's', mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  mountAdminRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

const URL_ = '/api/v1/admin/audit-log/verify-export';
async function verify(body: Buffer | string, signature: string | null, role = 'COMPLIANCE_MANAGEMENT', contentType = 'application/octet-stream') {
  const headers: Record<string, string> = { authorization: `Bearer ${tok(role)}`, 'content-type': contentType };
  if (signature !== null) headers['x-coremail-signature'] = signature;
  const r = await fetch(`${base}${URL_}`, { method: 'POST', headers, body });
  return { status: r.status, json: await r.json().catch(() => ({})) as Row };
}

test('verify-export: valid / tampered / missing signature', async () => {
  const csv = '﻿id,action\n1,"settings.put"\n';
  const sig = exportSignature(csv);
  assert.deepEqual((await verify(csv, sig)).json['valid'], true);
  assert.equal((await verify(csv, sig.slice('hmac-sha256='.length))).json['valid'], true, 'bare hex accepted');
  assert.equal((await verify(csv.replace('settings', 'Settings'), sig)).json['valid'], false, 'tampered file');
  assert.equal((await verify(csv, `hmac-sha256=${'0'.repeat(64)}`)).json['valid'], false);
  assert.equal((await verify(csv, null)).status, 400);
  // a JSON export sent as application/json would be re-parsed — refused, not silently invalid
  assert.equal((await verify('{"a":1}', exportSignature('{"a":1}'), 'COMPLIANCE_MANAGEMENT', 'application/json')).status, 415);
});

test('verify-export: compliance area only', async () => {
  const csv = 'x';
  assert.equal((await verify(csv, exportSignature(csv), 'USER')).status, 403);
  assert.equal((await verify(csv, exportSignature(csv), 'HELP_DESK')).status, 403);
  assert.equal((await verify(csv, exportSignature(csv), 'ORGANIZATION_MANAGEMENT')).json['valid'], true);
});

test('AUDIT_EXPORT_SIGNING_KEY wins over the JWT_SECRET+PEPPER key; rotating it invalidates old signatures', () => {
  const env = { JWT_SECRET: 'j'.repeat(40), PEPPER: 'p'.repeat(40) };
  const derived = exportSignature('payload', env);
  const dedicated = exportSignature('payload', { ...env, AUDIT_EXPORT_SIGNING_KEY: 'k'.repeat(40) });
  assert.notEqual(dedicated, derived);
  assert.equal(exportSignature('payload', { AUDIT_EXPORT_SIGNING_KEY: 'k'.repeat(40) }), dedicated, 'JWT_SECRET/PEPPER not needed');
  assert.notEqual(exportSignature('payload', { ...env, AUDIT_EXPORT_SIGNING_KEY: 'r'.repeat(40) }), dedicated, 'rotated key');
  assert.throws(() => exportSignature('payload', { AUDIT_EXPORT_SIGNING_KEY: 'short' }), /at least 32/);
});
