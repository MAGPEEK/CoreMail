/**
 * SSE fan-out + Web Push once per event, push-subscription SSRF validation,
 * 9.4 realtime routing (mailbox changes by audience, typed user events,
 * branding broadcast) and the new-mail notification payload.
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

const { SseHub, cachedAudience } = await import('./sse-hub.js');
const { validatePushSubscription } = await import('../routes/push.js');
const { mailNotification, mailDeepLink, isNotifiable } = await import('./mail-notification.js');

function conn(userId: string, isAdmin = false) {
  const got: Array<[string, unknown]> = [];
  return { userId, isAdmin, got, send: (e: string, d: unknown) => { got.push([e, d]); } };
}

type Member = { userId: string; mailboxKey: string; sharedMailboxId?: string };
const AUDIENCES: Record<string, Member[]> = {
  'mb-alice': [{ userId: 'alice', mailboxKey: 'own' }, { userId: 'bob', mailboxKey: 'delegated:mb-alice' }],
  'mb-team': [{ userId: 'alice', mailboxKey: 'shared:s1', sharedMailboxId: 's1' }, { userId: 'broken', mailboxKey: 'shared:s1', sharedMailboxId: 's1' }],
};

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
    mailboxAudience: async (mailboxId) => {
      if (mailboxId === 'mb-fail') throw new Error('db down');
      return AUDIENCES[mailboxId] ?? [];
    },
  });
  return { h, pushes };
}

const mailNew = (userId: string | undefined, messageId = 'm1') => JSON.stringify({ ...(userId ? { userId } : {}), messageId, subject: 'Hi' });
const names = (c: ReturnType<typeof conn>) => c.got.map((g) => g[0]);

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

test('events without an owner reach nobody; retired channels are ignored', async () => {
  const { h, pushes } = hub();
  const a = conn('alice'); h.add(a);
  await h.dispatch('mail:new', mailNew(undefined));
  await h.dispatch('mail:update', JSON.stringify({ userId: 'alice' }));
  await h.dispatch('calendar:shares', JSON.stringify({ affectedUserIds: ['alice'] }));
  assert.equal(a.got.length, 0);
  assert.deepEqual(pushes, []);
});

test('9.4 mailbox:changes → `mailbox` to every connected user who sees it, with their mailbox key', async () => {
  const { h } = hub();
  const a = conn('alice'); const b = conn('bob'); const c = conn('carol');
  h.add(a); h.add(b); h.add(c);
  await h.dispatch('mailbox:changes', JSON.stringify({ mailboxId: 'mb-alice', kinds: ['messages'], folderIds: ['f1'], modSeq: '7' }));
  await h.dispatch('mailbox:changes', JSON.stringify({ mailboxId: 'mb-team', kinds: ['flags'] }));
  assert.deepEqual(a.got, [
    ['mailbox', { mailbox: 'own', kinds: ['messages'], folderIds: ['f1'] }],
    ['mailbox', { mailbox: 'shared:s1', kinds: ['flags'], sharedMailboxId: 's1' }],
  ]);
  assert.deepEqual(b.got, [['mailbox', { mailbox: 'delegated:mb-alice', kinds: ['messages'], folderIds: ['f1'] }]]);
  assert.equal(c.got.length, 0, 'not in the audience');
  // an unreadable audience or a malformed message withholds the change
  await h.dispatch('mailbox:changes', JSON.stringify({ mailboxId: 'mb-fail', kinds: ['messages'] }));
  await h.dispatch('mailbox:changes', '{"kinds":["messages"]}');
  assert.equal(a.got.length, 2);
});

test('9.4 user:<id>:events → one typed event to that user only; branding to everyone', async () => {
  const { h } = hub();
  const a = conn('alice'); const b = conn('bob'); const adm = conn('root', true);
  h.add(a); h.add(b); h.add(adm);
  await h.dispatch('user:bob:events', JSON.stringify({ type: 'contacts', action: 'create', ids: ['c1'] }));
  await h.dispatch('user:bob:events', JSON.stringify({ type: 'calendar', scope: 'shares', action: 'create', calendarIds: ['k1'] }));
  await h.dispatch('user:bob:events', JSON.stringify({ x: 1 })); // malformed → dropped
  assert.deepEqual(b.got, [
    ['contacts', { type: 'contacts', action: 'create', ids: ['c1'] }],
    ['calendar', { type: 'calendar', action: 'create', calendarIds: ['k1'], scope: 'shares' }],
  ]);
  assert.equal(a.got.length, 0);
  await h.dispatch('settings:reload', JSON.stringify({ type: 'branding' }));
  await h.dispatch('settings:reload', 'security'); // other publishers send plain strings
  assert.deepEqual([names(a), names(adm)], [['branding'], ['branding']]);
});

test('admin events and removal', async () => {
  const { h } = hub();
  const a = conn('alice'); const adm = conn('root', true);
  const removeA = h.add(a); h.add(adm);
  await h.dispatch('admin:attack', JSON.stringify({ ip: '1.2.3.4' }));
  assert.deepEqual(names(adm), ['security:attack']);
  assert.equal(a.got.length, 0);
  removeA();
  await h.dispatch('user:alice:events', JSON.stringify({ type: 'tasks' }));
  assert.equal(a.got.length, 0);
  assert.equal(h.connectionCount, 1);
});

test('9.4: Webmail off → no mailbox event and no Web Push for that user; an admin stream keeps admin events', async () => {
  const { h, pushes } = hub(new Set(['root', 'bob']));
  const adm = conn('root', true); const b = conn('bob'); const a = conn('alice'); const x = conn('broken');
  h.add(adm); h.add(b); h.add(a); h.add(x);
  for (const userId of ['root', 'bob', 'alice', 'broken']) {
    await h.dispatch('mail:new', mailNew(userId, `m-${userId}`));
    await h.dispatch(`user:${userId}:events`, JSON.stringify({ type: 'notes' }));
  }
  await h.dispatch('mailbox:changes', JSON.stringify({ mailboxId: 'mb-alice', kinds: ['messages'] }));
  await h.dispatch('mailbox:changes', JSON.stringify({ mailboxId: 'mb-team', kinds: ['messages'] }));
  await h.dispatch('admin:attack', JSON.stringify({ ip: '1.2.3.4' }));
  assert.deepEqual(names(adm), ['security:attack'], 'the BCP stream gets admin events only');
  assert.equal(b.got.length, 0);
  assert.equal(x.got.length, 0, 'an unreadable switch withholds the event');
  assert.deepEqual(names(a), ['mail:new', 'notes', 'mailbox', 'mailbox']);
  assert.deepEqual(pushes, ['alice']);
});

test('cachedAudience: one lookup per mailbox within the TTL; clear() and failures reload', async () => {
  let now = 0; let loads = 0; let fail = false;
  const cache = cachedAudience(async (id) => { loads++; if (fail) throw new Error('x'); return [{ userId: id, mailboxKey: 'own' }]; }, 1000, () => now);
  await cache.get('m1'); await cache.get('m1');
  assert.equal(loads, 1);
  now = 1500; await cache.get('m1');
  assert.equal(loads, 2);
  cache.clear(); await cache.get('m1');
  assert.equal(loads, 3);
  fail = true; cache.clear();
  await assert.rejects(cache.get('m2'));
  fail = false; await cache.get('m2');
  assert.equal(loads, 5, 'a failed lookup is not cached');
});

test('9.4 new-mail notification: generic unless the device opted into previews; deep link; junk not announced', () => {
  const ev = { userId: 'u', mailbox: 'shared:s1', folderId: 'f1', messageId: 'm1', fromName: 'Ann', fromAddr: 'ann@example.test', subject: 'Budget' };
  assert.deepEqual(mailNotification(ev, { preview: false, productName: 'Mail' }), {
    tag: 'mail-m1', url: '/mail?mailbox=shared%3As1&folder=f1&message=m1', data: { kind: 'mail.new' }, title: 'Mail', body: 'Neue Nachricht',
  });
  const p = mailNotification(ev, { preview: true, productName: 'Mail' });
  assert.equal(p.title, 'Ann');
  assert.equal(p.body, 'Budget');
  assert.equal(mailNotification({ ...ev, fromName: '', subject: '' }, { preview: true, productName: 'Mail' }).title, 'ann@example.test');
  assert.equal(mailDeepLink({ folderId: 'f1', messageId: 'm1', mailbox: 'own' }), '/mail?folder=f1&message=m1');
  assert.equal(mailDeepLink({ folderId: '../x', messageId: 'm1' }), '/mail', 'unsafe ids → plain mail view');
  assert.equal(mailDeepLink({ folderId: 'f1', messageId: 'm1', mailbox: 'evil:1' }), '/mail?folder=f1&message=m1');
  assert.equal(isNotifiable({ isJunk: true }), false);
  assert.equal(isNotifiable({}), true);
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
