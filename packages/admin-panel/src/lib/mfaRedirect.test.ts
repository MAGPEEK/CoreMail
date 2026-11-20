import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MFA_PAGE_PATH, mfaRedirectFor } from './mfaRedirect.ts';

test('MFA_REQUIRED (admins, fresh installations) and MFA_ENROLMENT_REQUIRED (all users) lead to the MFA page', () => {
  assert.equal(mfaRedirectFor(403, 'MFA_REQUIRED'), 'mfa-page');
  assert.equal(mfaRedirectFor(403, 'MFA_ENROLMENT_REQUIRED'), 'mfa-page');
  assert.equal(MFA_PAGE_PATH, '/bcp/mfa-required');
});

test('MFA_NOT_VERIFIED → sign in again with the second factor', () => {
  assert.equal(mfaRedirectFor(403, 'MFA_NOT_VERIFIED'), 'login-mfa');
});

test('other answers are not about MFA', () => {
  assert.equal(mfaRedirectFor(403, 'FORBIDDEN_ROLE'), null);
  assert.equal(mfaRedirectFor(403, undefined), null);
  assert.equal(mfaRedirectFor(401, 'MFA_REQUIRED'), null);
  assert.equal(mfaRedirectFor(500, 'MFA_ENROLMENT_REQUIRED'), null);
});
