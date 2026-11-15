/**
 * v6 backup-service HTTP helpers: `?limit=` parsing (abc used to crash the
 * service), backup admin roles, internal-route guard wiring.
 * Run: node --import tsx --test src/http-utils.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit, isBackupAdmin, isMailboxDataRoute } from './http-utils.js';
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

test('isBackupAdmin with path: mailbox content only for ORG + COMPLIANCE (9.1)', () => {
  const dl = '/backup/admin/download/job1';
  const mb = '/backup/admin/mailbox/u1';
  const imp = '/backup/admin/import/u1';
  const arch = '/backup/admin/archive/download';
  for (const p of [dl, mb, imp, arch]) {
    const m = p === dl || p === arch ? 'GET' : 'POST';
    assert.equal(isBackupAdmin('ORGANIZATION_MANAGEMENT', m, p), true, p);
    assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', m, p), true, p);
    assert.equal(isBackupAdmin('SERVER_MANAGEMENT', m, p), false, p);
    assert.equal(isBackupAdmin('VIEW_ONLY_ORG', m, p), false, p);
    assert.equal(isBackupAdmin('HELP_DESK', m, p), false, p);
  }
  // listings
  for (const p of ['/backup/admin/jobs', '/backup/admin/users', '/backup/admin/list']) {
    assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'GET', p), true, p);
    assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'GET', p), true, p);
  }
  // server administration stays with ORG + SERVER
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'POST', '/backup/admin/full'), false);
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'GET', '/backup/admin/schedules'), false);
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'DELETE', '/backup/admin/jobs/j1'), false);
  assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'POST', '/backup/admin/full'), true);
  assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'DELETE', '/backup/admin/archive'), true);
  assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'DELETE', '/backup/admin/archive'), false);
});

test('mailbox-data classification is case-insensitive; the app routes case-sensitively (9.1)', async () => {
  for (const p of ['/backup/admin/DOWNLOAD/job1', '/Backup/Admin/Mailbox/u1', '/backup/admin/ARCHIVE/download', '/BACKUP/ADMIN/IMPORT/u1']) {
    assert.equal(isMailboxDataRoute(p), true, p);
    assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'GET', p), false, p);
    assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'GET', p), false, p);
  }
  // listings stay case-sensitive for COMPLIANCE_MANAGEMENT (stricter, never wider)
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'GET', '/backup/admin/JOBS'), false);
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
  const setAt = src.indexOf("app.set('case sensitive routing', true)");
  assert.ok(setAt > 0, 'server.ts enables case-sensitive routing');
  assert.ok(setAt < src.indexOf('app.use('), 'before the first middleware/route creates the router');
});
