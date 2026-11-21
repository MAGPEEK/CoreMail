import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteFormError, sameIds } from './selfRegistration.ts';
import { areaForPath } from './adminAreas.ts';

test('invite form bounds match the server', () => {
  assert.equal(inviteFormError(14, 1), null);
  assert.equal(inviteFormError(0, 1), 'days');
  assert.equal(inviteFormError(366, 1), 'days');
  assert.equal(inviteFormError(1.5, 1), 'days');
  assert.equal(inviteFormError(1, 0), 'uses');
  assert.equal(inviteFormError(1, 1001), 'uses');
});

test('domain selection compares as a set', () => {
  assert.equal(sameIds(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameIds(['a'], ['a', 'b']), false);
  assert.equal(sameIds([], []), true);
});

test('the page lives in the recipients area (scoped admins see their approvals)', () => {
  assert.equal(areaForPath('/authentication/self-registration'), 'recipients');
});
