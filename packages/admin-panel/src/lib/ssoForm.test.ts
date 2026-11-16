import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssoClaimMap } from './ssoForm.ts';

test('SSO claim map: an emptied email claim is removed, other claims stay', () => {
  assert.deepEqual(ssoClaimMap({ email: 'upn', name: 'given' }, ''), { name: 'given' });
  assert.deepEqual(ssoClaimMap({ email: 'upn' }, '  '), {});
});

test('SSO claim map: set / replace the email claim', () => {
  assert.deepEqual(ssoClaimMap(undefined, ' preferred_username '), { email: 'preferred_username' });
  assert.deepEqual(ssoClaimMap({ email: 'upn', name: 'n' }, 'mail'), { name: 'n', email: 'mail' });
});
