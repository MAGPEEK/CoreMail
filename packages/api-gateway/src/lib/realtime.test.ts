/**
 * 9.4 realtime announcements of the REST writers + the webmail manifest.
 * Run: node --import tsx --test --test-force-exit src/lib/realtime.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const published: Array<{ channel: string; message: unknown }> = [];
globalThis.__realtimeRedis = { publish: async (channel, message) => { published.push({ channel, message: JSON.parse(message) }); return 1; } };

const { announceOnWrite, settingsSectionOf, actionOf } = await import('./realtime.js');
const { webManifest, BUILTIN_APP_ICON } = await import('./branding/manifest.js');

/** Runs the middleware for one request and finishes the response with `status`. */
async function write(mw: ReturnType<typeof announceOnWrite>, method: string, path: string, status: number, userId = 'u1') {
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  const req = { method, path, apiUser: { userId } };
  let nextCalled = false;
  mw(req as never, res as never, () => { nextCalled = true; });
  assert.ok(nextCalled);
  res.emit('finish');
  await new Promise((r) => setImmediate(r));
}

test('settingsSectionOf: settings paths map to their area, everything else is no settings change', () => {
  assert.equal(settingsSectionOf('/profile'), 'profile');
  assert.equal(settingsSectionOf('/signature'), 'signature');
  assert.equal(settingsSectionOf('/oof'), 'oof');
  assert.equal(settingsSectionOf('/preferences'), 'preferences');
  assert.equal(settingsSectionOf('/rules/abc/toggle'), 'rules');
  assert.equal(settingsSectionOf('/rules/abc/run-now'), null);
  assert.equal(settingsSectionOf('/accessible-mailboxes/shared:1'), 'mailboxes');
  assert.equal(settingsSectionOf('/change-password'), null);
  assert.equal(settingsSectionOf('/shared-mailboxes/1/folders'), null);
  assert.deepEqual(['POST', 'PUT', 'PATCH', 'DELETE'].map(actionOf), ['create', 'update', 'update', 'delete']);
});

test('announceOnWrite: successful writes reach the acting user; reads and failures do not', async () => {
  published.length = 0;
  const mw = announceOnWrite({ type: 'tasks' });
  await write(mw, 'POST', '/', 201);
  await write(mw, 'DELETE', '/t1', 200);
  await write(mw, 'PUT', '/t1', 404);
  await write(mw, 'GET', '/', 200);
  assert.deepEqual(published, [
    { channel: 'user:u1:events', message: { type: 'tasks', action: 'create' } },
    { channel: 'user:u1:events', message: { type: 'tasks', action: 'delete' } },
  ]);
});

test('announceOnWrite with a function: the path seen on entry decides', async () => {
  published.length = 0;
  const mw = announceOnWrite(({ path }) => (path.startsWith('/messages') ? null : { type: 'settings', section: 'categories' }));
  await write(mw, 'POST', '/messages/m1', 200);
  await write(mw, 'PATCH', '/c1', 200);
  assert.deepEqual(published, [{ channel: 'user:u1:events', message: { type: 'settings', section: 'categories' } }]);
});

const branding = {
  version: 1, productName: 'Example Mail Service', primaryColor: '#123456', headerColor: null,
  allowUserAccent: true, showPoweredBy: true, loginText: '', footerLinks: [],
  assets: { logoLight: null, logoDark: null, favicon: null, loginBackground: null },
};

test('webManifest: name, colours and icons from the branding; built-in icon always present', () => {
  const m = webManifest(branding);
  assert.equal(m.name, 'Example Mail Service');
  assert.equal(m.short_name, 'Example Mail');
  assert.equal(m.start_url, '/mail');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#123456');
  assert.deepEqual(m.icons, [{ src: BUILTIN_APP_ICON, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]);
  const withFav = webManifest({ ...branding, headerColor: '#abcdef', assets: { ...branding.assets, favicon: `/branding/assets/${'a'.repeat(64)}.png` } });
  assert.equal(withFav.theme_color, '#abcdef');
  assert.equal(withFav.icons[0]!.type, 'image/png');
  assert.equal(withFav.icons.length, 2);
});
