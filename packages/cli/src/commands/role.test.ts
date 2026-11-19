/**
 * `coremail role` helpers (9.5): scope labels, list rows, scope arguments, role names.
 * Run: node --import tsx --test src/commands/role.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRole, roleRows, scopeArgs, scopeLabel, type RoleAssignment } from './role.js';

test('scope label: domain names, organisation (also for older servers without scope)', () => {
  assert.equal(scopeLabel({ kind: 'domains', domains: [{ id: 'a', name: 'a.example' }, { id: 'b', name: 'b.example' }] }), 'a.example, b.example');
  assert.equal(scopeLabel({ kind: 'organisation' }), 'organisation');
  assert.equal(scopeLabel(undefined), 'organisation');
});

test('list rows: USER accounts have no scope, --admins hides them', () => {
  const list: RoleAssignment[] = [
    { id: '1', email: 'hd@a.example', displayName: 'HD', role: 'HELP_DESK', active: true, scope: { kind: 'domains', domains: [{ id: 'a', name: 'a.example' }] } },
    { id: '2', email: 'u@a.example', displayName: 'U', role: 'USER', active: false, scope: { kind: 'organisation' } },
  ];
  assert.deepEqual(roleRows(list, false), [
    { email: 'hd@a.example', role: 'HELP_DESK', scope: 'a.example', active: 'yes' },
    { email: 'u@a.example', role: 'USER', scope: '-', active: 'no' },
  ]);
  assert.equal(roleRows(list, true).length, 1);
});

test('scope arguments: domains or --organisation, exactly one of them', () => {
  assert.deepEqual(scopeArgs(['a.example'], false), ['a.example']);
  assert.deepEqual(scopeArgs([], true), []);
  assert.throws(() => scopeArgs(['a.example'], true), /not both/);
  assert.throws(() => scopeArgs([], false), /at least one domain/);
});

test('role names are validated and upper-cased', () => {
  assert.equal(normalizeRole('help_desk'), 'HELP_DESK');
  assert.throws(() => normalizeRole('ADMIN'), /Invalid role/);
});
