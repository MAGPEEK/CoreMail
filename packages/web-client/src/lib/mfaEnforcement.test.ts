import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MFA_ENROLMENT_ROUTE, enforcementView, enrolmentRedirectTarget, graceDaysLeft, hasEnrolledFactor, isMfaEnrolmentRequired,
} from './mfaEnforcement.ts';

const now = new Date('2026-11-20T12:00:00Z');

test('only 403 MFA_ENROLMENT_REQUIRED means "enrol first"', () => {
  assert.equal(isMfaEnrolmentRequired(403, 'MFA_ENROLMENT_REQUIRED'), true);
  assert.equal(isMfaEnrolmentRequired(403, 'MFA_REQUIRED'), false, 'admin MFA code is the BCP\'s');
  assert.equal(isMfaEnrolmentRequired(403, 'PROTOCOL_DISABLED'), false);
  assert.equal(isMfaEnrolmentRequired(401, 'MFA_ENROLMENT_REQUIRED'), false);
});

test('grace days: rounded up, never negative, null without a deadline', () => {
  assert.equal(graceDaysLeft('2026-11-27T12:00:00Z', now), 7);
  assert.equal(graceDaysLeft('2026-11-20T13:00:00Z', now), 1, 'part of a day counts as a day');
  assert.equal(graceDaysLeft('2026-11-19T12:00:00Z', now), 0);
  assert.equal(graceDaysLeft(undefined, now), null);
  assert.equal(graceDaysLeft('nonsense', now), null);
});

test('view: required → enrolment page, grace → banner, other states / no data → nothing', () => {
  assert.deepEqual(enforcementView({ state: 'required', deadline: '2026-11-19T00:00:00Z', canEnrol: true }, now), { redirect: true, banner: null });
  const grace = enforcementView({ state: 'grace', deadline: '2026-11-23T12:00:00Z', canEnrol: true }, now);
  assert.equal(grace.redirect, false);
  assert.equal(grace.banner?.daysLeft, 3);
  assert.equal(grace.banner?.deadline.toISOString(), '2026-11-23T12:00:00.000Z');
  for (const state of ['off', 'satisfied'] as const) assert.deepEqual(enforcementView({ state, canEnrol: true }, now), { redirect: false, banner: null });
  assert.deepEqual(enforcementView(undefined, now), { redirect: false, banner: null }, 'unknown → the server enforces');
  assert.deepEqual(enforcementView({ state: 'grace', canEnrol: true }, now), { redirect: false, banner: null });
});

test('redirect target: never loops on the enrolment page itself', () => {
  assert.equal(enrolmentRedirectTarget('/mail'), MFA_ENROLMENT_ROUTE);
  assert.equal(enrolmentRedirectTarget(MFA_ENROLMENT_ROUTE), null);
});

test('enrolled factor: TOTP or at least one security key', () => {
  assert.equal(hasEnrolledFactor({ totpEnabled: true, webauthnCount: 0 }), true);
  assert.equal(hasEnrolledFactor({ totpEnabled: false, webauthnCount: 1 }), true);
  assert.equal(hasEnrolledFactor({ totpEnabled: false, webauthnCount: 0 }), false);
  assert.equal(hasEnrolledFactor(undefined), false);
});
