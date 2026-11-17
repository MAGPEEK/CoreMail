/**
 * SSE fan-out + Web Push once per event, push-subscription SSRF validation.
 * Run: node --import tsx --test src/lib/sse-hub.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { SseHub } = await import('./sse-hub.js');
const { validatePushSubscription } = await import('../routes/push.js');

function conn(userId: string, isAdmin = false) {
  const got: Array<[string, unknown]> = [];
  return { userId, isAdmin, got, send: (e: string, d: unknown) => { got.push([e, d]); } };
}

/** `webmailOff`: users whose Webmail switch is off (9.4); 'broken' → the switch cannot be read. */
function hub(webmailOff: Set<string> = new Set()) {
  const pushes: string[] = [];
  const claims = new Set<string>();
  const h = new SseHub({
    pushMailNew: async (userId) => { pushes.push(userId); },
    claimPush: async (k) => { if (claims.has(k)) return false; claims.add(k); return true; },
    webmailAllowed: async (userId) => {
      if (userId === 'broken') throw new Error('db down');
      return !webmailOff.has(userId);
    },
  });
  return { h, pushes };
}

const mailNew = (userId: string | undefined, messageId = 'm1') => JSON.stringify({ ...(userId ? { userId } : {}), messageId, subject: 'Hi' });

test('mail:new reaches all tabs of the owner, push is sent exactly once', async () => {
  const { h, pushes } = hub();
  const a1 = conn('alice'); const a2 = conn('alice'); const b = conn('bob');
  h.add(a1); h.add(a2); h.add(b);
  await h.dispatch('mail:new', mailNew('alice'));
  assert.equal(a1.got.length, 1);
  assert.equal(a2.got.length, 1);
  assert.equal(b.got.length, 0);
  assert.deepEqual(pushes, ['alice']);
  // the same event delivered again (e.g. by a second gateway instance) → no second push
  await h.dispatch('mail:new', mailNew('alice'));
  assert.deepEqual(pushes, ['alice']);
});

test('push is sent even without any open SSE connection', async () => {
  const { h, pushes } = hub();
  await h.dispatch('mail:new', mailNew('carol', 'm9'));
  assert.deepEqual(pushes, ['carol']);
});

test('events without userId reach nobody', async () => {
  const { h, pushes } = hub();
  const a = conn('alice'); h.add(a);
  await h.dispatch('mail:new', mailNew(undefined));
  await h.dispatch('mail:update', JSON.stringify({ folderId: 'f' }));
  assert.equal(a.got.length, 0);
  assert.deepEqual(pushes, []);
});

test('per-user channel, calendar shares, admin events and removal', async () => {
  const { h } = hub();
  const a = conn('alice'); const b = conn('bob'); const adm = conn('root', true);
  const removeA = h.add(a); h.add(b); h.add(adm);
  await h.dispatch('user:bob:events', JSON.stringify({ x: 1 }));
  assert.deepEqual(b.got.map((g) => g[0]), ['notification']);
  assert.equal(a.got.length, 0);
  await h.dispatch('calendar:shares', JSON.stringify({ affectedUserIds: ['alice', 'alice'] }));
  assert.deepEqual(a.got.map((g) => g[0]), ['calendar:shares']);
  await h.dispatch('admin:attack', JSON.stringify({ ip: '1.2.3.4' }));
  assert.deepEqual(adm.got.map((g) => g[0]), ['security:attack']);
  assert.equal(b.got.length, 1);
  removeA();
  await h.dispatch('mail:update', JSON.stringify({ userId: 'alice' }));
  assert.equal(a.got.length, 1);
  assert.equal(h.connectionCount, 2);
});

test('9.4: Webmail off → no mailbox event and no Web Push for that user; an admin stream keeps admin events', async () => {
  const { h, pushes } = hub(new Set(['root', 'bob']));
  const adm = conn('root', true); const b = conn('bob'); const a = conn('alice'); const x = conn('broken');
  h.add(adm); h.add(b); h.add(a); h.add(x);
  for (const userId of ['root', 'bob', 'alice', 'broken']) {
    await h.dispatch('mail:new', mailNew(userId, `m-${userId}`));
    await h.dispatch('mail:update', JSON.stringify({ userId }));
    await h.dispatch(`user:${userId}:events`, JSON.stringify({ reminder: 1 }));
  }
  await h.dispatch('calendar:shares', JSON.stringify({ affectedUserIds: ['bob', 'alice'] }));
  await h.dispatch('admin:attack', JSON.stringify({ ip: '1.2.3.4' }));
  assert.deepEqual(adm.got.map((g) => g[0]), ['security:attack'], 'the BCP stream gets admin events only');
  assert.equal(b.got.length, 0);
  assert.equal(x.got.length, 0, 'an unreadable switch withholds the event');
  assert.deepEqual(a.got.map((g) => g[0]), ['mail:new', 'mail:update', 'notification', 'calendar:shares']);
  assert.deepEqual(pushes, ['alice']);
});

test('push subscription validation: https public endpoint + key sizes', async () => {
  const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
  const pub = async () => ['142.250.0.1'];
  assert.deepEqual(await validatePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }, pub), { ok: true });
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x']) {
    assert.equal((await validatePushSubscription({ endpoint, keys }, pub)).ok, false, endpoint);
  }
  assert.equal((await validatePushSubscription({ endpoint: 'https://push.evil.example/x', keys }, async () => ['10.0.0.8'])).ok, false);
  assert.equal((await validatePushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'short' } }, pub)).ok, false);
});
