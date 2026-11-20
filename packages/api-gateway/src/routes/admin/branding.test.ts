/**
 * 9.3 branding API: admin PUT / asset upload / delete / reset (RBAC area
 * organisation, validation errors, warnings, audit settings.branding.update,
 * CHANNEL_SETTINGS_RELOAD {type:'branding'}, content-addressed keys, old asset
 * deleted), public GET /api/v1/branding + /branding/assets headers, branded
 * index.html cached per version and invalidated by the reload message.
 * Fake Prisma (globalThis.__prisma), in-memory object store (globalThis.__objectStore).
 * Run: node --import tsx --test --test-force-exit src/routes/admin/branding.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();
delete process.env['BRANDING_NAME'];
delete process.env['BRANDING_COLOR'];

type Row = Record<string, unknown>;
let row: Row | null = null;
const audits: Row[] = [];
const published: string[] = [];
(globalThis as Record<string, unknown>)['__brandingPublish'] = (_c: string, m: string) => { published.push(m); };

const objects = new Map<string, Buffer>();
const deleted: string[] = [];
let storeGets = 0;
/** Runs once inside the next branding.findUnique (to interleave concurrent requests). */
let findHook: (() => Promise<void>) | null = null;

// Fake Redis for the asset lock (SET NX PX + compare-and-delete).
const lockKv = new Map<string, string>();
(globalThis as Record<string, unknown>)['__brandingLockRedis'] = {
  async set(k: string, v: string) { if (lockKv.has(k)) return null; lockKv.set(k, v); return 'OK'; },
  async eval(_script: string, _n: number, k: string, token: string) { if (lockKv.get(k) === token) { lockKv.delete(k); return 1; } return 0; },
};
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  async init() { return { lifecycle: false }; },
  async put(k: string, d: Buffer) { objects.set(k, Buffer.from(d)); },
  async putStream() { throw new Error('unused'); },
  async get(k: string) { storeGets++; const v = objects.get(k); if (!v) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return v; },
  async getStream() { throw new Error('unused'); },
  async stat(k: string) { const v = objects.get(k); return v ? { size: v.length, lastModified: new Date() } : null; },
  async exists(k: string) { return objects.has(k); },
  async delete(k: string) { deleted.push(k); objects.delete(k); },
  async *list() { /* none */ },
};

const DEFAULT_ROW: Row = {
  id: 'singleton', version: 1, productName: null, primaryColor: null, headerColor: null,
  logoLightKey: null, logoLightType: null, logoDarkKey: null, logoDarkType: null, faviconKey: null, faviconType: null,
  loginBackgroundKey: null, loginBackgroundType: null, loginText: '', footerLinks: [], allowUserAccent: true, showPoweredBy: true,
};

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@ex.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  branding: {
    findUnique: async () => {
      const h = findHook;
      if (h) { findHook = null; await h(); }
      return row ? { ...row } : null;
    },
    upsert: (a) => {
      const q = a as { create: Row; update: Row };
      if (!row) { row = { ...DEFAULT_ROW, ...q.create }; return { ...row }; }
      const { version, ...rest } = q.update as Row & { version?: { increment: number } };
      row = { ...row, ...rest, version: Number(row['version']) + (version?.increment ?? 0) };
      return { ...row };
    },
  },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { adminBrandingRouter } = await import('./branding.js');
const { brandingApiRouter, brandingAssetsRouter, brandingFaviconsRouter, ASSET_CSP } = await import('../branding.js');
const { encodePng, decodePng } = await import('../../lib/branding/png.js');
const state = await import('../../lib/branding/state.js');
const { fakePng: png } = await import('../../lib/branding/test-fixtures.js');
const assetLock = await import('../../lib/branding/asset-lock.js');

const token = (role: string) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@ex.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified: true,
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/branding', brandingApiRouter);
  app.use('/branding/assets', brandingAssetsRouter);
  app.use('/branding/favicons', brandingFaviconsRouter);
  app.use('/api/v1/admin/branding', adminBrandingRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  row = null; audits.length = 0; published.length = 0; objects.clear(); deleted.length = 0; state.invalidateBranding();
  storeGets = 0; findHook = null; lockKv.clear();
});

async function call(method: string, path: string, opts: { role?: string; json?: unknown; body?: Buffer | string; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.role) headers['authorization'] = `Bearer ${token(opts.role)}`;
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.body !== undefined) { headers['content-type'] = opts.type ?? 'application/octet-stream'; body = typeof opts.body === 'string' ? opts.body : new Uint8Array(opts.body); }
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: Row = {};
  try { json = JSON.parse(buf.toString('utf8')) as Row; } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers, buf };
}

const ORG = 'ORGANIZATION_MANAGEMENT';
const A = '/api/v1/admin/branding';

test('defaults: public and admin GET return the contract shape', async () => {
  const pub = await call('GET', '/api/v1/branding');
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(pub.json, {
    version: 0, productName: 'CoreMail', primaryColor: '#0078d4', headerColor: null,
    allowUserAccent: true, showPoweredBy: true, defaultBackground: 'none', loginText: '', footerLinks: [],
    assets: { logoLight: null, logoDark: null, favicon: null, loginBackground: null },
  });
  const adm = await call('GET', A, { role: ORG });
  assert.equal(adm.status, 200);
  assert.deepEqual(adm.json, {
    ...pub.json,
    defaults: { productName: 'CoreMail', primaryColor: '#0078d4' },
    explicit: { productName: false, primaryColor: false, headerColor: false },
  }, 'admin answer = public shape + defaults + explicit');
});

test('admin answers: explicit flags follow the stored values; untouched defaults keep following the environment', async () => {
  const put = await call('PUT', A, { role: ORG, json: { headerColor: '#123456' } });
  assert.deepEqual(put.json['explicit'], { productName: false, primaryColor: false, headerColor: true });
  assert.equal(row!['productName'], null, 'a PUT without productName stores no name');
  process.env['BRANDING_NAME'] = 'Env Mail';
  process.env['BRANDING_COLOR'] = '#aa3300';
  try {
    state.invalidateBranding();
    const adm = await call('GET', A, { role: ORG });
    assert.equal(adm.json['productName'], 'Env Mail', 'default still env-driven after a save');
    assert.equal(adm.json['primaryColor'], '#aa3300');
    assert.deepEqual(adm.json['defaults'], { productName: 'Env Mail', primaryColor: '#aa3300' });
    const pub = await call('GET', '/api/v1/branding');
    assert.equal(pub.json['defaults'], undefined, 'public contract unchanged');
    assert.equal(pub.json['explicit'], undefined);
    const set = await call('PUT', A, { role: ORG, json: { productName: 'Acme', primaryColor: '#0078d4' } });
    assert.deepEqual(set.json['explicit'], { productName: true, primaryColor: true, headerColor: true });
    const back = await call('PUT', A, { role: ORG, json: { productName: null, primaryColor: null, headerColor: null } });
    assert.deepEqual(back.json['explicit'], { productName: false, primaryColor: false, headerColor: false });
    assert.equal(back.json['productName'], 'Env Mail');
    const up = await call('POST', A + '/assets/favicon', { role: ORG, body: png(32, 32), type: 'image/png' });
    assert.deepEqual(up.json['defaults'], { productName: 'Env Mail', primaryColor: '#aa3300' }, 'asset answers carry the admin fields too');
    const reset = await call('POST', A + '/reset', { role: ORG });
    assert.deepEqual(reset.json['explicit'], { productName: false, primaryColor: false, headerColor: false });
  } finally {
    delete process.env['BRANDING_NAME'];
    delete process.env['BRANDING_COLOR'];
  }
});

test('RBAC: area organisation — write ORGANIZATION_MANAGEMENT only, read SERVER_MANAGEMENT / VIEW_ONLY_ORG', async () => {
  assert.equal((await call('GET', A)).status, 401);
  assert.equal((await call('GET', A, { role: 'USER' })).status, 403);
  assert.equal((await call('GET', A, { role: 'SERVER_MANAGEMENT' })).status, 200);
  assert.equal((await call('GET', A, { role: 'VIEW_ONLY_ORG' })).status, 200);
  assert.equal((await call('GET', A, { role: 'RECIPIENT_MANAGEMENT' })).status, 403);
  for (const role of ['SERVER_MANAGEMENT', 'VIEW_ONLY_ORG', 'HELP_DESK', 'USER']) {
    assert.equal((await call('PUT', A, { role, json: { productName: 'X' } })).status, 403, role);
    assert.equal((await call('POST', `${A}/assets/logoLight`, { role, body: png(10, 10), type: 'image/png' })).status, 403, role);
    assert.equal((await call('DELETE', `${A}/assets/logoLight`, { role })).status, 403, role);
    assert.equal((await call('POST', `${A}/reset`, { role })).status, 403, role);
  }
  assert.equal(row, null, 'nothing written by denied requests');
  assert.equal(objects.size, 0);
});

test('PUT: validation errors → 400 {error, field}', async () => {
  const bad: Array<[unknown, string]> = [
    [{ productName: '' }, 'productName'],
    [{ productName: 'x'.repeat(41) }, 'productName'],
    [{ productName: 'a\nb' }, 'productName'],
    [{ primaryColor: 'red' }, 'primaryColor'],
    [{ headerColor: '#12345' }, 'headerColor'],
    [{ allowUserAccent: 'yes' }, 'allowUserAccent'],
    [{ loginText: 'x'.repeat(281) }, 'loginText'],
    [{ footerLinks: [{ label: 'x', url: 'http://example.org' }] }, 'footerLinks'],
    [{ footerLinks: [{ label: 'x', url: 'javascript:alert(1)' }] }, 'footerLinks'],
    [{ footerLinks: Array(6).fill({ label: 'x', url: 'https://example.org' }) }, 'footerLinks'],
    [{ logoLightKey: 'branding/x' }, 'logoLightKey'],
    [{ defaultBackground: 'custom' }, 'defaultBackground'],
    [{ defaultBackground: 'builtin:photo' }, 'defaultBackground'],
    [{ version: 99 }, 'version'],
    [[1, 2], 'body'],
  ];
  for (const [body, field] of bad) {
    const r = await call('PUT', A, { role: ORG, json: body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json['field'], field);
    assert.equal(typeof r.json['error'], 'string');
  }
  assert.equal(row, null);
});

test('PUT: partial update, version++, audit + reload publish, warnings for low-contrast colours', async () => {
  const r1 = await call('PUT', A, { role: ORG, json: {
    productName: '  Acme Mail ', primaryColor: '#0078D4', loginText: 'Welcome\r\nback',
    footerLinks: [{ label: 'Impressum', url: 'https://example.org/impressum' }, { label: 'Privacy', url: 'mailto:dpo@example.org' }],
  } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json['productName'], 'Acme Mail');
  assert.equal(r1.json['primaryColor'], '#0078d4');
  assert.equal(r1.json['loginText'], 'Welcome\nback');
  assert.equal(r1.json['version'], 1);
  assert.deepEqual(r1.json['warnings'], []);
  assert.deepEqual(published, ['{"type":"branding"}']);
  await new Promise((r) => setTimeout(r, 20));
  const a = audits.find((x) => x['action'] === 'settings.branding.update');
  assert.ok(a, 'audited');
  assert.equal(a['actorEmail'], `actor-${ORG}@ex.com`);
  assert.deepEqual((a['changes'] as Row)['productName'], { from: null, to: 'Acme Mail' });

  const r2 = await call('PUT', A, { role: ORG, json: { headerColor: '#ffff00', showPoweredBy: false, defaultBackground: 'builtin:lake' } });
  assert.equal(r2.status, 200);
  assert.equal(r2.json['version'], 2);
  assert.equal(r2.json['productName'], 'Acme Mail', 'untouched fields kept');
  assert.equal(r2.json['showPoweredBy'], false);
  assert.equal(r2.json['defaultBackground'], 'builtin:lake', '10.1: organisation default background');
  const w = r2.json['warnings'] as Array<Row>;
  assert.equal(w.length, 1);
  assert.equal(w[0]!['field'], 'headerColor');
  assert.match(String(w[0]!['suggestion']), /^#[0-9a-f]{6}$/);
  assert.match(String(w[0]!['message']), /3:1/);
  assert.equal(row!['headerColor'], '#ffff00', 'low-contrast colour is saved');

  const r3 = await call('PUT', A, { role: ORG, json: { productName: null, headerColor: null } });
  assert.equal(r3.json['productName'], 'CoreMail');
  assert.equal(r3.json['headerColor'], null);

  const pub = await call('GET', '/api/v1/branding');
  assert.equal(pub.json['version'], 3);
  assert.equal(pub.json['warnings'], undefined, 'warnings only in the PUT response');
});

test('assets: PNG + SVG upload → content-addressed keys, public URLs, served with CSP/nosniff; replace deletes the old object', async () => {
  const p = png(300, 100);
  const up = await call('POST', `${A}/assets/logoLight`, { role: ORG, body: p, type: 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const sha = createHash('sha256').update(p).digest('hex');
  assert.equal((up.json['assets'] as Row)['logoLight'], `/branding/assets/${sha}.png`);
  assert.ok(objects.has(`branding/${sha}.png`));
  assert.equal(row!['logoLightType'], 'image/png');
  assert.deepEqual(published, ['{"type":"branding"}']);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- c --><rect width="10" height="10" fill="#0078d4"/></svg>';
  const up2 = await call('POST', `${A}/assets/logoLight`, { role: ORG, body: svg, type: 'image/svg+xml' });
  assert.equal(up2.status, 200);
  const url = String((up2.json['assets'] as Row)['logoLight']);
  assert.match(url, /^\/branding\/assets\/[0-9a-f]{64}\.svg$/);
  assert.deepEqual(deleted, [`branding/${sha}.png`], 'replaced asset deleted');
  assert.equal(up2.json['version'], 2);

  const got = await call('GET', url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/svg+xml');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('content-security-policy'), ASSET_CSP);
  assert.equal(ASSET_CSP, "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  assert.match(String(got.headers.get('cache-control')), /immutable/);
  assert.doesNotMatch(got.buf.toString(), /<!--/);
  // the stored object is the sanitised SVG and its key is the hash of what is stored
  const file = url.split('/').pop()!;
  assert.equal(createHash('sha256').update(got.buf).digest('hex'), file.slice(0, 64));

  assert.equal((await call('GET', `/branding/assets/${'0'.repeat(64)}.svg`)).status, 404);
  assert.equal((await call('GET', '/branding/assets/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await call('GET', `/branding/assets/${sha}.html`)).status, 404);
});

test('assets: hostile SVG / wrong type / oversize / dimensions → 400 {error, code}; nothing stored', async () => {
  const cases: Array<[string, string | Buffer, string, string]> = [
    ['logoLight', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'image/svg+xml', 'SVG_UNSAFE'],
    ['logoLight', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml', 'SVG_UNSAFE'],
    ['logoLight', '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>', 'image/svg+xml', 'SVG_UNSAFE'],
    ['logoLight', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>', 'image/svg+xml', 'SVG_UNSAFE'],
    ['logoLight', png(10, 10), 'image/gif', 'TYPE'],
    ['logoLight', png(10, 10), 'image/jpeg', 'TYPE'],
    ['logoLight', Buffer.from('GIF89a......'), 'image/png', 'TYPE'],
    ['logoLight', png(10, 10, 600 * 1024), 'image/png', 'SIZE'],
    ['loginBackground', png(10, 10, 2 * 1024 * 1024 + 10), 'image/png', 'SIZE'],
    ['logoLight', png(9000, 10), 'image/png', 'DIMENSIONS'],
    ['favicon', png(64, 32), 'image/png', 'DIMENSIONS'],
    ['banner', png(10, 10), 'image/png', 'TYPE'],
  ];
  for (const [slot, body, type, code] of cases) {
    const r = await call('POST', `${A}/assets/${slot}`, { role: ORG, body, type });
    assert.equal(r.status, 400, `${slot} ${type} → ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json['code'], code, `${slot} ${type}`);
    assert.equal(typeof r.json['error'], 'string');
  }
  assert.equal(objects.size, 0);
  assert.equal(row, null);
  assert.equal(published.length, 0);
});

test('assets: loginBackground accepts JPEG; DELETE clears the slot and deletes the object; shared key kept', async () => {
  const p = png(64, 64);
  await call('POST', `${A}/assets/favicon`, { role: ORG, body: p, type: 'image/png' });
  await call('POST', `${A}/assets/logoLight`, { role: ORG, body: p, type: 'image/png' });
  const key = `branding/${createHash('sha256').update(p).digest('hex')}.png`;
  const del = await call('DELETE', `${A}/assets/favicon`, { role: ORG });
  assert.equal(del.status, 200);
  assert.equal((del.json['assets'] as Row)['favicon'], null);
  assert.ok(objects.has(key), 'still referenced by logoLight');
  assert.deepEqual(deleted, []);
  await call('DELETE', `${A}/assets/logoLight`, { role: ORG });
  assert.deepEqual(deleted, [key]);
  assert.equal((await call('DELETE', `${A}/assets/nope`, { role: ORG })).status, 400);
});

test('reset: defaults restored, every asset removed, version still increments', async () => {
  await call('PUT', A, { role: ORG, json: { productName: 'Acme', primaryColor: '#123456', showPoweredBy: false, footerLinks: [{ label: 'x', url: 'https://x.org' }] } });
  await call('POST', `${A}/assets/logoDark`, { role: ORG, body: png(20, 20), type: 'image/png' });
  const r = await call('POST', `${A}/reset`, { role: ORG });
  assert.equal(r.status, 200);
  assert.equal(r.json['productName'], 'CoreMail');
  assert.equal(r.json['primaryColor'], '#0078d4');
  assert.equal(r.json['showPoweredBy'], true);
  assert.deepEqual(r.json['footerLinks'], []);
  assert.deepEqual(r.json['assets'], { logoLight: null, logoDark: null, favicon: null, loginBackground: null });
  assert.equal(r.json['version'], 3);
  assert.equal(objects.size, 0);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(audits.some((x) => x['action'] === 'settings.branding.update' && (x['changes'] as Row)['reset'] === true));
});

test('env defaults BRANDING_NAME / BRANDING_COLOR apply while nothing is stored', async () => {
  process.env['BRANDING_NAME'] = 'Env Mail';
  process.env['BRANDING_COLOR'] = '#AA3300';
  try {
    const r = await call('GET', '/api/v1/branding');
    assert.equal(r.json['productName'], 'Env Mail');
    assert.equal(r.json['primaryColor'], '#aa3300');
  } finally {
    delete process.env['BRANDING_NAME'];
    delete process.env['BRANDING_COLOR'];
  }
});

test('index.html: injected per version, cached, refreshed after a branding reload message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-brand-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, '<!DOCTYPE html><html><head><title>CoreMail — Backend Control Panel</title></head><body></body></html>');
  await call('PUT', A, { role: ORG, json: { productName: 'Acme', primaryColor: '#112233' } });
  const h1 = (await state.brandedIndexHtml(file))!;
  assert.match(h1, /<title>Acme<\/title>/);
  assert.match(h1, /--brand-primary:17 34 51/);
  assert.match(h1, /<script id="cm-branding" type="application\/json">\{"version":1,/);
  assert.equal(await state.brandedIndexHtml(file), h1, 'cached');
  // another instance changes the branding: the DB row moves on, this process learns via the reload message
  row = { ...row!, productName: 'Other', version: 2 };
  assert.equal(await state.brandedIndexHtml(file), h1, 'still cached until the reload message');
  assert.equal(state.isBrandingReload('{"type":"branding"}'), true);
  assert.equal(state.isBrandingReload('{"type":"global-settings"}'), false);
  assert.equal(state.isBrandingReload('security'), false);
  state.invalidateBranding();
  assert.match((await state.brandedIndexHtml(file))!, /<title>Other<\/title>/);
  assert.equal(await state.brandedIndexHtml(join(dir, 'missing.html')), null);
});

test('asset lock: a concurrent replace never deletes an object another upload has just referenced', async () => {
  // logoLight = X; then A sets favicon = X (same bytes) while B replaces logoLight with Y.
  // Unserialised, B would compute "X unreferenced" before A references it and delete X.
  const x = png(32, 32);
  const xKey = `branding/${createHash('sha256').update(x).digest('hex')}.png`;
  await call('POST', `${A}/assets/logoLight`, { role: ORG, body: x, type: 'image/png' });
  let entered!: () => void;
  const aInside = new Promise<void>((r) => { entered = r; });
  let releaseA!: () => void;
  findHook = () => { entered(); return new Promise<void>((r) => { releaseA = r; }); };
  const a = call('POST', `${A}/assets/favicon`, { role: ORG, body: x, type: 'image/png' });
  await aInside; // A has stored X and waits inside its row read
  const b = call('POST', `${A}/assets/logoLight`, { role: ORG, body: png(40, 40), type: 'image/png' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(row!['logoLightKey'], xKey, 'B waits for the lock');
  releaseA();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(row!['faviconKey'], xKey);
  assert.notEqual(row!['logoLightKey'], xKey);
  assert.ok(objects.has(xKey), 'X still stored — referenced by the favicon');
  assert.ok(!deleted.includes(xKey));
  assert.equal(lockKv.size, 0, 'lock released');
});

test('asset lock: held by another instance → waits; held too long → 409 BUSY, nothing changed', async () => {
  assetLock.setAssetLockTiming({ waitMs: 300, retryMs: 20 });
  try {
    lockKv.set(assetLock.BRANDING_ASSET_LOCK_KEY, 'other-instance');
    setTimeout(() => lockKv.delete(assetLock.BRANDING_ASSET_LOCK_KEY), 100);
    const ok = await call('DELETE', `${A}/assets/favicon`, { role: ORG });
    assert.equal(ok.status, 200, 'acquired after the other instance released it');
    lockKv.set(assetLock.BRANDING_ASSET_LOCK_KEY, 'other-instance');
    const busy = await call('POST', `${A}/assets/logoLight`, { role: ORG, body: png(20, 20), type: 'image/png' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json['code'], 'BUSY');
    assert.equal(row!['logoLightKey'], null);
    assert.equal(objects.size, 0, 'nothing stored while busy');
    assert.equal((await call('POST', `${A}/reset`, { role: ORG })).status, 409);
    assert.equal(lockKv.get(assetLock.BRANDING_ASSET_LOCK_KEY), 'other-instance', 'a foreign lock is never released');
  } finally {
    assetLock.setAssetLockTiming({ waitMs: 10_000, retryMs: 100 });
  }
});

test('public assets: served from an in-memory cache keyed by the content hash; a branding change drops it', async () => {
  const up = await call('POST', `${A}/assets/logoLight`, { role: ORG, body: png(30, 30), type: 'image/png' });
  const url = String((up.json['assets'] as Row)['logoLight']);
  storeGets = 0;
  for (let i = 0; i < 5; i++) {
    const r = await call('GET', `${url}?v=${i}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  assert.equal(storeGets, 1, 'one object-store read for five requests (cache busters ignored)');
  await call('DELETE', `${A}/assets/logoLight`, { role: ORG });
  assert.equal((await call('GET', url)).status, 404, 'a removed asset is not served from the cache');
  assert.equal((await call('GET', `/branding/assets/${'1'.repeat(64)}.png`)).status, 404);
});

test('favicon derived from a PNG logo: square 64 / 180 px PNGs for the current logo, gone once an own favicon is set', async () => {
  const data = Buffer.alloc(120 * 40 * 4);
  for (let i = 0; i < 120 * 40; i++) data.set([200, 60, 10, 255], i * 4);
  const logo = encodePng({ width: 120, height: 40, data });
  assert.equal((await call('POST', `${A}/assets/logoLight`, { role: ORG, body: logo, type: 'image/png' })).status, 200);
  const sha = createHash('sha256').update(logo).digest('hex');
  const icon = await call('GET', `/branding/favicons/${sha}-64.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
  assert.match(icon.headers.get('cache-control') ?? '', /immutable/);
  const img = decodePng(icon.buf);
  assert.deepEqual([img.width, img.height], [64, 64]);
  assert.equal(img.data[3], 0, 'padding above the wide logo is transparent');
  assert.equal(decodePng((await call('GET', `/branding/favicons/${sha}-180.png`)).buf).width, 180);
  assert.equal((await call('GET', `/branding/favicons/${sha}-32.png`)).status, 404, 'no such size');
  assert.equal((await call('GET', `/branding/favicons/${'2'.repeat(64)}-64.png`)).status, 404, 'not the current logo');
  await call('POST', `${A}/assets/favicon`, { role: ORG, body: encodePng({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 4, 255) }), type: 'image/png' });
  assert.equal((await call('GET', `/branding/favicons/${sha}-64.png`)).status, 404, 'an own favicon replaces the derived one');
});
