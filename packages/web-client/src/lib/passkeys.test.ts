import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionalRenewDelayMs, needsSecondPasskeyHint, passkeyBrowserErrorKey, passkeyErrorKey, passkeyStorage, recoveryTokenFromHash,
} from './passkeys.ts';
import { webauthnFailure } from './webauthn.ts';

test('storage label from BE / BS', () => {
  assert.equal(passkeyStorage({ backupEligible: true, synced: true }), 'synced');
  assert.equal(passkeyStorage({ backupEligible: false, synced: false }), 'device');
  assert.equal(passkeyStorage({ backupEligible: null, synced: false }), 'unknown');
  assert.equal(passkeyStorage({ backupEligible: true, synced: false }), 'synced');
});

test('server codes and browser failures map to texts', () => {
  assert.equal(passkeyErrorKey('PASSKEY_UNKNOWN'), 'pk_err_unknown');
  assert.equal(passkeyErrorKey('PASSKEY_COUNTER'), 'pk_err_invalid');
  assert.equal(passkeyErrorKey('IP_LOCKED'), 'pk_err_locked');
  assert.equal(passkeyErrorKey(undefined), 'pk_err_failed');
  assert.equal(passkeyErrorKey('WHATEVER'), 'pk_err_failed');
  assert.equal(webauthnFailure({ name: 'NotAllowedError' }), 'cancelled');
  assert.equal(webauthnFailure({ name: 'InvalidStateError' }), 'exists');
  assert.equal(webauthnFailure({ name: 'SecurityError' }), 'not_allowed_here');
  assert.equal(webauthnFailure({ name: 'AbortError' }), 'aborted');
  assert.equal(webauthnFailure(new Error('x')), 'failed');
  assert.equal(passkeyBrowserErrorKey('cancelled'), 'pk_browser_cancelled');
  assert.equal(passkeyBrowserErrorKey('weird'), 'pk_err_failed');
});

test('conditional options are renewed before the 300 s challenge expires', () => {
  assert.equal(conditionalRenewDelayMs(), 270_000);
  assert.equal(conditionalRenewDelayMs(5_000), 10_000);
});

test('recovery token from the fragment only', () => {
  const t = 'A'.repeat(43);
  assert.equal(recoveryTokenFromHash(`#${t}`), t);
  assert.equal(recoveryTokenFromHash('#short'), null);
  assert.equal(recoveryTokenFromHash('#a b'), null);
  assert.equal(recoveryTokenFromHash(''), null);
});

test('second-passkey hint only with exactly one passkey', () => {
  assert.equal(needsSecondPasskeyHint([{ kind: 'passkey' }]), true);
  assert.equal(needsSecondPasskeyHint([{ kind: 'passkey' }, { kind: 'passkey' }]), false);
  assert.equal(needsSecondPasskeyHint([{ kind: 'security_key' }]), false);
});
