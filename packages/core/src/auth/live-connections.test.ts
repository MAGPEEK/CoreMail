/**
 * Live connection registry + termination policy (v7.0.1).
 * Run: node --import tsx --test src/auth/live-connections.test.ts
 */
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:1';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthInvalidationEvent } from './invalidation.js';
import type { LiveConnection, LiveCredential } from './live-connections.js';

const { publishAuthInvalidation, parseAuthInvalidationEvent } = await import('./invalidation.js');
const { connectionAffected, LiveConnectionRegistry } = await import('./live-connections.js');

const conn = (credential: LiveCredential, extra: Partial<LiveConnection> = {}): LiveConnection => ({
  userId: 'u1', credential, terminate: () => undefined, ...extra,
});
const ev = (reason: string, extra: Partial<AuthInvalidationEvent> = {}): AuthInvalidationEvent => ({ userId: 'u1', reason, ...extra });
const revokeAll = (reason: string, except: string | null = null, extra: Partial<AuthInvalidationEvent> = {}) =>
  ev(reason, { revokeBefore: { before: 2000, except, expires: Date.now() + 60_000 }, ...extra });

test('password change/reset ends password connections, keeps app-password ones unless they were deleted', () => {
  for (const reason of ['password-change', 'password-reset', 'admin-password-reset', 'password-reset-by-mail']) {
    assert.equal(connectionAffected(revokeAll(reason), conn('password')), true, reason);
    assert.equal(connectionAffected(revokeAll(reason), conn('external')), true, reason);
    assert.equal(connectionAffected(revokeAll(reason), conn('unknown')), true, reason);
    assert.equal(connectionAffected(revokeAll(reason), conn('app_password', { appPasswordId: 'a1' })), false, reason);
    assert.equal(connectionAffected(revokeAll(reason, null, { appPasswordsRevoked: true }), conn('app_password')), true, reason);
  }
});

test('MFA change ends password connections only', () => {
  assert.equal(connectionAffected(ev('mfa-change'), conn('password')), true);
  assert.equal(connectionAffected(ev('mfa-change'), conn('unknown')), true);
  assert.equal(connectionAffected(ev('mfa-change'), conn('app_password', { appPasswordId: 'a1' })), false);
  assert.equal(connectionAffected(ev('mfa-change'), conn('token', { sessionId: 's1', issuedAt: 1000 })), false);
});

test('app password revocation ends only connections that used that app password', () => {
  const e = ev('app-password-revoked', { appPasswordId: 'a1' });
  assert.equal(connectionAffected(e, conn('app_password', { appPasswordId: 'a1' })), true);
  assert.equal(connectionAffected(e, conn('app_password', { appPasswordId: 'a2' })), false);
  assert.equal(connectionAffected(e, conn('app_password')), true, 'unknown app password id → ends');
  assert.equal(connectionAffected(e, conn('unknown')), true);
  assert.equal(connectionAffected(e, conn('password')), false);
  assert.equal(connectionAffected(ev('app-password-revoked'), conn('app_password', { appPasswordId: 'a2' })), true, 'event without id → all app-password connections');
});

test('deactivation, deletion, admin revoke and unknown revoke-all reasons end everything', () => {
  for (const reason of ['deactivated', 'deleted', 'ldap-sync-disabled', 'admin-revoke:x', 'something-new']) {
    for (const c of ['password', 'app_password', 'external', 'unknown'] as const) {
      assert.equal(connectionAffected(revokeAll(reason), conn(c, { appPasswordId: 'a1' })), true, `${reason}/${c}`);
    }
    assert.equal(connectionAffected(revokeAll(reason), conn('token', { sessionId: 's1', issuedAt: 1000 })), true, reason);
  }
  // Deactivation without a revocation mark still ends token connections.
  assert.equal(connectionAffected(ev('deactivated'), conn('token', { sessionId: 's1', issuedAt: 1000 })), true);
});

test('neutral events keep protocol connections', () => {
  for (const reason of ['app-password-created', 'reactivated', 'role-change']) {
    assert.equal(connectionAffected(ev(reason), conn('password')), false, reason);
  }
  // Role change revokes web sessions (revokeAllSessions) but keeps mail logins.
  assert.equal(connectionAffected(revokeAll('role-change'), conn('password')), false);
  assert.equal(connectionAffected(revokeAll('role-change'), conn('token', { sessionId: 's1', issuedAt: 1000 })), true);
  // Logout of one web session does not touch IMAP & co.
  assert.equal(connectionAffected(ev('sessions-revoked', { sessionIds: ['s9'] }), conn('password')), false);
});

test('token connections follow their web session', () => {
  const tok = conn('token', { sessionId: 's1', issuedAt: 1000 });
  assert.equal(connectionAffected(ev('sessions-revoked', { sessionIds: ['s1'] }), tok), true);
  assert.equal(connectionAffected(ev('sessions-revoked', { sessionIds: ['s2'] }), tok), false);
  assert.equal(connectionAffected(revokeAll('password-change', 's1'), tok), false, 'the session changing the password stays');
  assert.equal(connectionAffected(revokeAll('password-change', 's2'), tok), true);
  assert.equal(connectionAffected(revokeAll('password-change'), conn('token', { sessionId: 's1', issuedAt: 3000 })), false, 'token issued after the mark');
  assert.equal(connectionAffected(ev('app-password-revoked', { appPasswordId: 'a1' }), tok), false);
});

test('other users are never affected', () => {
  assert.equal(connectionAffected(revokeAll('deleted'), { ...conn('password'), userId: 'u2' }), false);
});

test('registry: terminates affected connections once, keeps the others, unregister works', async () => {
  const reg = new LiveConnectionRegistry('test');
  const calls: string[] = [];
  const mk = (name: string, userId: string, credential: LiveCredential, appPasswordId?: string) => reg.register({
    userId, credential, ...(appPasswordId ? { appPasswordId } : {}),
    terminate: (e) => { calls.push(`${name}:${e.reason}`); },
  });
  mk('pw', 'u1', 'password');
  mk('ap1', 'u1', 'app_password', 'a1');
  mk('ap2', 'u1', 'app_password', 'a2');
  mk('other', 'u2', 'password');
  const unregister = mk('gone', 'u1', 'password');
  unregister();
  assert.equal(reg.count('u1'), 3);

  const detach = reg.attachInvalidation();
  try {
    await publishAuthInvalidation({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'a1' }, { redis: null });
    assert.deepEqual(calls, ['ap1:app-password-revoked']);
    await publishAuthInvalidation({ userId: 'u1', reason: 'mfa-change' }, { redis: null });
    assert.deepEqual(calls, ['ap1:app-password-revoked', 'pw:mfa-change']);
    // Same event twice (local + Redis) → no second terminate.
    await publishAuthInvalidation({ userId: 'u1', reason: 'mfa-change' }, { redis: null });
    assert.equal(calls.length, 2);
    assert.equal(reg.count('u1'), 1);
    assert.equal(reg.count('u2'), 1);
    assert.equal(reg.count(), 2);
  } finally {
    detach();
  }
  // A throwing terminate does not stop the others.
  const reg2 = new LiveConnectionRegistry('t2');
  let ok = 0;
  reg2.register({ userId: 'x', credential: 'password', terminate: () => { throw new Error('boom'); } });
  reg2.register({ userId: 'x', credential: 'password', terminate: () => { ok++; } });
  assert.equal(reg2.terminateAffected({ userId: 'x', reason: 'deleted' }), 2);
  assert.equal(ok, 1);
});

test('registry: a login checked before an event but registered after it is terminated', async () => {
  let now = 1000;
  const reg = new LiveConnectionRegistry('late', { now: () => now, recentMs: 60_000 });
  const ended: string[] = [];
  const mk = (name: string, credential: LiveCredential, startedAt: number) => reg.register({
    userId: 'u1', credential, terminate: (e) => { ended.push(`${name}:${e.reason}`); },
  }, startedAt);
  now = 2000;
  reg.terminateAffected({ userId: 'u1', reason: 'password-change' }); // nobody registered yet
  now = 2500;
  mk('stale', 'password', 1500);            // check began before the change → ends
  mk('fresh', 'password', 2100);            // check began after → stays
  mk('app', 'app_password', 1500);          // not affected by a password change → stays
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ended, ['stale:password-change']);
  assert.equal(reg.count('u1'), 2);
  now = 200_000;                            // beyond recentMs → forgotten
  mk('old', 'password', 1500);
  await new Promise((r) => setImmediate(r));
  assert.equal(ended.length, 1);
});

test('event wire format carries the app password fields', () => {
  const e = parseAuthInvalidationEvent(JSON.stringify({ userId: 'u', reason: 'app-password-revoked', appPasswordId: 'a1', appPasswordsRevoked: true }));
  assert.equal(e?.appPasswordId, 'a1');
  assert.equal(e?.appPasswordsRevoked, true);
  const bad = parseAuthInvalidationEvent(JSON.stringify({ userId: 'u', reason: 'x', appPasswordId: 5, appPasswordsRevoked: 'yes' }));
  assert.equal(bad?.appPasswordId, undefined);
  assert.equal(bad?.appPasswordsRevoked, undefined);
});
