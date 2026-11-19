import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionOutcome, backupCapabilities, blocksWrite, can, canAction, canManageAccount, canOutcome, isScopableRole, isScoped,
  ORGANISATION_SCOPE, pageAccessFor, parsePermissions, parseScope, permissionsAfterError, scopeDomainIds, UNSCOPED_ONLY_PATHS,
} from './permissions.ts';
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
  assert.deepEqual(p, { role: 'HELP_DESK', areas: HELP_DESK, actions: null, scope: { kind: 'organisation' }, mfaVerified: true });
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
  assert.deepEqual(permissionsAfterError(403), { role: null, areas: {}, actions: {}, scope: { kind: 'organisation' }, mfaVerified: false });
  assert.deepEqual(permissionsAfterError(401), { role: null, areas: {}, actions: {}, scope: { kind: 'organisation' }, mfaVerified: false });
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

// ── 9.1: COMPLIANCE_MANAGEMENT reaches Backups through backupMailboxData ──────
const COMPLIANCE = { dashboard: 'read', compliance: 'write' } as const;
const COMPLIANCE_ACTIONS = { servers: ['backupMailboxData' as const] };
const SERVER = { dashboard: 'read', servers: 'write', organisation: 'read', domains: 'read' } as const;
const effective = (areas: Parameters<typeof accessForPath>[0], actions: Parameters<typeof pageAccessFor>[1], path: string) =>
  pageAccessFor(areas, actions, { path, access: accessForPath(areas, path) });

test('9.1 page access: COMPLIANCE sees Backups (read) via the action, nothing else of servers', () => {
  assert.equal(accessForPath(COMPLIANCE, '/backups'), 'none', 'no servers area');
  assert.equal(effective(COMPLIANCE, COMPLIANCE_ACTIONS, '/backups'), 'read');
  assert.equal(effective(COMPLIANCE, COMPLIANCE_ACTIONS, '/bcp/backups'), 'read');
  for (const p of ['/servers', '/queues', '/logs', '/certificates', '/services']) {
    assert.equal(effective(COMPLIANCE, COMPLIANCE_ACTIONS, p), 'none', p);
  }
  assert.equal(effective(COMPLIANCE, COMPLIANCE_ACTIONS, '/audit-log'), 'write', 'own area unchanged');
  // without the action (older backend sends no actions → backupMailboxData is never implied)
  assert.equal(effective(COMPLIANCE, null, '/backups'), 'none');
  assert.equal(effective(COMPLIANCE, {}, '/backups'), 'none');
  // HELP_DESK holds no backup action
  assert.equal(effective(HELP_DESK, { recipients: [...HD_ACTIONS.recipients] }, '/backups'), 'none');
  // area access wins when present
  assert.equal(effective(SERVER, {}, '/backups'), 'write');
  assert.equal(effective(VIEW_ONLY, {}, '/backups'), 'read');
  assert.equal(effective(null, null, '/backups'), 'write', 'unknown permissions keep full access');
});

test('9.1 Backups for COMPLIANCE: mailbox-data parts only; the write block lets those requests through', () => {
  assert.deepEqual(backupCapabilities(COMPLIANCE, COMPLIANCE_ACTIONS), { operations: false, manage: false, mailboxData: true });
  assert.deepEqual(backupCapabilities(SERVER, {}), { operations: true, manage: true, mailboxData: false });
  assert.deepEqual(backupCapabilities(VIEW_ONLY, {}), { operations: true, manage: false, mailboxData: false });
  assert.deepEqual(backupCapabilities({ ...SERVER, compliance: 'write' }, { servers: ['backupMailboxData'] }), { operations: true, manage: true, mailboxData: true });
  // per-mailbox backup / import (POST) are not blocked client-side on the read-only page
  const access = effective(COMPLIANCE, COMPLIANCE_ACTIONS, '/backups');
  assert.equal(blocksWrite(COMPLIANCE, COMPLIANCE_ACTIONS, { area: areaForPath('/backups'), access }), false);
  // delete buttons (<Can area="servers" access="write">) are hidden, downloads allowed
  assert.equal(canOutcome(COMPLIANCE, 'servers', 'write', 'disable'), 'hide');
  assert.equal(actionOutcome(COMPLIANCE, COMPLIANCE_ACTIONS, 'backupMailboxData', 'disable'), 'allow');
});

test('9.1 HELP_DESK end to end (client side): sign out everywhere / reset / enable-disable reach the API', () => {
  const actions = { recipients: [...HD_ACTIONS.recipients] };
  const access = effective(HELP_DESK, actions, '/mailboxes');
  assert.equal(access, 'read');
  // POST /admin/mailboxes/:id/revoke-sessions and PUT /admin/mailboxes/:id from the Mailboxes page
  assert.equal(blocksWrite(HELP_DESK, actions, { area: areaForPath('/mailboxes'), access }), false);
  for (const a of ['revokeSessions', 'resetPassword', 'toggleActive'] as const) {
    assert.equal(actionOutcome(HELP_DESK, actions, a, 'disable'), 'allow', a);
  }
  // the buttons only show for USER accounts (mayOn → canManageAccount), as the API enforces
  assert.equal(canManageAccount('HELP_DESK', 'USER'), true);
  assert.equal(canManageAccount('HELP_DESK', 'ORGANIZATION_MANAGEMENT'), false);
  // edit / delete stay hidden behind recipients write
  assert.equal(canOutcome(HELP_DESK, 'recipients', 'write', 'disable'), 'disable');
});

test('assignableRoles / canAssignRoles mirror canAssignRole of the API', async () => {
  const { assignableRoles, canAssignRoles } = await import('./permissions.ts');
  const ALL = ['USER', 'HELP_DESK', 'ORGANIZATION_MANAGEMENT'] as const;
  assert.deepEqual(assignableRoles(ALL, 'ORGANIZATION_MANAGEMENT', 'USER'), [...ALL]);
  assert.deepEqual(assignableRoles(ALL, null), [...ALL]);
  // other admins: new accounts only USER, existing accounts keep their role
  assert.deepEqual(assignableRoles(ALL, 'RECIPIENT_MANAGEMENT'), ['USER']);
  assert.deepEqual(assignableRoles(ALL, 'RECIPIENT_MANAGEMENT', 'HELP_DESK'), ['HELP_DESK']);
  assert.equal(canAssignRoles('ORGANIZATION_MANAGEMENT'), true);
  assert.equal(canAssignRoles('RECIPIENT_MANAGEMENT'), false);
  assert.equal(canAssignRoles(null), false);
});

// ── 9.5 management scopes ─────────────────────────────────────────────────────

test('parseScope: domains list, anything else → organisation-wide', () => {
  const p = parsePermissions({ role: 'HELP_DESK', areas: HELP_DESK, scope: { kind: 'domains', domains: [{ id: 'd1', name: 'a.example' }, { id: 7 }] } });
  assert.deepEqual(p.scope, { kind: 'domains', domains: [{ id: 'd1', name: 'a.example' }] });
  assert.deepEqual(parseScope(undefined), { kind: 'organisation' }, 'older backend');
  assert.deepEqual(parseScope({ kind: 'domains' }), { kind: 'organisation' });
  assert.equal(isScoped(p.scope), true);
  assert.deepEqual(scopeDomainIds(p.scope), ['d1']);
  assert.deepEqual(scopeDomainIds(ORGANISATION_SCOPE), []);
});

test('scoped admins never see the organisation-wide pages of their areas', () => {
  const HYGIENE = { dashboard: 'read', hygiene: 'write' } as const;
  const scoped = parseScope({ kind: 'domains', domains: [{ id: 'd1', name: 'a.example' }] });
  const page = (path: string, scope = ORGANISATION_SCOPE) => pageAccessFor(HYGIENE, null, { path, access: accessForPath(HYGIENE, path) }, scope);
  assert.equal(page('/transport-rules'), 'write');
  assert.equal(page('/transport-rules', scoped), 'none');
  assert.equal(page('/bcp/transport-rules', scoped), 'none');
  assert.equal(page('/quarantine', scoped), 'write', 'quarantine follows the scope instead');
  assert.equal(page('/protection', scoped), 'write');
  for (const p of UNSCOPED_ONLY_PATHS) {
    assert.equal(pageAccessFor({ compliance: 'write', hygiene: 'write' }, null, { path: `/${p}`, access: 'write' }, scoped), 'none', p);
  }
});

test('isScopableRole mirrors the API', () => {
  for (const r of ['HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'VIEW_ONLY_ORG']) assert.equal(isScopableRole(r), true, r);
  for (const r of ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'USER']) assert.equal(isScopableRole(r), false, r);
});
