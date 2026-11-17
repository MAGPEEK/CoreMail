/**
 * 9.3: restore request validation, archive keys, flags and folder mapping. Pure.
 * Run: node --import tsx --test src/restore/source.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveKeyInfo, parseRestoreRequest, parseUploadQuery, restoreFolderName, sanitizeFlags, targetFolderName,
} from './source.js';
import { fullBackupUserKey } from '../scheduler/schedule-input.js';
import { canDownloadBackup, isBackupAdmin, isMailboxDataRoute } from '../http-utils.js';

test('archive keys: owner, format, encryption, date', () => {
  const m = archiveKeyInfo('mailbox/cuser123/1763251200000.zip.enc');
  assert.deepEqual({ ...m, date: m.date?.toISOString() }, {
    format: 'zip', encrypted: true, kind: 'mailbox', ownerUserId: 'cuser123', ownerEmailGuess: null, date: '2025-11-16T00:00:00.000Z',
  });
  const full = archiveKeyInfo(`${fullBackupUserKey(new Date('2026-11-16T02:00:00Z'), 'run1', 'Bob.Smith@ex.com')}.enc`);
  assert.equal(full.kind, 'full');
  assert.equal(full.format, 'zip');
  assert.equal(full.ownerEmailGuess, 'Bob.Smith@ex.com');
  assert.equal(full.date?.toISOString(), '2026-11-16T00:00:00.000Z');
  assert.equal(archiveKeyInfo('full-backup/2025-01-02/old_at_ex.com.zip').ownerEmailGuess, 'old@ex.com', 'pre-9.2 key');
  assert.equal(archiveKeyInfo('mailbox/u1/2.mbox').format, 'mbox');
  assert.equal(archiveKeyInfo('system/2026-11-16/j1/coremail-db.dump.enc').format, null, 'system dumps are not restorable here');
  assert.equal(archiveKeyInfo('system/2026-11-16/j1/x.zip.enc').format, null);
  assert.equal(archiveKeyInfo('misc/notes.txt').format, null);
});

test('restore request: exactly one source; modes; ids validated', () => {
  assert.deepEqual(parseRestoreRequest({ jobId: 'j1' }), { ok: true, value: { jobId: 'j1', key: null, targetUserId: null, mode: 'subfolder', folderId: null } });
  const r = parseRestoreRequest({ key: 'mailbox/u/1.zip.enc', targetUserId: 'u2', mode: 'original', folderId: 'ignored' });
  assert.ok(r.ok && r.value.mode === 'original' && r.value.folderId === null && r.value.targetUserId === 'u2');
  assert.equal(parseRestoreRequest({}).ok, false);
  assert.equal(parseRestoreRequest({ jobId: 'j', key: 'k' }).ok, false);
  assert.equal(parseRestoreRequest({ jobId: '../x' }).ok, false);
  assert.equal(parseRestoreRequest({ jobId: 'j', mode: 'merge' }).ok, false);
  assert.equal(parseRestoreRequest({ jobId: 'j', mode: 'folder' }).ok, false, 'folder mode needs folderId');
  assert.equal(parseRestoreRequest({ jobId: 'j', targetUserId: 5 }).ok, false);
  assert.ok(parseRestoreRequest({ jobId: 'j', mode: 'folder', folderId: 'f1' }).ok);
});

test('upload query: folderId alone keeps the pre-9.3 behaviour; mode required otherwise', () => {
  assert.deepEqual(parseUploadQuery({ folderId: 'f1' }), { ok: true, mode: 'folder', folderId: 'f1' });
  assert.deepEqual(parseUploadQuery({ mode: 'subfolder' }), { ok: true, mode: 'subfolder', folderId: null });
  assert.equal(parseUploadQuery({}).ok, false);
  assert.equal(parseUploadQuery({ mode: 'folder' }).ok, false);
  assert.equal(parseUploadQuery({ mode: 'x' }).ok, false);
  assert.equal(parseUploadQuery({ folderId: '../etc' }).ok, false);
});

test('restore folder name = date of the backup (re-running hits the same folder)', () => {
  assert.equal(restoreFolderName(new Date('2026-11-16T23:59:00Z')), 'Wiederhergestellt 2026-11-16');
});

test('flags: system flags normalized, \\Recent/\\Deleted dropped, keywords kept, null → \\Seen', () => {
  assert.deepEqual(sanitizeFlags(null), ['\\Seen']);
  assert.deepEqual(sanitizeFlags(['\\SEEN', '\\Deleted', '\\Recent', '\\Flagged', '$Forwarded', 'bad flag', '\\seen', 'Junk']), ['\\Seen', '\\Flagged', '$Forwarded', 'Junk']);
  assert.deepEqual(sanitizeFlags([]), []);
});

test('target folder mapping', () => {
  const root = 'Wiederhergestellt 2026-11-16';
  assert.equal(targetFolderName('subfolder', 'INBOX', root), `${root}.INBOX`);
  assert.equal(targetFolderName('subfolder', 'inbox.Sub', root), `${root}.INBOX.Sub`);
  assert.equal(targetFolderName('subfolder', null, root), root);
  assert.equal(targetFolderName('original', null, root), 'INBOX');
  assert.equal(targetFolderName('original', 'Projekte..2026', root), 'Projekte.2026');
  assert.equal(targetFolderName('original', 'Shared/Team', root, (n) => n.startsWith('Shared/')), `${root}.Shared/Team`);
});

test('RBAC: restore is a mailbox-data route; system dumps only for ORGANIZATION_MANAGEMENT', () => {
  assert.equal(isMailboxDataRoute('/backup/admin/restore'), true);
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'POST', '/backup/admin/restore'), true);
  assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'POST', '/backup/admin/restore'), false);
  assert.equal(isBackupAdmin('VIEW_ONLY_ORG', 'POST', '/backup/admin/restore'), false);
  assert.equal(isBackupAdmin('SERVER_MANAGEMENT', 'POST', '/backup/admin/schedules/recommended'), true);
  assert.equal(isBackupAdmin('COMPLIANCE_MANAGEMENT', 'POST', '/backup/admin/schedules/recommended'), false);
  assert.equal(canDownloadBackup('ORGANIZATION_MANAGEMENT', 'system/2026-11-16/j/coremail-db.dump.enc'), true);
  assert.equal(canDownloadBackup('COMPLIANCE_MANAGEMENT', 'system/2026-11-16/j/coremail-db.dump.enc'), false);
  assert.equal(canDownloadBackup('COMPLIANCE_MANAGEMENT', 'odd-key.enc', 'system'), false);
  assert.equal(canDownloadBackup('COMPLIANCE_MANAGEMENT', 'mailbox/u/1.zip.enc', 'user'), true);
  assert.equal(canDownloadBackup('SERVER_MANAGEMENT', 'mailbox/u/1.zip.enc'), false);
});
