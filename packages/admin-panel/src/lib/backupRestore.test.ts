import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveKeyInfo, restoreSources, sourceLabel, restoreFolderPreview, restoreFormError, restoreRequestBody, uploadQuery,
  restoreSummary, jobScopeLabel, canRestoreJob, canDownloadJob, scheduleStatusLabel, describeCron,
  needsRecommendedSetup, backupCoverage, type RestoreSource,
} from './backupRestore.ts';

const users = [{ id: 'u1', email: 'alice@ex.com' }, { id: 'u2', email: 'Bob.Smith@ex.com' }];

test('archive keys: mailbox / full (9.2 + pre-9.2) / system', () => {
  assert.deepEqual(archiveKeyInfo('mailbox/u1/1763251200000.mbox.enc'), {
    format: 'mbox', encrypted: true, kind: 'mailbox', ownerUserId: 'u1', ownerEmailGuess: null, date: '2025-11-16T00:00:00.000Z',
  });
  assert.equal(archiveKeyInfo('full-backup/2026-11-16/run1/Bob.Smith_at_ex.com.zip.enc').ownerEmailGuess, 'Bob.Smith@ex.com');
  assert.equal(archiveKeyInfo('full-backup/2026-01-02/a_at_b.de.zip').date, '2026-01-02T00:00:00.000Z');
  assert.equal(archiveKeyInfo('system/2026-11-16/j/coremail-db.dump.enc').format, null);
});

test('restore sources: union of archive objects and completed jobs, owners resolved, system dumps left out, newest first', () => {
  const objects = [
    { key: 'full-backup/2026-11-15/run1/bob.smith_at_ex.com.zip.enc', size: 100, lastModified: '2026-11-15T02:10:00.000Z' },
    { key: 'system/2026-11-16/j9/coremail-db.dump.enc', size: 5, lastModified: '2026-11-16T01:31:00.000Z' },
    { key: 'mailbox/u1/1763290000000.zip.enc', size: 50, lastModified: '2026-11-16T10:00:00.000Z' },
    { key: 'notes.txt', size: 1, lastModified: '2026-11-16T10:00:00.000Z' },
  ];
  const jobs = [
    { id: 'j1', userId: 'u1', scope: 'user', format: 'zip', status: 'COMPLETED', downloadUrl: 'mailbox/u1/1763290000000.zip.enc', createdAt: '2026-11-16T09:59:00.000Z' },
    { id: 'j2', userId: 'u1', scope: 'user', format: 'mbox', status: 'COMPLETED', downloadUrl: 'mailbox/u1/1763000000000.mbox.enc', createdAt: '2026-11-13T00:00:00.000Z', sizeBytes: '77' },
    { id: 'j3', userId: 'u1', scope: 'user', format: 'zip', status: 'FAILED', downloadUrl: null, createdAt: '2026-11-17T00:00:00.000Z' },
  ];
  const s = restoreSources(objects, jobs, users);
  assert.deepEqual(s.map((x) => [x.key.split('/')[0], x.jobId, x.ownerUserId, x.ownerEmail, x.size]), [
    ['mailbox', 'j1', 'u1', 'alice@ex.com', 50],
    ['full-backup', null, 'u2', 'Bob.Smith@ex.com', 100],
    ['mailbox', 'j2', 'u1', 'alice@ex.com', 77],
  ]);
  assert.equal(sourceLabel(s[0]!, () => '16.11.26'), 'alice@ex.com — Postfach-Backup (ZIP, verschlüsselt) — 16.11.26');
  assert.equal(sourceLabel({ ...s[1]!, ownerEmail: null }, () => 'd'), 'unbekanntes Postfach — Vollbackup (ZIP, verschlüsselt) — d');
});

test('restore form: validation + request body', () => {
  const src: RestoreSource = { key: 'mailbox/u1/1.zip.enc', jobId: 'j1', kind: 'mailbox', format: 'zip', encrypted: true, ownerUserId: 'u1', ownerEmail: 'a', date: '2026-11-16T00:00:00Z', size: 1 };
  assert.equal(restoreFormError({ source: null, targetUserId: '', mode: 'subfolder', folderId: '' }), 'Bitte ein Backup-Archiv wählen');
  assert.equal(restoreFormError({ source: src, targetUserId: '', mode: 'subfolder', folderId: '' }), null, 'owner is the default target');
  assert.match(String(restoreFormError({ source: { ...src, ownerUserId: null }, targetUserId: '', mode: 'subfolder', folderId: '' })), /Zielpostfach/);
  assert.match(String(restoreFormError({ source: src, targetUserId: '', mode: 'folder', folderId: '' })), /Zielordner/);
  assert.deepEqual(restoreRequestBody({ source: src, targetUserId: '', mode: 'subfolder', folderId: 'x' }), { jobId: 'j1', mode: 'subfolder' });
  assert.deepEqual(restoreRequestBody({ source: { ...src, jobId: null }, targetUserId: 'u2', mode: 'folder', folderId: 'f1' }), { key: 'mailbox/u1/1.zip.enc', targetUserId: 'u2', mode: 'folder', folderId: 'f1' });
  assert.equal(uploadQuery('subfolder', 'f1'), 'mode=subfolder');
  assert.equal(uploadQuery('folder', 'f 1'), 'mode=folder&folderId=f%201');
  assert.equal(restoreFolderPreview('2026-11-16T23:00:00Z'), 'Wiederhergestellt 2026-11-16');
});

test('jobs list: restore summary, scope labels, restore / download rules', () => {
  assert.equal(restoreSummary({ imported: 12, duplicates: 3, failed: 1, otherEntries: 0, targetFolder: 'Wiederhergestellt 2026-11-16' }),
    '12 wiederhergestellt · 3 bereits vorhanden · 1 fehlgeschlagen → „Wiederhergestellt 2026-11-16“');
  assert.equal(restoreSummary({ imported: 0, duplicates: 4, targetFolder: null }), '0 wiederhergestellt · 4 bereits vorhanden');
  // 9.5: restored address book; otherEntries are only calendar / other files now
  assert.equal(restoreSummary({
    imported: 2, duplicates: 0, failed: 0, otherEntries: 1, targetFolder: 'Wiederhergestellt 2026-11-16',
    contactsImported: 5, contactGroupsImported: 2, contactsDuplicates: 3, contactGroupsDuplicates: 1, addressBookFailed: 0,
  }), '2 wiederhergestellt → „Wiederhergestellt 2026-11-16“ · Kontakte wiederhergestellt: 5, Kontaktlisten: 2, '
    + 'übersprungen (bereits vorhanden): 4 · 1 Kalender-/sonstige Dateien nicht übernommen');
  assert.equal(restoreSummary({ imported: 0, duplicates: 0, contactsImported: 0, contactGroupsImported: 0, contactsDuplicates: 2, addressBookFailed: 1 }),
    '0 wiederhergestellt · Kontakte wiederhergestellt: 0, Kontaktlisten: 0, übersprungen (bereits vorhanden): 2 · 1 Kontakte/Kontaktlisten fehlgeschlagen');
  assert.ok(!String(restoreSummary({ imported: 1, duplicates: 0, contactsImported: 0 })).includes('Kontakte'), 'no address book line for an archive without one');
  assert.equal(restoreSummary({ phase: 'done', current: 3 }), null);
  assert.equal(restoreSummary(null), null);
  assert.equal(jobScopeLabel('restore'), 'Wiederherstellung');
  assert.equal(jobScopeLabel('system'), 'System (Datenbank)');
  assert.equal(canRestoreJob({ status: 'COMPLETED', downloadUrl: 'mailbox/u1/1.zip.enc', scope: 'user' }), true);
  assert.equal(canRestoreJob({ status: 'COMPLETED', downloadUrl: 'system/d/j/coremail-db.dump.enc', scope: 'system' }), false);
  assert.equal(canRestoreJob({ status: 'FAILED', downloadUrl: null, scope: 'user' }), false);
  assert.equal(canDownloadJob('COMPLIANCE_MANAGEMENT', { scope: 'system', downloadUrl: 'system/x' }), false);
  assert.equal(canDownloadJob('ORGANIZATION_MANAGEMENT', { scope: 'system', downloadUrl: 'system/x' }), true);
  assert.equal(canDownloadJob('COMPLIANCE_MANAGEMENT', { scope: 'user', downloadUrl: 'mailbox/u/1.zip.enc' }), true);
});

test('schedules: status labels and cron descriptions', () => {
  assert.equal(scheduleStatusLabel('PARTIAL').tone, 'warn');
  assert.equal(scheduleStatusLabel(null).label, 'Noch nicht gelaufen');
  assert.equal(describeCron('0 2 * * *'), 'täglich 02:00 UTC');
  assert.equal(describeCron('30 1 * * 0'), 'sonntags 01:30 UTC');
  assert.equal(describeCron('5 3 1 * *'), 'monatlich am 1. 03:05 UTC');
  assert.equal(describeCron('15 * * * *'), 'stündlich zur Minute 15');
  assert.equal(describeCron('*/5 2 * * *'), '*/5 2 * * *');
});

test('automation: recommended setup needed until full + system schedules are enabled; coverage names the gaps', () => {
  assert.equal(needsRecommendedSetup([]), true);
  const full = { scope: 'full', enabled: true, cron: '0 2 * * *', retentionDays: 30 };
  const system = { scope: 'system', enabled: true, cron: '30 1 * * *', retentionDays: 30 };
  assert.equal(needsRecommendedSetup([full]), true);
  assert.equal(needsRecommendedSetup([full, { ...system, enabled: false }]), true);
  assert.equal(needsRecommendedSetup([full, system]), false);

  const none = backupCoverage([]);
  assert.deepEqual(none.map((c) => c.state), ['missing', 'missing', 'missing', 'manual', 'manual', 'manual']);
  const all = backupCoverage([full, system]);
  assert.deepEqual(all.map((c) => c.state), ['covered', 'partial', 'covered', 'manual', 'manual', 'manual']);
  assert.equal(all[0]!.detail, 'Vollbackup täglich 02:00 UTC, 30 Tage aufbewahrt');
  assert.ok(all.some((c) => c.what.includes('BACKUP_ENCRYPTION_KEY')), 'keys are never in the backups');
  assert.equal(backupCoverage([{ scope: 'user', enabled: true, cron: '0 2 * * *', retentionDays: 7, targetUserId: 'u1' }])[0]!.state, 'partial');
});
