/**
 * 9.4 webmail policies on the REST API: path → module mapping, the
 * requireAuth gate (403 FEATURE_DISABLED / 503), GET /user/features,
 * preference sections, trusted senders, the upload limit, the compose
 * autocomplete without contacts and the stream peek used for sniffing.
 * Loopback Express app, in-memory Prisma (@coremail/storage/auth/testing).
 * Run: node --import tsx --test --test-force-exit src/lib/webmail-features.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const { createFakePrisma, createFakeRedis, FakeTable } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
(globalThis as Record<string, unknown>)['__authRedis'] = createFakeRedis();
(globalThis as Record<string, unknown>)['__realtimeRedis'] = null;
db['userSettings'] = new FakeTable(() => ({ inactivityTimeoutMinutes: null, preferences: null }), ['id', 'userId']);
(globalThis as Record<string, unknown>)['__prisma'] = db;

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const { featuresForRequest, featureRefusal } = await import('./webmail-features.js');
const { oversizedUpload, enforceUploadPolicy } = await import('./upload-policy.js');
const { peekStream } = await import('./stream-peek.js');
const { requireAuth } = await import('../middleware/auth.js');
const { userPolicyRouter } = await import('../routes/user-policy.js');
const { userSettingsRouter, refusedPreferenceFeature, preferencesUnderPolicy } = await import('../routes/user-settings.js');
const { DEFAULT_PREFERENCES } = await import('./user-preferences.js');

const token = core.signAccessToken({ sub: 'u1', email: 'u1@one.test', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false });
let server: Server;
let base = '';

before(async () => {
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  await db.user.create({ data: { id: 'u1', email: 'u1@one.test', domainId: 'd1', passwordHash: 'x' } });
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/user', userSettingsRouter);
  app.use('/api/v1/user', userPolicyRouter);
  // stand-ins for the module routers: the gate lives in requireAuth
  for (const p of ['/api/v1/calendar', '/api/v1/tasks', '/api/v1/user/rules', '/api/v1/mail/messages']) {
    app.use(p, requireAuth, (_req, res) => { res.json({ ok: true }); });
  }
  app.post('/api/v1/upload', (req, _res, next) => {
    (req as unknown as { files: unknown }).files = [{ originalname: 'big.bin', size: 3 * 1024 * 1024 }];
    next();
  }, requireAuth, enforceUploadPolicy, (_req, res) => { res.json({ ok: true }); });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => {
  db.webmailPolicy.rows = [];
  db.trustedImageSender.rows = [];
  storage.invalidateWebmailPolicyCache();
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const setPolicy = (level: 'global' | 'user', patch: Parameters<typeof storage.updateWebmailPolicy>[1]) =>
  storage.updateWebmailPolicy(level === 'global' ? { level } : { level, userId: 'u1' }, patch);

// ── Pure mapping ──────────────────────────────────────────────────────────────

test('path → module: every switchable area, nothing for mail, admin and events', () => {
  const cases: Array<[string, string, string[]]> = [
    ['GET', '/api/v1/calendar/events?x=1', ['calendar']],
    ['GET', '/api/v1/contacts', ['contacts']],
    ['GET', '/api/v1/contacts/gal', ['contacts']],
    ['POST', '/api/v1/tasks', ['tasks']],
    ['GET', '/api/v1/notes/abc', ['notes']],
    ['PUT', '/api/v1/user/rules/r1', ['rules']],
    ['GET', '/api/v1/user/signatures', ['signatures']],
    ['PUT', '/api/v1/user/signature', ['signatures']],
    ['POST', '/api/v1/categories/messages/bulk', ['categories']],
    ['GET', '/api/v1/mail/recoverable', ['recoverItems']],
    ['POST', '/api/v1/user/change-password', ['changePassword']],
    ['GET', '/api/v1/user/client-config', ['externalClients']],
    ['GET', '/api/v1/user/apple-profile?type=eas', ['externalClients']],
    ['GET', '/api/v1/user/shared-mailboxes', ['sharedMailboxes']],
    ['GET', '/api/v1/mail/shared-mailboxes/s1/folders', ['sharedMailboxes']],
    ['GET', '/api/v1/mail/delegated-mailboxes', ['sharedMailboxes']],
    ['PATCH', '/api/v1/user/accessible-mailboxes/shared:1', ['sharedMailboxes']],
    ['POST', '/api/v1/user/shared-mailboxes/s1/recoverable/restore', ['sharedMailboxes', 'recoverItems']],
    ['GET', '/api/v1/mail/delegated-mailboxes/m1/recoverable', ['sharedMailboxes', 'recoverItems']],
    ['GET', '/api/v1/mail/messages/m1', []],
    ['GET', '/api/v1/user/features', []],
    ['GET', '/api/v1/user/preferences', []],
    ['GET', '/api/v1/user/signature-images', []],
    ['GET', '/api/v1/calendarx', []],
    ['GET', '/api/v1/admin/protocol-access', []],
    ['GET', '/api/v1/events', []],
  ];
  for (const [method, url, expected] of cases) assert.deepEqual(featuresForRequest(method, url), expected, `${method} ${url}`);
  assert.deepEqual(featuresForRequest('GET', '/api/v1/contacts', { q: 'an' }), [], 'compose autocomplete stays available');
  assert.deepEqual(featuresForRequest('GET', '/api/v1/contacts', { q: 'a' }), ['contacts']);
  assert.deepEqual(featuresForRequest('GET', undefined), []);
});

test('review: the path is matched case-insensitively like Express routes it (no bypass via /Calendar)', () => {
  assert.deepEqual(featuresForRequest('GET', '/api/v1/CALENDAR/events'), ['calendar']);
  assert.deepEqual(featuresForRequest('GET', '/API/v1/Tasks'), ['tasks']);
  assert.deepEqual(featuresForRequest('PUT', '/api/v1/User/Rules/r1'), ['rules']);
  assert.deepEqual(featuresForRequest('GET', '/api/v1/user/Shared-Mailboxes/s1/Recoverable'), ['sharedMailboxes', 'recoverItems']);
  assert.deepEqual(featuresForRequest('GET', '/api/v1/Contacts', { q: 'an' }), [], 'autocomplete exception unchanged');
});

test('featureRefusal: 403 for a module that is off, 503 when the policy cannot be read', async () => {
  const req = { method: 'GET', originalUrl: '/api/v1/tasks', query: {} };
  const off = { features: { ...storage.FEATURE_DEFAULTS, tasks: false }, content: { ...storage.CONTENT_DEFAULTS } };
  assert.deepEqual(await featureRefusal('u1', req as never, async () => off as never),
    { status: 403, body: { error: 'tasks is disabled for this account', code: 'FEATURE_DISABLED', feature: 'tasks' } });
  assert.equal((await featureRefusal('u1', req as never, async () => { throw new Error('db'); }))?.status, 503);
  assert.equal(await featureRefusal('u1', { ...req, originalUrl: '/api/v1/mail/folders' } as never, async () => { throw new Error('never read'); }), null);
});

// ── Gate in requireAuth ───────────────────────────────────────────────────────

test('requireAuth refuses the routes of a module that is off and lets the others through', async () => {
  assert.equal((await call('GET', '/api/v1/calendar/events')).status, 200);
  await setPolicy('global', { features: { calendar: 'off' } });
  const r = await call('GET', '/api/v1/calendar/events');
  assert.equal(r.status, 403);
  assert.equal(r.body['code'], 'FEATURE_DISABLED');
  assert.equal(r.body['feature'], 'calendar');
  assert.equal((await call('POST', '/api/v1/tasks')).status, 200);
  assert.equal((await call('GET', '/api/v1/mail/messages/m1')).status, 200);
  await setPolicy('user', { features: { calendar: 'on', rules: 'off' } });
  assert.equal((await call('GET', '/api/v1/calendar/events')).status, 200, 'the user level wins');
  assert.equal((await call('PUT', '/api/v1/user/rules/r1')).status, 403);
});

test('review: a differently cased path that Express still routes to the module is refused too', async () => {
  await setPolicy('global', { features: { calendar: 'off' } });
  const r = await call('GET', '/api/v1/Calendar/events');
  assert.equal(r.status, 403, 'Express routes /Calendar to the calendar router — the gate must see it');
  assert.equal(r.body['feature'], 'calendar');
});

// ── GET /user/features ────────────────────────────────────────────────────────

test('GET /user/features: modules, content policy, change password only for local accounts', async () => {
  const before = await call('GET', '/api/v1/user/features');
  assert.equal(before.status, 200);
  assert.equal(before.body['features'].calendar, true);
  assert.equal(before.body['features'].changePassword, true);
  assert.deepEqual(before.body['content'], { blockedExtensions: [], downloadOnlyExtensions: [], maxUploadBytes: null, externalImages: 'ask' });
  await setPolicy('global', { features: { notes: 'off' }, content: { blockedExtensions: ['exe'], maxUploadMb: 2, externalImages: 'block' } });
  const after = await call('GET', '/api/v1/user/features');
  assert.equal(after.body['features'].notes, false);
  assert.deepEqual(after.body['content'], { blockedExtensions: ['exe'], downloadOnlyExtensions: [], maxUploadBytes: 2 * 1024 * 1024, externalImages: 'block' });
  const user = db.user.rows.find((u) => u['id'] === 'u1')!;
  user['authSource'] = 'LDAP';
  try {
    assert.equal((await call('GET', '/api/v1/user/features')).body['features'].changePassword, false);
  } finally {
    user['authSource'] = 'LOCAL';
  }
});

// ── Preferences ───────────────────────────────────────────────────────────────

test('preferences: theme / signature defaults are refused with the module off; the default design applies', async () => {
  const features = { ...storage.FEATURE_DEFAULTS, themes: false };
  assert.equal(refusedPreferenceFeature({ theme: { mode: 'dark' } }, features), 'themes');
  assert.equal(refusedPreferenceFeature({ view: {} }, features), null);
  const prefs = { ...DEFAULT_PREFERENCES, theme: { mode: 'dark' as const, accentRgb: '1 2 3' } };
  assert.deepEqual(preferencesUnderPolicy(prefs, features).theme, DEFAULT_PREFERENCES.theme);
  assert.equal(preferencesUnderPolicy(prefs, storage.FEATURE_DEFAULTS).theme.mode, 'dark');
  await setPolicy('user', { features: { themes: 'off' } });
  const r = await call('PATCH', '/api/v1/user/preferences', { preferences: { theme: { mode: 'dark' } } });
  assert.equal(r.status, 403);
  assert.equal(r.body['feature'], 'themes');
});

// ── Trusted senders ───────────────────────────────────────────────────────────

test('trusted senders: add, list, remove, invalid entries refused', async () => {
  assert.equal((await call('POST', '/api/v1/user/trusted-senders', { sender: 'News@Example.org' })).status, 201);
  assert.equal((await call('POST', '/api/v1/user/trusted-senders', { sender: 'not an address' })).body['code'], 'INVALID_SENDER');
  assert.deepEqual((await call('GET', '/api/v1/user/trusted-senders')).body['senders'], ['news@example.org']);
  assert.equal((await call('DELETE', `/api/v1/user/trusted-senders/${encodeURIComponent('news@example.org')}`)).status, 200);
  assert.equal((await call('DELETE', '/api/v1/user/trusted-senders/x%40y.test')).status, 404);
});

// ── Upload limit ──────────────────────────────────────────────────────────────

test('upload: an attachment over the policy limit is refused with 413 ATTACHMENT_TOO_LARGE', async () => {
  assert.equal(oversizedUpload([{ originalname: 'a', size: 10 }], null), null);
  assert.equal(oversizedUpload([{ originalname: 'a', size: 10 }, { originalname: 'b', size: 11 }], 10)?.originalname, 'b');
  assert.equal((await call('POST', '/api/v1/upload')).status, 200, 'no own limit');
  await setPolicy('global', { content: { maxUploadMb: 2 } });
  const r = await call('POST', '/api/v1/upload');
  assert.equal(r.status, 413);
  assert.deepEqual(r.body, { error: 'Anhang zu groß', code: 'ATTACHMENT_TOO_LARGE', maxBytes: 2 * 1024 * 1024, filename: 'big.bin' });
});

// ── Stream peek ───────────────────────────────────────────────────────────────

test('peekStream: the head is read, the stream still yields everything (short, long, empty)', async () => {
  const collect = async (s: Readable) => { const parts: Buffer[] = []; for await (const c of s) parts.push(Buffer.from(c)); return Buffer.concat(parts).toString(); };
  const long = await peekStream(Readable.from([Buffer.from('abc'), Buffer.from('defgh'), Buffer.from('ij')]), 4);
  assert.equal(long.head.toString(), 'abcd');
  assert.equal(await collect(long.stream), 'abcdefghij');
  const short = await peekStream(Readable.from([Buffer.from('xy')]), 100);
  assert.equal(short.head.toString(), 'xy');
  assert.equal(await collect(short.stream), 'xy');
  const empty = await peekStream(Readable.from([]), 10);
  assert.equal(empty.head.length, 0);
  assert.equal(await collect(empty.stream), '');
  const failing = new Readable({ read() { this.destroy(new Error('boom')); } });
  await assert.rejects(peekStream(failing, 10), /boom/);
});
