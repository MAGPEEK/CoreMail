/**
 * Session contexts: Redis record with idle TTL, sequence cookie rotation,
 * idle expiry, per-user cap and live termination by credential / protocol
 * switch changes (LiveConnectionRegistry, protocol `mapi`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnectionRegistry, PROTOCOL_ACCESS_CHANGE } from '@coremail/core';
import { SessionRegistry, MAX_SESSIONS_PER_USER } from './registry.js';
import { cookieDigest, MapiSession, type SessionAuth } from './session.js';
import { queueNotificationSource } from '../emsmdb/notification-wait.js';
import { MemoryRedis } from '../testing/memory-redis.js';

function auth(userId = 'u1', credential: SessionAuth['credential'] = 'app_password'): SessionAuth {
  return {
    user: { userId, email: `${userId}@example.test`, displayName: userId, domainId: 'd1' },
    credential, ...(credential === 'app_password' ? { appPasswordId: 'ap1' } : {}), authKey: `key-${userId}`,
  };
}

function setup(idleMs = 1000) {
  const clock = { t: 1_000 };
  const redis = new MemoryRedis();
  const live = new LiveConnectionRegistry('test', { now: () => clock.t });
  const registry = new SessionRegistry({ redis, live, idleMs, now: () => clock.t });
  const tick = (ms: number): void => { clock.t += ms; redis.now += ms; };
  return { registry, redis, live, clock, tick };
}

test('create: cookies are random, only their hash is the key; lookup refreshes the TTL', async () => {
  const { registry, redis, tick } = setup();
  const { session, context, sequence } = await registry.create(auth(), 1_000);
  assert.match(context, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(context, sequence);
  assert.equal(session.id, cookieDigest(context));
  assert.deepEqual([...redis.store.keys()], [`mapi:ctx:${cookieDigest(context)}`]);
  assert.equal([...redis.store.values()][0]!.value.includes(context), false);
  tick(800);
  assert.equal(await registry.lookup(context), session);
  tick(800);
  assert.equal(await registry.lookup(context), session, 'still alive: the lookup refreshed it');
});

test('idle expiry, missing Redis record and Disconnect end the session', async () => {
  const { registry, redis, tick } = setup();
  const a = await registry.create(auth(), 1_000);
  tick(1500);
  assert.equal(await registry.lookup(a.context), null);
  assert.equal(redis.store.size, 0);
  const b = await registry.create(auth(), 2_500);
  redis.store.clear();
  assert.equal(await registry.lookup(b.context), null, 'record gone (server restart elsewhere / revoked)');
  const c = await registry.create(auth(), 2_500);
  await registry.end(c.session);
  assert.equal(await registry.lookup(c.context), null);
  assert.equal(c.session.closed, true);
});

test('sweep ends idle sessions, never one with a request in progress', async () => {
  const { registry, tick } = setup();
  const idle = await registry.create(auth('u1'), 1_000);
  const busy = await registry.create(auth('u2'), 1_000);
  busy.session.busy = true;
  tick(2000);
  assert.equal(await registry.sweep(), 1);
  assert.equal(idle.session.closed, true);
  assert.equal(busy.session.closed, false);
});

test('sequence cookie: the presented value must match and is rotated per request', () => {
  const s = new MapiSession('id', auth(), 'first', 0);
  assert.equal(s.advanceSequence('wrong'), null);
  assert.equal(s.advanceSequence(undefined), null);
  const next = s.advanceSequence('first');
  assert.ok(next);
  assert.equal(s.advanceSequence('first'), null, 'a replayed sequence cookie is refused');
  assert.ok(s.advanceSequence(next!));
});

test('the MAPI switch turned off ends the session; other protocols do not', async () => {
  const { registry, live } = setup();
  const { session } = await registry.create(auth(), 1_000);
  live.terminateAffected({ userId: 'u1', reason: PROTOCOL_ACCESS_CHANGE, disabledProtocols: ['imap'] } as never);
  assert.equal(session.closed, false);
  live.terminateAffected({ userId: 'u1', reason: PROTOCOL_ACCESS_CHANGE, disabledProtocols: ['mapi'] } as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(session.closed, true);
});

test('revoking the app password the session used ends it; a password change does not', async () => {
  const { registry, live } = setup();
  const { session } = await registry.create(auth('u1', 'app_password'), 1_000);
  live.terminateAffected({ userId: 'u1', reason: 'password-change' } as never);
  assert.equal(session.closed, false);
  live.terminateAffected({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' } as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(session.closed, true);
});

test('at most MAX_SESSIONS_PER_USER sessions per account: the least recently used goes', async () => {
  const { registry, tick } = setup(60_000);
  const first = await registry.create(auth(), 1_000);
  for (let i = 1; i < MAX_SESSIONS_PER_USER; i++) { tick(1); await registry.create(auth(), 1_000); }
  assert.equal(first.session.closed, false);
  tick(1);
  await registry.create(auth(), 1_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(first.session.closed, true);
  assert.equal(registry.size, MAX_SESSIONS_PER_USER);
});

test('review 9.4: the session cap counts the sessions of every instance (shared Redis index)', async () => {
  const clock = { t: 1_000 };
  const redis = new MemoryRedis();
  const deps = { redis, idleMs: 600_000, now: () => clock.t };
  const a = new SessionRegistry({ ...deps, live: new LiveConnectionRegistry('a', { now: () => clock.t }) });
  const b = new SessionRegistry({ ...deps, live: new LiveConnectionRegistry('b', { now: () => clock.t }) });
  const onA: Array<{ session: MapiSession; context: string }> = [];
  for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) { clock.t += 1; onA.push(await a.create(auth(), clock.t)); }
  clock.t += 1;
  await b.create(auth(), clock.t); // the 17th session, on the other instance
  assert.equal(await a.lookup(onA[0]!.context), null, 'the least recently used session (on instance A) ended');
  assert.equal(onA[0]!.session.closed, true);
  assert.equal(await a.lookup(onA[1]!.context), onA[1]!.session, 'the others stay');
  assert.equal((await redis.zrange('mapi:user-ctx:u1', 0, -1)).length, MAX_SESSIONS_PER_USER);
  await b.create(auth('u2'), clock.t);
  assert.equal(await a.lookup(onA[2]!.context), onA[2]!.session, 'another account does not count');
});

test('lookup with a refusing predicate returns null and does not refresh the session', async () => {
  const { registry, tick } = setup();
  const { session, context } = await registry.create(auth('u1'), 1_000);
  tick(800);
  assert.equal(await registry.lookup(context, (s) => s.user.userId === 'u2'), null);
  assert.equal(session.lastUsed, 1_000, 'not refreshed for a foreign caller');
  tick(400);
  assert.equal(await registry.lookup(context), null, 'idle timeout counted from the last own use');
});

test('NotificationWait: a queued notification wakes the wait at once; one queued before the wait answers immediately', async () => {
  const source = queueNotificationSource(60_000);
  const { registry } = setup();
  const { session } = await registry.create(auth(), 1_000);
  const started = Date.now();
  const waiting = source.wait(session, new AbortController().signal);
  setTimeout(() => session.notifications.push([{ key: 'k', handle: 7, logonId: 0, data: Buffer.from([2, 0x80]) }]), 20);
  assert.equal(await waiting, true);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await source.wait(session, new AbortController().signal), true, 'still queued (not taken yet)');
  session.notifications.take(1024);
  const timedOut = await queueNotificationSource(30).wait(session, new AbortController().signal);
  assert.equal(timedOut, false, 'the timer ends a wait without events');
});

test('sessionsOf(endpoint) lists the live sessions of one endpoint', async () => {
  const { registry } = setup();
  const mailbox = await registry.create(auth('u1'), 1_000);
  const book = await registry.create(auth('u1'), 1_000, 'nspi');
  assert.deepEqual(registry.sessionsOf('emsmdb'), [mailbox.session]);
  assert.deepEqual(registry.sessionsOf('nspi'), [book.session]);
  await registry.end(mailbox.session);
  assert.deepEqual(registry.sessionsOf('emsmdb'), []);
});

test('NotificationWait: the signal ends the wait at once; ending the session aborts it', async () => {
  const source = queueNotificationSource(60_000);
  const { registry } = setup();
  const { session } = await registry.create(auth(), 1_000);
  const abort = new AbortController();
  const started = Date.now();
  const waiting = source.wait(session, abort.signal);
  abort.abort();
  assert.equal(await waiting, false);
  assert.ok(Date.now() - started < 1000, 'not held until the next poll');

  const second = new AbortController();
  session.notificationWait = second;
  const held = source.wait(session, second.signal);
  await registry.end(session);
  assert.equal(await held, false);
  assert.equal(await source.wait(session, new AbortController().signal), false, 'a closed session never waits');
});
