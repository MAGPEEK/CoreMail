/**
 * 9.5 admin management scopes — pure logic: lib/admin-scope.ts (scope model,
 * address / domain checks, Prisma `where` builders) and the scope-aware parts
 * of lib/rbac.ts (areas, actions, scope assignment), plus the fail-closed
 * scopeOf() of middleware/admin-scope.ts.
 * Run: node --import tsx --test src/lib/admin-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv } from '../test-support/fake-prisma.js';
import { matchesWhere } from '../test-support/memory-model.js';

setTestEnv();
const scope = await import('./admin-scope.js');
const rbac = await import('./rbac.js');
const { scopeOf } = await import('../middleware/admin-scope.js');

const A = { id: 'dA', name: 'a.example' };
const B = { id: 'dB', name: 'b.example' };
const scopedA = scope.scopeFromRows('HELP_DESK', [A]);
const org = scope.ORGANISATION_SCOPE;

test('scopeFromRows: no rows or ORGANIZATION_MANAGEMENT → organisation-wide', () => {
  assert.equal(scope.scopeFromRows('HELP_DESK', []).kind, 'organisation');
  assert.equal(scope.scopeFromRows('ORGANIZATION_MANAGEMENT', [A]).kind, 'organisation');
  const s = scope.scopeFromRows('RECIPIENT_MANAGEMENT', [B, { id: 'dA', name: 'A.Example' }]);
  assert.ok(scope.isScoped(s));
  assert.deepEqual(s.domains, [{ id: 'dA', name: 'a.example' }, B], 'sorted, names lower-cased');
  assert.deepEqual(scope.scopeDomainIds(s), ['dA', 'dB']);
  assert.equal(scope.scopeDomainIds(org), null);
});

test('inScope / addressInScope', () => {
  assert.equal(scope.inScope(scopedA, 'dA'), true);
  assert.equal(scope.inScope(scopedA, 'dB'), false);
  assert.equal(scope.inScope(scopedA, null), false, 'objects without a domain are organisation-wide');
  assert.equal(scope.inScope(org, null), true);
  assert.equal(scope.addressInScope(scopedA, 'Bob@A.Example'), true);
  assert.equal(scope.addressInScope(scopedA, 'Bob <bob@a.example>'), true);
  assert.equal(scope.addressInScope(scopedA, 'bob@sub.a.example'), false, 'subdomains are other domains');
  assert.equal(scope.addressInScope(scopedA, 'bob@a.example.evil'), false);
  assert.equal(scope.addressInScope(scopedA, 'no-address'), false);
  assert.equal(scope.domainOfAddress('x@Y.Example '), 'y.example');
});

test('allAddressesInScope / anyAddressInScope', () => {
  assert.equal(scope.allAddressesInScope(scopedA, ['x@a.example', 'y@a.example']), true);
  assert.equal(scope.allAddressesInScope(scopedA, ['x@a.example', 'y@b.example']), false);
  assert.equal(scope.allAddressesInScope(scopedA, []), false, 'nothing to check is not "in scope"');
  assert.equal(scope.allAddressesInScope(org, []), true);
  assert.equal(scope.anyAddressInScope(scopedA, ['x@b.example', 'y@a.example']), true);
  assert.equal(scope.anyAddressInScope(scopedA, ['x@b.example']), false);
});

test('where builders filter rows the way the routes expect', () => {
  const rows = [
    { id: 'dA', domainId: 'dA', toAddr: 'x@a.example' },
    { id: 'dB', domainId: 'dB', toAddr: 'y@B.EXAMPLE' },
  ];
  const ids = (w: Record<string, unknown>) => rows.filter((r) => matchesWhere(r, w)).map((r) => r.id);
  assert.deepEqual(scope.domainIdWhere(org), {});
  assert.deepEqual(ids(scope.domainIdWhere(scopedA)), ['dA']);
  assert.deepEqual(ids(scope.domainRowWhere(scopedA)), ['dA']);
  assert.deepEqual(ids(scope.addressWhere(scopedA, 'toAddr')), ['dA']);
  assert.deepEqual(ids(scope.addressWhere(scope.scopeFromRows('HELP_DESK', [B]), 'toAddr')), ['dB'], 'case-insensitive');
  assert.deepEqual(ids(scope.addressWhere(scope.EMPTY_SCOPE, 'toAddr')), [], 'empty scope sees nothing');
  assert.deepEqual(ids(scope.domainIdWhere(scope.EMPTY_SCOPE)), []);
  assert.deepEqual(scope.andWhere({}, { a: 1 }), { a: 1 });
  assert.deepEqual(scope.andWhere({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(scope.andWhere({ a: 1 }, { b: 2 }), { AND: [{ a: 1 }, { b: 2 }] });
});

test('aliases: the alias domain AND the target mailbox domain must be in scope', () => {
  const alias = (domainId: string, target: string) => ({ domainId, targetUser: { domainId: target }, targetShared: null });
  assert.equal(scope.aliasInScope(scopedA, alias('dA', 'dA')), true);
  assert.equal(scope.aliasInScope(scopedA, alias('dA', 'dB')), false);
  assert.equal(scope.aliasInScope(scopedA, alias('dB', 'dA')), false);
  assert.equal(scope.aliasInScope(scopedA, { domainId: 'dA', targetUser: null, targetShared: { domainId: 'dA' } }), true);
  const w = scope.aliasWhere(scopedA);
  assert.equal(matchesWhere(alias('dA', 'dA'), w), true);
  assert.equal(matchesWhere(alias('dA', 'dB'), w), false);
});

test('scopeOf fails closed: a request without a resolved scope sees nothing', () => {
  assert.equal(scopeOf({} as never), scope.EMPTY_SCOPE);
  assert.equal(scopeOf({ apiUser: { userId: 'u', email: 'e', role: 'HELP_DESK' } } as never), scope.EMPTY_SCOPE);
  assert.equal(scopeOf({ apiUser: { userId: 'u', email: 'e', role: 'HELP_DESK', adminScope: scopedA } } as never), scopedA);
});

test('scopeView: the public form', () => {
  assert.deepEqual(scope.scopeView(org), { kind: 'organisation' });
  assert.deepEqual(scope.scopeView(scopedA), { kind: 'domains', domains: [A] });
});

test('rbac: a scoped admin never reaches the server-wide areas', () => {
  assert.deepEqual(rbac.UNSCOPED_ONLY_AREAS, ['organisation', 'identity', 'servers']);
  for (const role of rbac.ADMIN_ROLES) {
    const areas = rbac.allowedAreas(role, true);
    for (const area of rbac.UNSCOPED_ONLY_AREAS) assert.equal(areas[area], undefined, `${role} scoped: ${area}`);
    for (const area of rbac.ADMIN_AREAS.filter((a) => !rbac.isUnscopedOnlyArea(a))) {
      assert.equal(areas[area], rbac.allowedAreas(role)[area], `${role} scoped keeps ${area}`);
    }
  }
  assert.equal(rbac.canAccess('VIEW_ONLY_ORG', 'servers', 'GET'), true);
  assert.equal(rbac.canAccess('VIEW_ONLY_ORG', 'servers', 'GET', true), false);
  assert.equal(rbac.canAccess('HELP_DESK', 'recipients', 'GET', true), true);
  assert.equal(rbac.canAccess('HELP_DESK', 'recipients', 'POST', true), false);
});

test('rbac: actions on server-wide areas are dropped for scoped admins', () => {
  assert.equal(rbac.hasAdminAction('COMPLIANCE_MANAGEMENT', 'backupMailboxData'), true);
  assert.equal(rbac.hasAdminAction('COMPLIANCE_MANAGEMENT', 'backupMailboxData', true), false);
  assert.equal(rbac.hasAdminAction('HELP_DESK', 'resetPassword', true), true);
  assert.deepEqual(rbac.allowedActions('COMPLIANCE_MANAGEMENT', true), {});
  assert.deepEqual(rbac.allowedActions('HELP_DESK', true), rbac.allowedActions('HELP_DESK'));
});

test('rbac: only ORGANIZATION_MANAGEMENT assigns scopes, and only to scopable roles (no escalation)', () => {
  assert.deepEqual(rbac.SCOPABLE_ROLES, ['HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'VIEW_ONLY_ORG']);
  for (const actor of rbac.USER_ROLES.filter((r) => r !== 'ORGANIZATION_MANAGEMENT')) {
    assert.equal(rbac.scopeAssignmentError(actor, 'HELP_DESK', ['dA']), 'FORBIDDEN_ROLE', actor);
    assert.equal(rbac.scopeAssignmentError(actor, 'HELP_DESK', []), 'FORBIDDEN_ROLE', `${actor} cannot widen either`);
  }
  assert.equal(rbac.scopeAssignmentError('ORGANIZATION_MANAGEMENT', 'HELP_DESK', ['dA']), null);
  for (const target of ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'USER']) {
    assert.equal(rbac.scopeAssignmentError('ORGANIZATION_MANAGEMENT', target, ['dA']), 'ROLE_NOT_SCOPABLE', target);
    assert.equal(rbac.scopeAssignmentError('ORGANIZATION_MANAGEMENT', target, []), null, `${target}: clearing is always allowed`);
  }
});
