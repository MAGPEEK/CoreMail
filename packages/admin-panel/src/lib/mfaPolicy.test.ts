import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MFA_POLICY_FORM_DEFAULTS, adminPromptVisible, adminsWithoutMfa, changedFields, clampDays, dayKey, daysLeft,
  formProblem, overrideLeavesAdminWithoutMfa, rememberChoice, resolveLevel, type AdminAccount,
} from './mfaPolicy.ts';

test('resolveLevel: override > admin rule > all users', () => {
  const f = { users: 'optional' as const, admins: 'required' as const };
  assert.deepEqual(resolveLevel(f, { role: 'HELP_DESK', mfaPolicy: null }), { level: 'required', source: 'admin' });
  assert.deepEqual(resolveLevel(f, { role: 'USER', mfaPolicy: null }), { level: 'optional', source: 'global' });
  assert.deepEqual(resolveLevel(f, { role: 'HELP_DESK', mfaPolicy: 'off' }), { level: 'off', source: 'user' });
  assert.deepEqual(resolveLevel({ users: 'required', admins: 'as_users' }, { role: 'HELP_DESK', mfaPolicy: null }),
    { level: 'required', source: 'global' });
});

test('adminsWithoutMfa: only admins without a requirement AND without a factor', () => {
  const admins: AdminAccount[] = [
    { id: 'a', email: 'a@x', role: 'ORGANIZATION_MANAGEMENT', mfaPolicy: null, enrolled: false },
    { id: 'b', email: 'b@x', role: 'HELP_DESK', mfaPolicy: null, enrolled: true },
    { id: 'c', email: 'c@x', role: 'HELP_DESK', mfaPolicy: 'required', enrolled: false },
  ];
  assert.deepEqual(adminsWithoutMfa({ users: 'optional', admins: 'as_users' }, admins).map((a) => a.id), ['a']);
  assert.deepEqual(adminsWithoutMfa({ users: 'optional', admins: 'required' }, admins), []);
});

test('remember choices, clamping and form checks', () => {
  assert.equal(rememberChoice(0), '0');
  assert.equal(rememberChoice(30), '30');
  assert.equal(rememberChoice(45), 'custom');
  assert.equal(clampDays(500, 1, 365), 365);
  assert.equal(clampDays(Number.NaN, 1, 365), 1);
  assert.equal(formProblem(MFA_POLICY_FORM_DEFAULTS), null);
  assert.equal(formProblem({ ...MFA_POLICY_FORM_DEFAULTS, adminGraceDays: 15 }), 'admin_grace');
  assert.equal(formProblem({ ...MFA_POLICY_FORM_DEFAULTS, rememberDays: 30, rememberDaysAdmins: 60 }), 'remember_admins');
  assert.deepEqual(changedFields(MFA_POLICY_FORM_DEFAULTS, { ...MFA_POLICY_FORM_DEFAULTS, users: 'off' }), { users: 'off' });
});

test('override warning: an admin set to optional / off / inherit-without-rule loses the requirement', () => {
  const f = { users: 'optional' as const, admins: 'required' as const };
  assert.equal(overrideLeavesAdminWithoutMfa(f, 'HELP_DESK', 'optional'), true);
  assert.equal(overrideLeavesAdminWithoutMfa(f, 'HELP_DESK', 'inherit'), false);
  assert.equal(overrideLeavesAdminWithoutMfa({ ...f, admins: 'as_users' }, 'HELP_DESK', 'inherit'), true);
  assert.equal(overrideLeavesAdminWithoutMfa(f, 'USER', 'off'), false, 'plain users: no admin warning');
});

test('admin prompt: grace only; "Später" hides it for the day, never past the deadline', () => {
  const now = new Date(2026, 10, 21, 9, 0, 0);
  const grace = { state: 'grace', deadline: new Date(now.getTime() + 3.5 * 86_400_000).toISOString() };
  assert.equal(daysLeft(grace.deadline, now), 4);
  assert.equal(adminPromptVisible(grace, null, now), true);
  assert.equal(adminPromptVisible(grace, dayKey(now), now), false, 'dismissed today');
  assert.equal(adminPromptVisible(grace, dayKey(now), new Date(now.getTime() + 86_400_000)), true, 'back the next day');
  assert.equal(adminPromptVisible({ state: 'satisfied' }, null, now), false);
  assert.equal(adminPromptVisible({ state: 'required', deadline: grace.deadline }, null, now), false, 'after the deadline the server blocks');
  assert.equal(adminPromptVisible(null, null, now), false);
});
