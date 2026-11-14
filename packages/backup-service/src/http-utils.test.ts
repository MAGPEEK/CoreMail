/**
 * v6 backup-service HTTP helpers: `?limit=` parsing (abc used to crash the
 * service), backup admin roles, internal-route guard wiring.
 * Run: node --import tsx --test src/http-utils.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit, isBackupAdmin } from './http-utils.js';
import { requireInternal } from '@coremail/core/http';

test('parseLimit', () => {
  assert.equal(parseLimit(undefined, 50, 200), 50);
  assert.equal(parseLimit('abc', 50, 200), 50);
  assert.equal(parseLimit('-5', 50, 200), 50);
  assert.equal(parseLimit('0', 50, 200), 50);
  assert.equal(parseLimit('1e9', 50, 200), 50);
  assert.equal(parseLimit(['10'], 50, 200), 50);
  assert.equal(parseLimit('10', 50, 200), 10);
  assert.equal(parseLimit('5000', 50, 200), 200);
});

test('isBackupAdmin follows the "servers" RBAC area', () => {
  assert.equal(isBackupAdmin('ORGANIZATION_MANAGEMENT', 'DELETE'), true);
  assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'POST'), true);
  assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'GET'), true);
  assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'POST'), false);
  assert.equal(isBackupAdmin('ADMIN', 'GET'), false);
  assert.equal(isBackupAdmin('USER', 'GET'), false);
  assert.equal(isBackupAdmin(undefined, 'GET'), false);
});

test('/internal/* guard: remote peers rejected even with spoofed X-Forwarded-For', () => {
  const guard = requireInternal({ token: '' });
  let status = 0; let passed = false;
  const res = { status(c: number) { status = c; return this; }, json() { return this; } };
  guard({ socket: { remoteAddress: '172.18.0.4' }, headers: { 'x-forwarded-for': '127.0.0.1' } }, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(status, 403);
  guard({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res, () => { passed = true; });
  assert.equal(passed, true);
});
