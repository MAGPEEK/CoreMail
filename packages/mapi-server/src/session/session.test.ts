/**
 * Session contexts: Redis record with idle TTL, sequence cookie rotation,
 * idle expiry, per-user cap and live termination by credential / protocol
 * switch changes (LiveConnectionRegistry, protocol `mapi`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnectionRegistry, PROTOCOL_ACCESS_CHANGE } from '@coremail/core';
import { SessionRegistry, MAX_SESSIONS_PER_USER, type SessionRedis } from './registry.js';
import { cookieDigest, MapiSession, type SessionAuth } from './session.js';

class MemoryRedis implements SessionRedis {
  store = new Map<string, { value: string; expires: number }>();
  now = 0;
  async set(key: string, value: string, _mode: 'PX', ttl: number): Promise<unknown> { this.store.set(key, { value, expires: this.now + ttl }); return 'OK'; }
  async pexpire(key: string, ttl: number): Promise<number> {
    const e = this.store.get(key);
    if (!e || e.expires <= this.now) { this.store.delete(key); return 0; }
    e.expires = this.now + ttl;
    return 1;
  }
  async del(key: string): Promise<number> { return this.store.delete(key) ? 1 : 0; }
}

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
