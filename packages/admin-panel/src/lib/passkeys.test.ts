import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalRenewDelayMs, parseOriginList, passkeyErrorKey, passkeyStorageKey, readinessProblemKey } from './passkeys.ts';
import { PATH_AREA } from './adminAreas.ts';

test('related origins: https origins only, deduplicated, invalid lines reported', () => {
  const r = parseOriginList('https://a.example\nhttps://a.example/\nhttp://b.example\nhttps://c.example/path\n\nnot a url, https://d.example:8443');
  assert.deepEqual(r.origins, ['https://a.example', 'https://d.example:8443']);
  assert.deepEqual(r.invalid, ['http://b.example', 'https://c.example/path', 'not a url']);
});

test('error codes and labels', () => {
  assert.equal(passkeyErrorKey('NEEDS_PASSKEYS'), 'pk_err_needs_passkeys');
  assert.equal(passkeyErrorKey('MFA_NOT_VERIFIED'), 'pk_err_mfa_not_verified');
  assert.equal(passkeyErrorKey(undefined), 'pk_err_failed');
  assert.equal(readinessProblemKey('not_https'), 'pkp_problem_https');
  assert.equal(passkeyStorageKey({ kind: 'security_key', legacy: true, backupEligible: null, synced: false }), 'pk_legacy');
  assert.equal(passkeyStorageKey({ kind: 'passkey', legacy: false, backupEligible: true, synced: true }), 'pk_synced');
  assert.equal(passkeyStorageKey({ kind: 'passkey', legacy: false, backupEligible: false, synced: false }), 'pk_device');
  assert.equal(conditionalRenewDelayMs(), 270_000);
});

test('the passkey page belongs to the organisation area', () => {
  assert.equal(PATH_AREA['passkeys'], 'organisation');
});
