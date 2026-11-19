/**
 * w3: IMAP ACL rights (RFC 4314) ⇄ folder permissions.
 * Run: node --import tsx --test src/commands/acl-rights.test.ts (in packages/imap-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { ROLE_RIGHTS, READ_ONLY_FLOOR } = await import('@coremail/storage');
const { FULL_ACCESS_RIGHTS, OWNER_RIGHTS, applyImapRights, imapRights, rightsString } = await import('./acl-rights.js');

test('owner, FULL_ACCESS and the READ_ONLY floor keep their 9.1 rights strings', () => {
  assert.equal(imapRights({ level: 'owner', rights: 0 }), OWNER_RIGHTS);
  assert.equal(imapRights({ level: 'full', rights: 0 }), FULL_ACCESS_RIGHTS);
  assert.equal(imapRights({ level: 'grants', rights: READ_ONLY_FLOOR }), 'lr');
});

test('roles → rights strings (canonical order, obsolete c / d reported)', () => {
  const cases: Array<[keyof typeof ROLE_RIGHTS, string]> = [
    ['owner', 'lrswipkxteacd'],
    ['publishingEditor', 'lrswipktecd'],
    ['editor', 'lrswipted'],
    ['publishingAuthor', 'lripkc'],
    ['author', 'lrip'],
    ['nonEditingAuthor', 'lrip'],
    ['reviewer', 'lr'],
    ['contributor', 'lip'],
    ['none', ''],
  ];
  for (const [role, expected] of cases) assert.equal(rightsString(ROLE_RIGHTS[role]), expected, role);
});

test('SETACL: replace, add, remove; tied rights; unknown letters', () => {
  assert.equal(applyImapRights(0, 'lr'), ROLE_RIGHTS.reviewer);
  assert.equal(applyImapRights(0, 'lrswipted'), ROLE_RIGHTS.editor);
  assert.equal(applyImapRights(0, 'lrswipkxteacd'), ROLE_RIGHTS.owner);
  assert.equal(applyImapRights(ROLE_RIGHTS.reviewer, '+i'), ROLE_RIGHTS.reviewer | 0x2);
  assert.equal(applyImapRights(ROLE_RIGHTS.reviewer, '+s'), applyImapRights(ROLE_RIGHTS.reviewer, '+w'), '"s" and "w" are tied');
  assert.equal(applyImapRights(ROLE_RIGHTS.owner, '-a'), applyImapRights(ROLE_RIGHTS.owner, '-x'), '"x" and "a" are tied');
  assert.equal(applyImapRights(ROLE_RIGHTS.editor, '-wt'), ROLE_RIGHTS.author, 'removing "edit / delete all" keeps "edit / delete own"');
  assert.equal(applyImapRights(0, 'c'), 0x80, 'obsolete c = k');
  assert.equal(applyImapRights(0, 'd'), 0x50, 'obsolete d = t + e');
  assert.equal(applyImapRights(ROLE_RIGHTS.owner, ''), 0, 'empty replacement = no rights');
  assert.equal(applyImapRights(0, 'lrz'), null);
  assert.equal(applyImapRights(0, '+1'), null);
});
