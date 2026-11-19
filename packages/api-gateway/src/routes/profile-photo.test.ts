/**
 * 9.5 profile photos on the REST API (loopback Express app, in-memory Prisma
 * from @coremail/storage/auth/testing, in-memory object store):
 *  - PUT /user/photo (raw + multipart): re-encoded JPEG stored under a
 *    content-addressed key, errors with codes, module `profilePhoto` off → 403
 *  - GET /users/:id/photo: same domain only, hidden-from-GAL and inactive
 *    accounts not found, ETag / 304, Cache-Control private
 *  - POST /users/photos/lookup: addresses and aliases in one answer
 *  - DELETE /user/photo (also while the module is off) → 404 afterwards
 *  - admin GET / DELETE /admin/mailboxes/:id/photo: area recipients, scope,
 *    admin-account guard, audit mailbox.photo.remove; GET /user/profile `photo`
 * Run: node --import tsx --test --test-force-exit src/routes/profile-photo.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
process.env['PROFILE_PHOTO_UPLOAD_LIMIT'] = '0';

type Row = Record<string, unknown>;
const { createFakePrisma, createFakeRedis, FakeTable, matches } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;
(globalThis as Record<string, unknown>)['__prisma'] = db;

/** User filter of the photo queries: relation filters (GAL visibility, aliases) on top of the generic matcher. */
function userMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => userMatches(row, w));
    if (k === 'AND') return (cond as Row[]).every((w) => userMatches(row, w));
    if (k === 'NOT') return !userMatches(row, cond as Row);
    if (k === 'mailFlowPolicy') return row['hiddenFromGal'] === ((cond as { is: Row }).is['hiddenFromGal']);
    if (k === 'aliases') {
      const wanted = ((cond as { some: { address: { in: string[] } } }).some.address.in);
      return ((row['aliases'] as Row[] | undefined) ?? []).some((a) => wanted.includes(String(a['address'])));
    }
    return matches(row, { [k]: cond });
  });
}
const users = db['user'] as InstanceType<typeof FakeTable>;
const copy = (r: Row) => ({ ...r, aliases: [...((r['aliases'] as Row[] | undefined) ?? [])] });
Object.assign(users, {
  findFirst: async (a: { where?: Row }) => { const r = users.rows.find((x) => userMatches(x, a.where)); return r ? copy(r) : null; },
  findMany: async (a: { where?: Row }) => users.rows.filter((x) => userMatches(x, a.where)).map(copy),
  count: async (a: { where?: Row }) => users.rows.filter((x) => userMatches(x, a.where)).length,
  updateMany: async (a: { where: Row; data: Row }) => {
    const hit = users.rows.filter((x) => userMatches(x, a.where));
    for (const r of hit) Object.assign(r, a.data);
    return { count: hit.length };
  },
});
const audits: Row[] = [];
db['auditLog'] = { create: async (a: { data: Row }) => { audits.push(a.data); return a.data; } };
db['message'] = { aggregate: async () => ({ _sum: { rawSize: 0 } }) }; // admin detail: used bytes

const objects = new Map<string, Buffer>();
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  async put(k: string, d: Buffer) { objects.set(k, Buffer.from(d)); },
  async get(k: string) { const v = objects.get(k); if (!v) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return v; },
  async delete(k: string) { objects.delete(k); },
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const jpeg = (await import('jpeg-js')).default;
const { encodePng } = await import('../lib/branding/png.js');
const { ownPhotoRouter, usersPhotoRouter } = await import('./profile-photo.js');
const { userRouter } = await import('./user.js');
const { adminMailboxesRouter } = await import('./admin/mailboxes.js');

const token = (id: string, role = 'USER', domainId = 'd1') => core.signAccessToken({
  sub: id, email: `${id}@one.test`, role: role as never, domainId, sessionId: `s-${id}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  await db.domain.create({ data: { id: 'd2', name: 'two.test' } });
  await db.serverSettings.create({ data: { id: 'singleton', auditLogEnabled: true } });
  const add = (id: string, extra: Row = {}) => db.user.create({
    data: { id, email: `${id}@one.test`, domainId: 'd1', passwordHash: 'x', photoKey: null, photoUpdatedAt: null, aliases: [], hiddenFromGal: false, ...extra },
  });
  await add('u1', { displayName: 'Ute Eins', aliases: [{ address: 'team@one.test' }] });
  await add('u2');
  await add('hidden', { hiddenFromGal: true });
  await add('gone', { active: false });
  await add('other', { email: 'other@two.test', domainId: 'd2' });
  await add('boss', { role: 'ORGANIZATION_MANAGEMENT' });
  await add('helpdesk', { role: 'RECIPIENT_MANAGEMENT' });
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use('/api/v1/user/photo', ownPhotoRouter);
  app.use('/api/v1/users', express.json(), usersPhotoRouter);
  app.use('/api/v1/user', express.json(), userRouter);
  app.use('/api/v1/admin/mailboxes', express.json(), adminMailboxesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(async () => {
  for (const r of users.rows) { r['photoKey'] = null; r['photoUpdatedAt'] = null; }
  objects.clear();
  audits.length = 0;
  db.webmailPolicy.rows = [];
  storage.invalidateWebmailPolicyCache();
});

async function call(method: string, path: string, opts: { as?: string; role?: string; domainId?: string; body?: Buffer | FormData | string; type?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.as) headers['authorization'] = `Bearer ${token(opts.as, opts.role, opts.domainId)}`;
  if (opts.type) headers['content-type'] = opts.type;
  const body = Buffer.isBuffer(opts.body) ? new Uint8Array(opts.body) : opts.body;
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: Row = {};
  try { json = JSON.parse(buf.toString('utf8')) as Row; } catch { /* binary */ }
  return { status: r.status, json, buf, headers: r.headers };
}

function png(w = 300, h = 200): Buffer {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) data[i * 4 + 1] = (i * 7) % 256;
  return encodePng({ width: w, height: h, data });
}

const upload = (as = 'u1', body: Buffer = png(), type = 'image/png') => call('PUT', '/api/v1/user/photo', { as, body, type });

test('upload: PNG becomes a 512×512 JPEG under a content-addressed key; GET serves it to the domain', async () => {
  const r = await upload();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const photo = r.json['photo'] as Row;
  assert.equal(photo['userId'], 'u1');
  assert.match(String(photo['version']), /^[0-9a-f]{16}$/);
  const key = String(users.rows.find((u) => u['id'] === 'u1')!['photoKey']);
  assert.match(key, /^profile-photos\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
  assert.equal(objects.size, 1);

  const self = await call('GET', '/api/v1/users/u1/photo', { as: 'u1' });
  const colleague = await call('GET', '/api/v1/users/u1/photo', { as: 'u2' });
  for (const g of [self, colleague]) {
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/jpeg');
    assert.equal(g.headers.get('cache-control'), 'private, no-cache');
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(jpeg.decode(g.buf).width, 512);
  }
  const etag = colleague.headers.get('etag')!;
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  const again = await call('GET', '/api/v1/users/u1/photo', { as: 'u2', headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } });
  assert.equal(again.status, 304);
});

test('upload as multipart field "photo" works too', async () => {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(png())], { type: 'image/png' }), 'me.png');
  const r = await call('PUT', '/api/v1/user/photo', { as: 'u1', body: form });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(objects.size, 1);
});

test('upload errors: wrong type, too large, too many pixels — nothing stored', async () => {
  const svg = await upload('u1', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
  assert.deepEqual([svg.status, svg.json['code']], [415, 'TYPE']);
  const big = await upload('u1', Buffer.alloc(5 * 1024 * 1024 + 10, 1), 'image/jpeg');
  assert.deepEqual([big.status, big.json['code']], [413, 'SIZE']);
  const bomb = png(10, 10);
  bomb.writeUInt32BE(30000, 16); bomb.writeUInt32BE(30000, 20);
  const huge = await upload('u1', bomb);
  assert.deepEqual([huge.status, huge.json['code']], [422, 'DIMENSIONS']);
  assert.equal(objects.size, 0);
  assert.equal(users.rows.find((u) => u['id'] === 'u1')!['photoKey'], null);
  assert.equal((await call('PUT', '/api/v1/user/photo', { body: png(), type: 'image/png' })).status, 401);
});

test('visibility: other domains, hidden and inactive accounts are "not found"', async () => {
  for (const id of ['u1', 'hidden', 'gone', 'other']) {
    const row = users.rows.find((u) => u['id'] === id)!;
    row['photoKey'] = storage.profilePhotoKey(Buffer.from(id));
    objects.set(String(row['photoKey']), Buffer.from(id));
  }
  assert.equal((await call('GET', '/api/v1/users/u1/photo', { as: 'other', domainId: 'd2' })).status, 404, 'other domain');
  assert.equal((await call('GET', '/api/v1/users/other/photo', { as: 'u1' })).status, 404);
  assert.equal((await call('GET', '/api/v1/users/hidden/photo', { as: 'u1' })).status, 404, 'hidden from the address list');
  assert.equal((await call('GET', '/api/v1/users/hidden/photo', { as: 'hidden' })).status, 200, 'own photo always');
  assert.equal((await call('GET', '/api/v1/users/gone/photo', { as: 'u1' })).status, 404, 'inactive');
  assert.equal((await call('GET', '/api/v1/users/u2/photo', { as: 'u1' })).status, 404, 'no photo');
  assert.equal((await call('GET', '/api/v1/users/u1/photo')).status, 401);
});

test('lookup: primary addresses and aliases → user id + version, only visible photos', async () => {
  await upload('u1');
  const hidden = users.rows.find((u) => u['id'] === 'hidden')!;
  hidden['photoKey'] = storage.profilePhotoKey(Buffer.from('h'));
  const r = await call('POST', '/api/v1/users/photos/lookup', {
    as: 'u2', type: 'application/json',
    body: JSON.stringify({ addresses: ['U1@one.test', 'team@one.test', 'u2@one.test', 'hidden@one.test', 'nobody@x.test', 'junk'] }),
  });
  assert.equal(r.status, 200);
  const photos = r.json['photos'] as Record<string, Row>;
  assert.deepEqual(Object.keys(photos).sort(), ['team@one.test', 'u1@one.test']);
  assert.equal(photos['team@one.test']!['userId'], 'u1');
  assert.equal(photos['u1@one.test']!['version'], photos['team@one.test']!['version']);
  const tooMany = await call('POST', '/api/v1/users/photos/lookup', {
    as: 'u2', type: 'application/json', body: JSON.stringify({ addresses: Array.from({ length: 101 }, (_, i) => `a${i}@one.test`) }),
  });
  assert.equal(tooMany.status, 400);
});

test('module profilePhoto off: upload 403 FEATURE_DISABLED, the photo stays visible and removable', async () => {
  await upload('u1');
  await storage.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { features: { profilePhoto: 'off' } });
  const refused = await upload('u1');
  assert.deepEqual([refused.status, refused.json['code'], refused.json['feature']], [403, 'FEATURE_DISABLED', 'profilePhoto']);
  assert.equal((await call('GET', '/api/v1/users/u1/photo', { as: 'u2' })).status, 200);
  const del = await call('DELETE', '/api/v1/user/photo', { as: 'u1' });
  assert.deepEqual([del.status, del.json['removed']], [200, true]);
});

test('delete: photo gone (404), object released, profile shows photo null', async () => {
  await upload('u1');
  const profile = await call('GET', '/api/v1/user/profile', { as: 'u1' });
  assert.equal((profile.json['photo'] as Row)['userId'], 'u1');
  assert.equal(profile.json['photoKey'], undefined, 'the storage key is not exposed');
  assert.equal((await call('DELETE', '/api/v1/user/photo', { as: 'u1' })).json['removed'], true);
  assert.equal((await call('GET', '/api/v1/users/u1/photo', { as: 'u2' })).status, 404);
  assert.equal(objects.size, 0);
  assert.equal((await call('GET', '/api/v1/user/profile', { as: 'u1' })).json['photo'], null);
  assert.equal((await call('DELETE', '/api/v1/user/photo', { as: 'u1' })).json['removed'], false);
});

test('admin: view + remove with area recipients, audit, admin accounts need Organization Management', async () => {
  await upload('u1');
  assert.equal((await call('GET', '/api/v1/admin/mailboxes/u1/photo', { as: 'u2' })).status, 403, 'plain users have no admin area');
  const view = await call('GET', '/api/v1/admin/mailboxes/u1/photo', { as: 'helpdesk', role: 'RECIPIENT_MANAGEMENT' });
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('content-type'), 'image/jpeg');
  const detail = await call('GET', '/api/v1/admin/mailboxes/u1', { as: 'helpdesk', role: 'RECIPIENT_MANAGEMENT' });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal((detail.json['photo'] as Row)['userId'], 'u1');

  await upload('boss');
  const denied = await call('DELETE', '/api/v1/admin/mailboxes/boss/photo', { as: 'helpdesk', role: 'RECIPIENT_MANAGEMENT' });
  assert.equal(denied.status, 403);

  const removed = await call('DELETE', '/api/v1/admin/mailboxes/u1/photo', { as: 'helpdesk', role: 'RECIPIENT_MANAGEMENT' });
  assert.deepEqual([removed.status, removed.json['removed']], [200, true]);
  // audit() writes fire-and-forget
  for (let i = 0; i < 50 && !audits.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(audits.some((a) => a['action'] === 'mailbox.photo.remove' && a['targetId'] === 'u1'));
  assert.equal((await call('GET', '/api/v1/admin/mailboxes/u1/photo', { as: 'boss', role: 'ORGANIZATION_MANAGEMENT' })).status, 404);
  assert.equal((await call('DELETE', '/api/v1/admin/mailboxes/boss/photo', { as: 'boss', role: 'ORGANIZATION_MANAGEMENT' })).json['removed'], true);
});
