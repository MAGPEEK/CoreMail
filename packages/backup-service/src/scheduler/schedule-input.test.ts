/**
 * 9.1.x: backup schedule input, reload signature and retention cutoff.
 * Run: node --import tsx --test src/scheduler/schedule-input.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleInput, retentionCutoff, retentionWindow, newestArchivePerMailbox, scheduleSignature, type ScheduleData } from './schedule-input.js';

const stored: ScheduleData = { name: 'n', cron: '0 2 * * *', scope: 'user', format: 'mbox', targetUserId: 'u1', retentionDays: 30, enabled: true };

test('create: defaults; full backups are always zip without a target', () => {
  const r = parseScheduleInput({ name: ' Nightly ', cron: '0 2 * * *', format: 'mbox', targetUserId: 'u9' });
  assert.ok(r.ok);
  assert.deepEqual(r.data, { name: 'Nightly', cron: '0 2 * * *', scope: 'full', format: 'zip', targetUserId: null, retentionDays: 30, enabled: true });
});

test('create: scope user needs a target; bad enums / retention rejected', () => {
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', scope: 'user' }).ok, false);
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', scope: 'all' }).ok, false);
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', format: 'pst' }).ok, false);
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', retentionDays: 0 }).ok, false);
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', retentionDays: '30' }).ok, false);
  assert.equal(parseScheduleInput({ cron: '* * * * *' }).ok, false, 'name required');
});

test('update: merged with the stored row', () => {
  const clear = parseScheduleInput({ targetUserId: null }, stored);
  assert.equal(clear.ok, false, 'user scope cannot lose its target');
  const toFull = parseScheduleInput({ scope: 'full' }, stored);
  assert.ok(toFull.ok);
  assert.deepEqual(toFull.data, { scope: 'full', format: 'zip', targetUserId: null });
  const keep = parseScheduleInput({ enabled: false }, stored);
  assert.ok(keep.ok);
  assert.deepEqual(keep.data, { enabled: false });
});

test('signature changes with scope / format / target, not only cron', () => {
  const a = scheduleSignature(stored);
  assert.notEqual(a, scheduleSignature({ ...stored, targetUserId: 'u2' }));
  assert.notEqual(a, scheduleSignature({ ...stored, format: 'zip' }));
  assert.notEqual(a, scheduleSignature({ ...stored, scope: 'full' }));
  assert.equal(a, scheduleSignature({ ...stored }));
});

test('retention cutoff', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  assert.equal(retentionCutoff(30, now).toISOString(), '2026-10-17T00:00:00.000Z');
  assert.equal(retentionCutoff(0, now).toISOString(), '2026-11-15T00:00:00.000Z', 'at least one day');
});

test('retention keeps the newest archive of every mailbox, not just the newest job', () => {
  const keep = newestArchivePerMailbox([
    { id: 'master-2', userId: null, downloadUrl: null },      // newest full run, all exports failed
    { id: 'master-1', userId: null, downloadUrl: null },
    { id: 'alice-2', userId: 'alice', downloadUrl: 'k/a2' },
    { id: 'bob-1', userId: 'bob', downloadUrl: 'k/b1' },
    { id: 'alice-1', userId: 'alice', downloadUrl: 'k/a1' },
  ]);
  assert.deepEqual([...keep].sort(), ['alice-2', 'bob-1', 'master-2']);
});

test('retention window never reaches backups from before the upgrade', () => {
  const since = new Date('2026-11-16T00:00:00Z');
  assert.equal(retentionWindow(since, new Date('2026-11-01T00:00:00Z')), null, 'cutoff before enforcement → nothing expires');
  assert.equal(retentionWindow(since, since), null);
  const w = retentionWindow(since, new Date('2026-12-20T00:00:00Z'));
  assert.deepEqual(w && [w.gte.toISOString(), w.lt.toISOString()], ['2026-11-16T00:00:00.000Z', '2026-12-20T00:00:00.000Z']);
});

test('fullBackupUserKey: two full backups on the same day never share an object key (live BCP test 9.2)', async () => {
  const { fullBackupUserKey } = await import('./schedule-input.js');
  const d = new Date('2026-11-16T18:05:00Z');
  const a = fullBackupUserKey(d, 'job1', 'bob@e2e.test');
  const b = fullBackupUserKey(new Date('2026-11-16T18:08:00Z'), 'job2', 'bob@e2e.test');
  assert.equal(a, 'full-backup/2026-11-16/job1/bob_at_e2e.test.zip');
  assert.notEqual(a, b);
  assert.equal(fullBackupUserKey(d, '../x', 'a/b@c'), 'full-backup/2026-11-16/___x/a_b_at_c.zip');
});
