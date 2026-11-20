import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTART_TIMEOUT_MS, healthResultOf, initialRestartState, nextRestartState, restartConfirmed, restartPolling,
} from './serverRestart.ts';

test('confirmation: the word (exact) or the public host name (any case)', () => {
  assert.equal(restartConfirmed('', 'NEUSTART', 'mail.example.com'), false);
  assert.equal(restartConfirmed('   ', 'NEUSTART', 'mail.example.com'), false);
  assert.equal(restartConfirmed('NEUSTAR', 'NEUSTART', 'mail.example.com'), false);
  assert.equal(restartConfirmed('neustart', 'NEUSTART', 'mail.example.com'), false, 'the word is exact');
  assert.equal(restartConfirmed(' NEUSTART ', 'NEUSTART', 'mail.example.com'), true);
  assert.equal(restartConfirmed('Mail.Example.com', 'NEUSTART', 'mail.example.com'), true);
  assert.equal(restartConfirmed('mail.example', 'NEUSTART', 'mail.example.com'), false);
  assert.equal(restartConfirmed('RESTART', 'RESTART', null), true);
  assert.equal(restartConfirmed('', 'RESTART', ''), false, 'an empty host name never matches');
});

test('overlay: healthy answers of the old container do not count; down → up → done', () => {
  const t0 = 1_000_000;
  let s = initialRestartState(t0);
  assert.equal(s.phase, 'stopping');
  s = nextRestartState(s, 'healthy', t0 + 2_000);
  assert.equal(s.phase, 'stopping', 'old process still answering');
  assert.equal(s.elapsedSec, 2);
  s = nextRestartState(s, 'unhealthy', t0 + 4_000);
  assert.equal(s.phase, 'starting');
  s = nextRestartState(s, 'unhealthy', t0 + 20_500);
  assert.equal(s.phase, 'starting');
  assert.equal(s.elapsedSec, 20);
  assert.equal(restartPolling(s), true);
  s = nextRestartState(s, 'healthy', t0 + 26_000);
  assert.equal(s.phase, 'done');
  assert.equal(restartPolling(s), false);
  assert.equal(nextRestartState(s, 'unhealthy', t0 + 30_000), s, 'final states stay');
});

test('overlay: timeout after 3 minutes (down the whole time, or never went down)', () => {
  const t0 = 0;
  let s = nextRestartState(initialRestartState(t0), 'unhealthy', 2_000);
  s = nextRestartState(s, 'unhealthy', RESTART_TIMEOUT_MS);
  assert.equal(s.phase, 'timeout');
  assert.equal(restartPolling(s), false);
  let never = initialRestartState(t0);
  never = nextRestartState(never, 'healthy', RESTART_TIMEOUT_MS + 1);
  assert.equal(never.phase, 'timeout');
  // coming back exactly at the limit still counts as back
  const back = nextRestartState(nextRestartState(initialRestartState(0), 'unhealthy', 1_000), 'healthy', RESTART_TIMEOUT_MS + 5);
  assert.equal(back.phase, 'done');
});

test('health result: 2xx with ok:true only', () => {
  assert.equal(healthResultOf(200, { ok: true }), 'healthy');
  assert.equal(healthResultOf(200, { ok: false }), 'unhealthy');
  assert.equal(healthResultOf(503, { ok: false }), 'unhealthy', 'storage check still blocking');
  assert.equal(healthResultOf(502, null), 'unhealthy');
  assert.equal(healthResultOf(null, null), 'unhealthy', 'network error');
  assert.equal(healthResultOf(200, 'ok'), 'unhealthy');
});
