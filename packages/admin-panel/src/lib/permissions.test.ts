import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canOutcome, parsePermissions } from './permissions.ts';
import { accessForPath, firstAllowedPath } from './adminAreas.ts';

// Shapes as returned by GET /api/v1/admin/me/permissions for each role
// (mirrors ROLE_PERMISSIONS in api-gateway lib/rbac.ts).
const HELP_DESK = { dashboard: 'read', recipients: 'read' } as const;
const RECIPIENT = { dashboard: 'read', recipients: 'write', domains: 'read' } as const;
const VIEW_ONLY = {
  dashboard: 'read', organisation: 'read', identity: 'read', servers: 'read',
  recipients: 'read', domains: 'read', hygiene: 'read',
} as const;

test('parsePermissions accepts the API shape and drops unknown areas/values', () => {
  const p = parsePermissions({ role: 'HELP_DESK', areas: { ...HELP_DESK, bogus: 'write', servers: 'admin' }, mfaVerified: true });
  assert.deepEqual(p, { role: 'HELP_DESK', areas: HELP_DESK, mfaVerified: true });
  // older backend: /user/me → adminAreas
  assert.deepEqual(parsePermissions({ adminAreas: { domains: 'read' } }).areas, { domains: 'read' });
  // nothing usable → unknown (full access, server still enforces)
  assert.equal(parsePermissions(null).areas, null);
  assert.equal(parsePermissions({ areas: ['x'] }).areas, null);
  assert.equal(parsePermissions({ areas: {} }).mfaVerified, false);
  assert.deepEqual(parsePermissions({ areas: {} }).areas, {});
});

test('can: write implies read, missing area → nothing, unknown permissions → everything', () => {
  assert.equal(can(RECIPIENT, 'recipients', 'write'), true);
  assert.equal(can(RECIPIENT, 'recipients', 'read'), true);
  assert.equal(can(RECIPIENT, 'domains', 'read'), true);
  assert.equal(can(RECIPIENT, 'domains', 'write'), false);
  assert.equal(can(RECIPIENT, 'servers', 'read'), false);
  assert.equal(can(RECIPIENT, 'domains'), true, 'default access is read');
  assert.equal(can(null, 'compliance', 'write'), true);
  assert.equal(can({}, 'dashboard'), false);
});

test('VIEW_ONLY_ORG: everything readable is visible, nothing writable, compliance hidden', () => {
  for (const area of Object.keys(VIEW_ONLY) as Array<keyof typeof VIEW_ONLY>) {
    assert.equal(can(VIEW_ONLY, area, 'read'), true, area);
    assert.equal(can(VIEW_ONLY, area, 'write'), false, area);
    assert.equal(canOutcome(VIEW_ONLY, area, 'write', 'disable'), 'disable', area);
    assert.equal(canOutcome(VIEW_ONLY, area, 'write', 'hide'), 'hide', area);
  }
  assert.equal(can(VIEW_ONLY, 'compliance'), false);
  assert.equal(accessForPath(VIEW_ONLY, '/audit-log'), 'none');
  assert.equal(accessForPath(VIEW_ONLY, '/mailboxes'), 'read');
});

test('<Can> outcomes: allow / disable (read-only) / hide (no access)', () => {
  assert.equal(canOutcome(HELP_DESK, 'recipients', 'read', 'hide'), 'allow');
  assert.equal(canOutcome(HELP_DESK, 'recipients', 'write', 'disable'), 'disable');
  assert.equal(canOutcome(HELP_DESK, 'recipients', 'write', 'hide'), 'hide');
  assert.equal(canOutcome(HELP_DESK, 'servers', 'write', 'disable'), 'hide', 'no read → never shown, not even disabled');
  assert.equal(canOutcome(null, 'servers', 'write', 'disable'), 'allow');
});

test('route access and landing page per role', () => {
  assert.equal(accessForPath(HELP_DESK, '/mailboxes'), 'read');
  assert.equal(accessForPath(HELP_DESK, '/certificates'), 'none');
  assert.equal(accessForPath(RECIPIENT, '/shared-mailboxes'), 'write');
  assert.equal(firstAllowedPath(HELP_DESK), '/dashboard');
  assert.equal(firstAllowedPath({ hygiene: 'write' }), '/protection');
});
