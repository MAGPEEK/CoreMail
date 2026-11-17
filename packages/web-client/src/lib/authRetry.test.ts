import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshFailureVerdict, shouldRefreshOn401, refreshBackoffMs } from './authRetry.ts';

test('refresh: 429 / 5xx / network errors are temporary — never a logout', () => {
  for (const s of [429, 500, 502, 503, null]) assert.equal(refreshFailureVerdict(s, undefined), 'retry', String(s));
  assert.equal(refreshFailureVerdict(429, 'REFRESH_INVALID'), 'retry');
});

test('refresh: logout only on 401 with SESSION_REVOKED / REFRESH_* / TOKEN_*', () => {
  for (const c of ['SESSION_REVOKED', 'REFRESH_INVALID', 'REFRESH_EXPIRED', 'REFRESH_REUSED', 'REFRESH_MISSING', 'TOKEN_EXPIRED']) {
    assert.equal(refreshFailureVerdict(401, c), 'logout', c);
  }
  assert.equal(refreshFailureVerdict(401, undefined), 'fail');
  assert.equal(refreshFailureVerdict(403, 'ORIGIN_MISMATCH'), 'fail');
  assert.equal(refreshFailureVerdict(400, undefined), 'fail');
});

test('9.4 refresh: Webmail switched off (403 PROTOCOL_DISABLED) ends the session', () => {
  assert.equal(refreshFailureVerdict(403, 'PROTOCOL_DISABLED'), 'logout');
  assert.equal(refreshFailureVerdict(401, 'PROTOCOL_DISABLED'), 'fail');
});

test('401 from an API call: refresh only for token/session problems, not for re-auth failures', () => {
  assert.equal(shouldRefreshOn401(undefined), true);
  assert.equal(shouldRefreshOn401(''), true);
  assert.equal(shouldRefreshOn401('UNAUTHORIZED'), true);
  assert.equal(shouldRefreshOn401('TOKEN_EXPIRED'), true);
  assert.equal(shouldRefreshOn401('SESSION_EXPIRED'), true);
  assert.equal(shouldRefreshOn401('REAUTH_FAILED'), false);
  assert.equal(shouldRefreshOn401('REAUTH_REQUIRED'), false);
  assert.equal(shouldRefreshOn401('MFA_INVALID_CODE'), false);
});

test('refresh backoff: exponential, capped, Retry-After wins', () => {
  assert.deepEqual([1, 2, 3, 4].map((a) => refreshBackoffMs(a)), [1000, 2000, 4000, 8000]);
  assert.equal(refreshBackoffMs(20), 30_000);
  assert.equal(refreshBackoffMs(1, '5'), 5000);
  assert.equal(refreshBackoffMs(1, '900'), 30_000);
  assert.equal(refreshBackoffMs(2, 'garbage'), 2000);
});
