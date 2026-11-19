/**
 * 10.1 own webmail background on the REST API (loopback Express app, in-memory
 * Prisma from @coremail/storage/auth/testing, in-memory object store):
 *  - PUT /user/background (raw + multipart): re-encoded JPEG (≤ 2560 px wide)
 *    under a content-addressed key in its own column; errors with codes
 *  - GET /user/background + /info: own only — another user never sees it (there
 *    is no route with a user id), ETag / 304, Cache-Control private
 *  - DELETE → 404 afterwards; without a token → 401
 * Run: node --import tsx --test --test-force-exit src/routes/user-background.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
process.env['USER_BACKGROUND_UPLOAD_LIMIT'] = '0';

type Row = Record<string, unknown>;
const { createFakePrisma, createFakeRedis, FakeTable } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;
(globalThis as Record<string, unknown>)['__prisma'] = db;

const users = db['user'] as InstanceType<typeof FakeTable>;
const objects = new Map<string, Buffer>();
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  async put(k: string, d: Buffer) { objects.set(k, Buffer.from(d)); },
  async get(k: string) { const v = objects.get(k); if (!v) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return v; },
  async delete(k: string) { objects.delete(k); },
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const jpeg = (await import('jpeg-js')).default;
const { encodePng } = await import('../lib/branding/png.js');
const { userBackgroundRouter } = await import('./user-background.js');

const token = (id: string) => core.signAccessToken({
  sub: id, email: `${id}@one.test`, role: 'USER' as never, domainId: 'd1', sessionId: `s-${id}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  for (const id of ['u1', 'u2']) {
    await db.user.create({ data: { id, email: `${id}@one.test`, domainId: 'd1', passwordHash: 'x', photoKey: null, backgroundKey: null, backgroundUpdatedAt: null } });
  }
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use('/api/v1/user/background', userBackgroundRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  for (const r of users.rows) { r['backgroundKey'] = null; r['backgroundUpdatedAt'] = null; }
  objects.clear();
});

async function call(method: string, path: string, opts: { as?: string; body?: Buffer | FormData; type?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.as) headers['authorization'] = `Bearer ${token(opts.as)}`;
  if (opts.type) headers['content-type'] = opts.type;
  const body = Buffer.isBuffer(opts.body) ? new Uint8Array(opts.body) : opts.body;
  const r = await fetch(`${base}/api/v1/user/background${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: Row = {};
  try { json = JSON.parse(buf.toString('utf8')) as Row; } catch { /* binary */ }
  return { status: r.status, json, buf, headers: r.headers };
}

function png(w: number, h: number): Buffer {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) data[i * 4 + 2] = (i * 3) % 256;
  return encodePng({ width: w, height: h, data });
}

const userRow = (id: string) => users.rows.find((u) => u['id'] === id)!;

test('upload: PNG becomes a JPEG of at most 2560 px under backgrounds/…; GET serves it to the owner', async () => {
  const r = await call('PUT', '', { as: 'u1', body: png(2800, 700), type: 'image/png' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const info = r.json['background'] as Row;
  assert.match(String(info['version']), /^[0-9a-f]{16}$/);
  const key = String(userRow('u1')['backgroundKey']);
  assert.match(key, /^backgrounds\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
  assert.equal(userRow('u1')['photoKey'], null, 'the profile photo column is untouched');

  const got = await call('GET', '', { as: 'u1' });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(got.headers.get('cache-control'), 'private, no-cache');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  const img = jpeg.decode(got.buf);
  assert.deepEqual([img.width, img.height], [2560, 640]);
  const etag = got.headers.get('etag')!;
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  const again = await call('GET', '', { as: 'u1', headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } });
  assert.equal(again.status, 304);

  const meta = await call('GET', '/info', { as: 'u1' });
  assert.deepEqual((meta.json['background'] as Row)['version'], info['version']);
  assert.equal(meta.headers.get('cache-control'), 'no-store');
});

test('own only: another user gets their own (none) — never the owner\'s image; no token → 401', async () => {
  await call('PUT', '', { as: 'u1', body: png(640, 480), type: 'image/png' });
  const other = await call('GET', '', { as: 'u2' });
  assert.equal(other.status, 404);
  assert.deepEqual((await call('GET', '/info', { as: 'u2' })).json, { background: null });
  assert.equal((await call('GET', '')).status, 401);
  assert.equal((await call('PUT', '', { body: png(640, 480), type: 'image/png' })).status, 401);
  // a user id in the path is not a route
  assert.equal((await call('GET', '/u1', { as: 'u2' })).status, 404);
});

test('multipart field "background"; replace releases the old object; DELETE removes it', async () => {
  const form = new FormData();
  form.append('background', new Blob([new Uint8Array(png(640, 480))], { type: 'image/png' }), 'bg.png');
  assert.equal((await call('PUT', '', { as: 'u1', body: form })).status, 200);
  const first = String(userRow('u1')['backgroundKey']);
  assert.equal((await call('PUT', '', { as: 'u1', body: png(800, 600), type: 'image/png' })).status, 200);
  assert.equal(objects.has(first), false, 'old object released');
  assert.equal(objects.size, 1);
  assert.deepEqual((await call('DELETE', '', { as: 'u1' })).json, { removed: true });
  assert.equal(objects.size, 0);
  assert.equal((await call('GET', '', { as: 'u1' })).status, 404);
  assert.deepEqual((await call('DELETE', '', { as: 'u1' })).json, { removed: false });
});

test('upload errors carry codes; nothing is stored', async () => {
  const svg = await call('PUT', '', { as: 'u1', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/png' });
  assert.equal(svg.status, 415);
  assert.equal(svg.json['code'], 'TYPE');
  const tiny = await call('PUT', '', { as: 'u1', body: png(100, 100), type: 'image/png' });
  assert.equal(tiny.status, 422);
  assert.equal(tiny.json['code'], 'DIMENSIONS');
  const big = await call('PUT', '', { as: 'u1', body: Buffer.alloc(5 * 1024 * 1024 + 10, 1), type: 'image/png' });
  assert.equal(big.status, 413);
  assert.equal(big.json['code'], 'SIZE');
  assert.equal(objects.size, 0);
  assert.equal(userRow('u1')['backgroundKey'], null);
});
