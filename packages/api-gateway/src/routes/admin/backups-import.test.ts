/**
 * v8.1: POST /api/v1/admin/backups/import/:userId forwards the upload as raw
 * bytes (encrypted .mbox.enc / non-UTF-8 MBOX stay byte-exact) with ?folderId=,
 * capped by BACKUP_IMPORT_MAX_BYTES. A fake backup-service on loopback.
 * Run: node --import tsx --test --test-force-exit src/routes/admin/backups-import.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
process.env['BACKUP_IMPORT_MAX_BYTES'] = '4096';
const audits: Array<Record<string, unknown>> = [];
installFakePrisma({
  auditLog: { create: (a) => { audits.push((a as { data: Record<string, unknown> }).data); return {}; } },
  user: { findUnique: (a) => { const id = (a as { where: { id: string } }).where.id; return { role: id === 'srv' ? 'SERVER_MANAGEMENT' : id === 'comp' ? 'COMPLIANCE_MANAGEMENT' : 'ORGANIZATION_MANAGEMENT', active: true }; } },
  folder: {
    findMany: (a) => {
      const userId = (a as { where: { mailbox: { userId: string } } }).where.mailbox.userId;
      return userId === 'u1' ? [{ id: 'f-inbox', name: 'INBOX', displayName: 'Inbox' }] : [];
    },
  },
});

// fake backup-service
const seen: Array<{ url: string; ct: string | undefined; body: Buffer }> = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ url: req.url ?? '', ct: req.headers['content-type'], body: Buffer.concat(chunks) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ imported: 1, errors: 0, encrypted: true }));
  });
});
upstream.listen(0, '127.0.0.1');
await new Promise((r) => upstream.once('listening', r));
process.env['BACKUP_SERVICE_URL'] = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminBackupsRouter } = await import('./backups.js');

const token = core.signAccessToken({ sub: 'admin', email: 'admin@ex.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's-admin', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/backups', adminBackupsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); upstream.close(); });

const post = (path: string, body: Buffer) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  body,
});

test('import: raw bytes forwarded unchanged with ?folderId=', async () => {
  // encrypted-backup-like payload: every byte value incl. invalid UTF-8 sequences
  const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37) % 256));
  const r = await post('/api/v1/admin/backups/import/u1?folderId=f-inbox', payload);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { imported: 1, errors: 0, encrypted: true });
  const got = seen.at(-1)!;
  // 9.3 review: the pre-9.3 call (folderId, no mode) is forwarded as such — the
  // backup-service keeps its synchronous contract — and keeps its audit action
  assert.equal(got.url, '/backup/admin/import/u1?folderId=f-inbox');
  assert.equal(got.ct, 'application/octet-stream');
  assert.ok(got.body.equals(payload), 'byte-exact (no UTF-8 round trip)');
  for (let i = 0; i < 50 && !audits.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(audits.at(-1)?.['action'], 'backup.mbox.import');

  // the 9.3 call with an explicit mode is a restore job (backup.restore)
  audits.length = 0;
  const r2 = await post('/api/v1/admin/backups/import/u1?mode=folder&folderId=f-inbox', payload);
  assert.equal(r2.status, 200);
  assert.equal(seen.at(-1)!.url, '/backup/admin/import/u1?mode=folder&folderId=f-inbox');
  for (let i = 0; i < 50 && !audits.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(audits.at(-1)?.['action'], 'backup.restore');
});

test('folder picker: GET /users/:userId/folders lists the mailbox folders', async () => {
  const r = await fetch(`${base}/api/v1/admin/backups/users/u1/folders`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), [{ id: 'f-inbox', name: 'INBOX', displayName: 'Inbox' }]);
});

test('import: folderId required + validated; size cap → 413', async () => {
  const n = seen.length;
  assert.equal((await post('/api/v1/admin/backups/import/u1', Buffer.from('From x'))).status, 400);
  assert.equal((await post('/api/v1/admin/backups/import/u1?folderId=..%2Fx', Buffer.from('From x'))).status, 400);
  assert.equal((await post('/api/v1/admin/backups/import/u1?folderId=f1', Buffer.alloc(5000, 1))).status, 413);
  assert.equal(seen.length, n, 'nothing forwarded');

  // chunked upload without Content-Length: the streaming counter enforces the cap
  const chunks = [Buffer.alloc(3000, 2), Buffer.alloc(3000, 3)];
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); },
  });
  const r = await fetch(`${base}/api/v1/admin/backups/import/u1?folderId=f1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.equal(r.status, 413);
});

test('9.1: casing variants of mailbox-data routes never reach a handler for SERVER_MANAGEMENT', async () => {
  const srv = core.signAccessToken({ sub: 'srv', email: 'srv@ex.com', role: 'SERVER_MANAGEMENT', domainId: 'd1', sessionId: 's-srv', mfaVerified: true });
  const start = seen.length;
  for (const [method, path] of [
    ['GET', '/DOWNLOAD/j1'], ['GET', '/Download/j1'], ['GET', '/ARCHIVE/download?key=x'], ['GET', '/archive/DOWNLOAD?key=x'],
    ['POST', '/MAILBOX/u1'], ['POST', '/Import/u1?folderId=f-inbox'],
  ] as const) {
    const r = await fetch(`${base}/api/v1/admin/backups${path}`, { method, headers: { Authorization: `Bearer ${srv}` } });
    assert.ok(r.status === 403 || r.status === 404, `${method} ${path} → ${r.status}`);
  }
  assert.equal(seen.length, start, 'nothing was forwarded to the backup-service');
  // the canonical spelling is still refused for SERVER_MANAGEMENT, and an upper-case
  // path is not routed even for ORGANIZATION_MANAGEMENT (case-sensitive router)
  assert.equal((await fetch(`${base}/api/v1/admin/backups/download/j1`, { headers: { Authorization: `Bearer ${srv}` } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/admin/backups/JOBS`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal(seen.length, start);
});

// ── 9.3: restore of stored archives, upload modes, recommended schedules ──────

const comp = core.signAccessToken({ sub: 'comp', email: 'comp@ex.com', role: 'COMPLIANCE_MANAGEMENT', domainId: 'd1', sessionId: 's-comp', mfaVerified: true });
const srvToken = core.signAccessToken({ sub: 'srv', email: 'srv@ex.com', role: 'SERVER_MANAGEMENT', domainId: 'd1', sessionId: 's-srv2', mfaVerified: true });
const postJson = (path: string, body: unknown, tok = token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('9.3 upload restore: ?mode=subfolder without folderId is forwarded; mode folder needs a folderId', async () => {
  const r = await post('/api/v1/admin/backups/import/u1?mode=subfolder', Buffer.from('PK\u0003\u0004zip'));
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1)!.url, '/backup/admin/import/u1?mode=subfolder');
  const n = seen.length;
  assert.equal((await post('/api/v1/admin/backups/import/u1?mode=folder', Buffer.from('x'))).status, 400);
  assert.equal((await post('/api/v1/admin/backups/import/u1?mode=merge', Buffer.from('x'))).status, 400);
  assert.equal(seen.length, n);
});

test('9.3 POST /restore: forwards only the known fields; ORG + COMPLIANCE allowed, SERVER_MANAGEMENT refused', async () => {
  const r = await postJson('/api/v1/admin/backups/restore', { key: 'mailbox/u1/1.zip.enc', targetUserId: 'u2', mode: 'subfolder', evil: 'x' });
  assert.equal(r.status, 200);
  const got = seen.at(-1)!;
  assert.equal(got.url, '/backup/admin/restore');
  assert.equal(got.ct, 'application/json');
  assert.deepEqual(JSON.parse(got.body.toString()), { key: 'mailbox/u1/1.zip.enc', targetUserId: 'u2', mode: 'subfolder' });

  assert.equal((await postJson('/api/v1/admin/backups/restore', { jobId: 'j1' }, comp)).status, 200, 'COMPLIANCE_MANAGEMENT may restore mailbox data');
  const n = seen.length;
  assert.equal((await postJson('/api/v1/admin/backups/restore', { jobId: 'j1' }, srvToken)).status, 403, 'SERVER_MANAGEMENT has no mailbox-data right');
  assert.equal((await postJson('/api/v1/admin/backups/RESTORE', { jobId: 'j1' }, srvToken)).status, 403);
  assert.equal(seen.length, n);
});

test('9.3 recommended schedules: servers write (ORG / SERVER_MANAGEMENT), not COMPLIANCE', async () => {
  assert.equal((await postJson('/api/v1/admin/backups/schedules/recommended', {}, srvToken)).status, 200);
  assert.equal(seen.at(-1)!.url, '/backup/admin/schedules/recommended');
  const n = seen.length;
  assert.equal((await postJson('/api/v1/admin/backups/schedules/recommended', {}, comp)).status, 403);
  assert.equal(seen.length, n);
});

test('9.3 system dumps: archive download only for ORGANIZATION_MANAGEMENT', async () => {
  const n = seen.length;
  const r = await fetch(`${base}/api/v1/admin/backups/archive/download?key=${encodeURIComponent('system/2026-11-16/j1/coremail-db.dump.enc')}`, { headers: { Authorization: `Bearer ${comp}` } });
  assert.equal(r.status, 403);
  assert.equal(seen.length, n, 'not forwarded');
});
