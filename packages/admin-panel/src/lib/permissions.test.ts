import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOutcome, blocksWrite, can, canAction, canManageAccount, canOutcome, parsePermissions, permissionsAfterError } from './permissions.ts';
import { accessForPath, areaForPath, firstAllowedPath } from './adminAreas.ts';

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
  assert.deepEqual(p, { role: 'HELP_DESK', areas: HELP_DESK, actions: null, mfaVerified: true });
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

test('permissionsAfterError: 404 → legacy lookup, 401/403 → nothing visible, others → unknown', () => {
  assert.equal(permissionsAfterError(404), 'legacy');
  assert.deepEqual(permissionsAfterError(403), { role: null, areas: {}, actions: {}, mfaVerified: false });
  assert.deepEqual(permissionsAfterError(401), { role: null, areas: {}, actions: {}, mfaVerified: false });
  const unknown = permissionsAfterError(503);
  assert.ok(unknown !== 'legacy' && unknown.areas === null);
  const none = permissionsAfterError(403);
  assert.ok(none !== 'legacy');
  assert.equal(can(none.areas, 'dashboard'), false, 'a USER token sees no admin area');
});

test('route access and landing page per role', () => {
  assert.equal(accessForPath(HELP_DESK, '/mailboxes'), 'read');
  assert.equal(accessForPath(HELP_DESK, '/certificates'), 'none');
  assert.equal(accessForPath(RECIPIENT, '/shared-mailboxes'), 'write');
  assert.equal(firstAllowedPath(HELP_DESK), '/dashboard');
  assert.equal(firstAllowedPath({ hygiene: 'write' }), '/protection');
});

// ── Narrow actions (GET /admin/me/permissions → actions) ─────────────────────

const HD_ACTIONS = { recipients: ['resetPassword', 'toggleActive', 'revokeSessions'] } as const;
const page = (areas: Parameters<typeof accessForPath>[0], path: string) => ({ area: areaForPath(path), access: accessForPath(areas, path) });

test('parsePermissions keeps known actions on their own area only', () => {
  const p = parsePermissions({
    role: 'HELP_DESK', areas: HELP_DESK, mfaVerified: true,
    actions: { recipients: ['resetPassword', 'toggleActive', 'revokeSessions', 'bogus', 'backupMailboxData'], servers: 'x', nope: ['resetPassword'] },
  });
  assert.deepEqual(p.actions, HD_ACTIONS);
  assert.equal(parsePermissions({ areas: HELP_DESK }).actions, null, 'older backend: no actions');
});

test('HELP_DESK: exactly reset password / enable-disable / sign out on recipients, nothing else writable', () => {
  const actions = { recipients: [...HD_ACTIONS.recipients] };
  assert.equal(canAction(HELP_DESK, actions, 'resetPassword'), true);
  assert.equal(canAction(HELP_DESK, actions, 'toggleActive'), true);
  assert.equal(canAction(HELP_DESK, actions, 'revokeSessions'), true);
  assert.equal(canAction(HELP_DESK, actions, 'backupMailboxData'), false);
  assert.equal(can(HELP_DESK, 'recipients', 'write'), false, 'no general write (edit, delete, create)');
  assert.equal(actionOutcome(HELP_DESK, actions, 'resetPassword', 'disable'), 'allow');
  assert.equal(actionOutcome(HELP_DESK, actions, 'backupMailboxData', 'disable'), 'hide', 'servers not visible');
  // the API client lets the action requests through on the read-only Mailboxes page
  assert.equal(blocksWrite(HELP_DESK, actions, page(HELP_DESK, '/mailboxes')), false);
  // VIEW_ONLY_ORG has no actions → writes blocked
  assert.equal(blocksWrite(VIEW_ONLY, {}, page(VIEW_ONLY, '/mailboxes')), true);
  assert.equal(actionOutcome(VIEW_ONLY, {}, 'resetPassword', 'disable'), 'disable');
});

test('backupMailboxData: COMPLIANCE yes, SERVER_MANAGEMENT (write on servers) no', () => {
  const srv = { dashboard: 'read', servers: 'write', organisation: 'read', domains: 'read' } as const;
  assert.equal(canAction(srv, {}, 'backupMailboxData'), false);
  assert.equal(actionOutcome(srv, {}, 'backupMailboxData', 'disable'), 'disable');
  assert.equal(canAction({ dashboard: 'read', compliance: 'write' }, { servers: ['backupMailboxData'] }, 'backupMailboxData'), true);
  assert.equal(blocksWrite(srv, {}, page(srv, '/backups')), false, 'write area is never blocked');
});

test('older backend without actions: write implies the recipients actions, nothing implies backupMailboxData', () => {
  assert.equal(canAction(RECIPIENT, null, 'resetPassword'), true);
  assert.equal(canAction(HELP_DESK, null, 'resetPassword'), false);
  assert.equal(canAction({ servers: 'write' }, null, 'backupMailboxData'), false);
  assert.equal(canAction(null, null, 'backupMailboxData'), true, 'unknown permissions keep full access');
});

test('canManageAccount mirrors the API: admin accounts only for ORGANIZATION_MANAGEMENT', () => {
  assert.equal(canManageAccount('HELP_DESK', 'USER'), true);
  assert.equal(canManageAccount('HELP_DESK', 'SERVER_MANAGEMENT'), false);
  assert.equal(canManageAccount('RECIPIENT_MANAGEMENT', 'HELP_DESK'), false);
  assert.equal(canManageAccount('ORGANIZATION_MANAGEMENT', 'ORGANIZATION_MANAGEMENT'), true);
  assert.equal(canManageAccount(null, 'SERVER_MANAGEMENT'), true, 'unknown → the server decides');
});
