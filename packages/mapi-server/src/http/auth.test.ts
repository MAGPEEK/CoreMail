/**
 * 9.5 review: a deactivated account loses MAPI access at once — through the
 * invalidation event (cached check dropped, live sessions end) and, when
 * this instance missed the event, through the shared "revoke all" mark that
 * makes a cached check be verified again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialCache, LiveConnectionRegistry, publishAuthInvalidation } from '@coremail/core';
import type { MailAuthResult } from '@coremail/storage';
import { createAuthenticator, type AuthDeps, type CachedAuth } from './auth.js';
import { SessionRegistry } from '../session/registry.js';
import { MemoryRedis } from '../testing/memory-redis.js';

const TRANSPORT = { ip: '192.0.2.10', plainHttp: false };
const header = (login: string, password: string): string => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

function harness() {
  const state = { active: true, verifies: 0, markAt: null as number | null, clock: 1_000 };
  const cache = new CredentialCache<CachedAuth>({ ttlMs: 60_000, now: () => state.clock });
  const unsubscribe = cache.attachInvalidation();
  const deps: AuthDeps = {
    async verify(): Promise<MailAuthResult> {
      state.verifies++;
      return state.active
        ? { status: 'ok', user: { id: 'u-dea', email: 'dea@example.test', displayName: 'Dea', domainId: 'd1' } as never, method: 'app_password', appPasswordId: 'ap1' }
        : { status: 'invalid' };
    },
    switchAllows: async () => true,
    revokedSince: async (_userId, verifiedAt) => state.markAt !== null && state.markAt > verifiedAt,
    allowPlainHttp: () => false,
    cache,
    now: () => state.clock,
  };
  return { state, authenticate: createAuthenticator(deps), unsubscribe };
}

test('a cached check is reused; the deactivation event drops it, so the next request is refused (401)', async () => {
  const { state, authenticate, unsubscribe } = harness();
  try {
    const h = header('dea@example.test', 'app-pw');
    assert.equal((await authenticate(h, TRANSPORT)).ok, true);
    assert.equal((await authenticate(h, TRANSPORT)).ok, true);
    assert.equal(state.verifies, 1, 'second request served from the cache');
    state.active = false;
    await publishAuthInvalidation({ userId: 'u-dea', reason: 'deactivated' }, { redis: null });
    const refused = await authenticate(h, TRANSPORT);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.status, 401);
    assert.equal(state.verifies, 2);
  } finally { unsubscribe(); }
});

test('missed event: a revoke-all mark newer than the cached check forces a new check — refused at once, not after the cache TTL', async () => {
  const { state, authenticate, unsubscribe } = harness();
  try {
    const h = header('dea@example.test', 'app-pw');
    assert.equal((await authenticate(h, TRANSPORT)).ok, true);
    state.clock += 1_000;
    state.active = false;
    state.markAt = state.clock; // deactivated elsewhere; this instance got no message
    const refused = await authenticate(h, TRANSPORT);
    assert.equal(refused.ok, false, 'no 60 s grace');
    assert.equal(state.verifies, 2);
  } finally { unsubscribe(); }
});

test('a mark that leaves the credential valid (an app password after a password change) is verified again, then cached again', async () => {
  const { state, authenticate, unsubscribe } = harness();
  try {
    const h = header('dea@example.test', 'app-pw');
    await authenticate(h, TRANSPORT);
    state.clock += 1_000;
    state.markAt = state.clock - 1;
    assert.equal((await authenticate(h, TRANSPORT)).ok, true, 'still valid');
    assert.equal(state.verifies, 2, 'checked again after the mark');
    state.clock += 1; // a check that began in the same millisecond as the drop is not cached
    await authenticate(h, TRANSPORT);
    const settled = state.verifies;
    for (let i = 0; i < 3; i++) assert.equal((await authenticate(h, TRANSPORT)).ok, true);
    assert.equal(state.verifies, settled, 'served from the cache again');
  } finally { unsubscribe(); }
});

test('the deactivation event ends the open MAPI sessions of the account (live connection registry)', async () => {
  const live = new LiveConnectionRegistry('test');
  const sessions = new SessionRegistry({ redis: new MemoryRedis(), live, idleMs: 60_000 });
  const auth = { user: { userId: 'u-dea', email: 'dea@example.test', displayName: 'Dea', domainId: 'd1' }, credential: 'app_password' as const, appPasswordId: 'ap1', authKey: 'k' };
  const mailbox = await sessions.create(auth, Date.now());
  const book = await sessions.create(auth, Date.now(), 'nspi');
  live.terminateAffected({ userId: 'u-dea', reason: 'deactivated' });
  await new Promise((r) => setImmediate(r));
  assert.equal(mailbox.session.closed, true);
  assert.equal(book.session.closed, true);
  assert.equal(sessions.size, 0);
});
