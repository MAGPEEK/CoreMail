/**
 * 9.3 backup automation: system scope, "Empfohlene Sicherung einrichten",
 * failure notice text, run outcome / schedule status, job heartbeat + watchdog
 * rules, pg_dump environment and the object-store manifest.
 * Run: node --import tsx --test src/scheduler/automation.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScheduleInput, recommendedSchedules, systemCronBefore, failureNotice, type ScheduleData } from './schedule-input.js';
import { isStale, isOrphanAtStartup, lastBeat, JobHeartbeat } from './job-progress.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'x'.repeat(40);
process.env['PEPPER'] ??= 'y'.repeat(40);
(globalThis as Record<string, unknown>)['__prisma'] ??= { $on: () => undefined };
const { fullBackupOutcome, scheduleStatusOf, jobObjectKeys } = await import('./index.js');
const { pgEnvFromUrl, systemBackupPrefix, writeObjectManifest, runPgDump } = await import('./system-backup.js');

test('schedule input: scope system forces the database dump format and drops a target', () => {
  const r = parseScheduleInput({ name: 'DB', cron: '30 1 * * *', scope: 'system', format: 'zip', targetUserId: 'u1' });
  assert.ok(r.ok);
  assert.deepEqual(r.data, { name: 'DB', cron: '30 1 * * *', scope: 'system', format: 'pgdump', targetUserId: null, retentionDays: 30, enabled: true });
  const stored: ScheduleData = { name: 'n', cron: '0 2 * * *', scope: 'system', format: 'pgdump', targetUserId: null, retentionDays: 14, enabled: true };
  const keep = parseScheduleInput({ enabled: false }, stored);
  assert.ok(keep.ok);
  assert.deepEqual(keep.data, { enabled: false });
  const toFull = parseScheduleInput({ scope: 'full' }, stored);
  assert.ok(toFull.ok);
  assert.equal(toFull.data.format, 'zip');
  assert.equal(parseScheduleInput({ name: 'x', cron: '* * * * *', scope: 'user', targetUserId: 'u1', format: 'pgdump' }).ok, false);
});

test('recommended schedules: only what is missing; env defaults (BACKUP_SCHEDULE / BACKUP_RETENTION_DAYS)', () => {
  const none = recommendedSchedules([], {});
  assert.deepEqual(none.map((s) => [s.scope, s.cron, s.retentionDays, s.format, s.enabled]), [
    ['system', '30 1 * * *', 14, 'pgdump', true],
    ['full', '0 2 * * *', 14, 'zip', true],
  ]);
  const env = recommendedSchedules([], { BACKUP_SCHEDULE: '15 3 * * *', BACKUP_RETENTION_DAYS: '30' });
  assert.deepEqual(env.map((s) => [s.scope, s.cron, s.retentionDays]), [['system', '45 2 * * *', 30], ['full', '15 3 * * *', 30]]);
  const bad = recommendedSchedules([], { BACKUP_SCHEDULE: 'nonsense', BACKUP_RETENTION_DAYS: '0' }, () => false);
  assert.deepEqual(bad.map((s) => [s.cron, s.retentionDays]), [['30 1 * * *', 14], ['0 2 * * *', 14]]);
  assert.deepEqual(recommendedSchedules([{ scope: 'full', enabled: true }], {}).map((s) => s.scope), ['system']);
  assert.deepEqual(recommendedSchedules([{ scope: 'full', enabled: false }], {}).map((s) => s.scope), ['system', 'full'], 'a disabled schedule does not count');
  assert.equal(recommendedSchedules([{ scope: 'full', enabled: true }, { scope: 'system', enabled: true }], {}).length, 0);
  assert.equal(systemCronBefore('10 0 * * *'), '40 23 * * *');
  assert.equal(systemCronBefore('0 2 * * 1'), '30 1 * * *');
  for (const s of none) assert.ok(parseScheduleInput(s).ok, 'recommended rows pass the normal validation');
});

test('failure notice text (German, no secrets)', () => {
  const n = failureNotice({ name: 'Nacht', scope: 'full' }, { jobId: 'j1', status: 'COMPLETED', total: 10, failed: 2, errorMsg: '2 von 10 Postfach-Sicherungen fehlgeschlagen' }, 'mail.ex.com');
  assert.equal(n.subject, 'Backup unvollständig: Nacht');
  assert.match(n.bodyText, /Postfächer: 10, davon fehlgeschlagen: 2/);
  assert.match(n.bodyText, /Job: j1/);
  const f = failureNotice({ name: 'DB', scope: 'system' }, { jobId: 'j2', status: 'FAILED', total: 1, failed: 1, errorMsg: 'pg_dump fehlgeschlagen' }, 'mail.ex.com');
  assert.equal(f.subject, 'Backup fehlgeschlagen: DB');
  assert.match(f.bodyText, /System-Sicherung/);
});

test('run outcome and schedule status', () => {
  assert.deepEqual(fullBackupOutcome('m', 3, 0), { jobId: 'm', status: 'COMPLETED', total: 3, failed: 0, errorMsg: null });
  assert.equal(fullBackupOutcome('m', 3, 1).status, 'COMPLETED');
  assert.match(String(fullBackupOutcome('m', 3, 1).errorMsg), /1 von 3/);
  assert.equal(fullBackupOutcome('m', 3, 3).status, 'FAILED');
  assert.equal(fullBackupOutcome('m', 0, 0).status, 'COMPLETED', 'no active users is not a failure');
  assert.equal(scheduleStatusOf({ status: 'COMPLETED', failed: 0 }), 'COMPLETED');
  assert.equal(scheduleStatusOf({ status: 'COMPLETED', failed: 2 }), 'PARTIAL');
  assert.equal(scheduleStatusOf({ status: 'FAILED', failed: 1 }), 'FAILED');
  assert.deepEqual(jobObjectKeys({ downloadUrl: 'system/d/j/coremail-db.dump.enc', progressMeta: { extraKeys: ['system/d/j/objects-manifest.tsv.enc', 5] } }),
    ['system/d/j/coremail-db.dump.enc', 'system/d/j/objects-manifest.tsv.enc']);
  assert.deepEqual(jobObjectKeys({ downloadUrl: null, progressMeta: null }), []);
});

test('watchdog: stale = no heartbeat for the window (not: started long ago); start-up cleanup', () => {
  const now = Date.parse('2026-11-16T03:00:00Z');
  const longRunning = { startedAt: new Date('2026-11-16T01:00:00Z'), progressMeta: { heartbeatAt: '2026-11-16T02:59:00Z', host: 'other' } };
  assert.equal(isStale(longRunning, now, 15 * 60_000), false, 'a 2-hour backup with a fresh heartbeat is not stuck');
  const dead = { startedAt: new Date('2026-11-16T02:00:00Z'), progressMeta: { heartbeatAt: '2026-11-16T02:30:00Z' } };
  assert.equal(isStale(dead, now, 15 * 60_000), true);
  const legacy = { startedAt: new Date('2026-11-16T02:00:00Z'), progressMeta: {} };
  assert.equal(lastBeat(legacy), Date.parse('2026-11-16T02:00:00Z'));
  assert.equal(isOrphanAtStartup({ ...longRunning, progressMeta: { heartbeatAt: '2026-11-16T02:59:30Z', host: 'me' } }, 'me', now, 180_000), true, 'own host: cannot be running');
  assert.equal(isOrphanAtStartup(longRunning, 'me', now, 180_000), false, 'other host, fresh heartbeat');
  assert.equal(isOrphanAtStartup({ startedAt: null, createdAt: new Date('2026-11-16T02:00:00Z'), progressMeta: null }, 'me', now, 180_000), true);
});

test('JobHeartbeat merges fields, writes the heartbeat + host, stop() returns the meta without heartbeat', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const hb = new JobHeartbeat(async (meta) => { writes.push(meta); }, { phase: 'a' }, 10_000, 0).start();
  await hb.update({ current: 1 });
  await hb.update({ phase: 'b' });
  const last = writes.at(-1)!;
  assert.equal(last['phase'], 'b');
  assert.equal(last['current'], 1);
  assert.equal(typeof last['heartbeatAt'], 'string');
  assert.equal(typeof last['host'], 'string');
  const final = hb.stop();
  assert.equal(final['heartbeatAt'], undefined);
  assert.equal(final['phase'], 'b');
});

test('pg_dump environment from DATABASE_URL: password never in argv, Prisma parameters dropped', () => {
  assert.deepEqual(pgEnvFromUrl('postgresql://coremail_app:p%40ss%3Aw@postgres:5432/coremail?schema=public&connection_limit=5&sslmode=require'), {
    PGHOST: 'postgres', PGPORT: '5432', PGUSER: 'coremail_app', PGPASSWORD: 'p@ss:w', PGDATABASE: 'coremail', PGSSLMODE: 'require',
  });
  assert.equal(pgEnvFromUrl('postgres://u@[::1]/db')['PGHOST'], '::1');
  assert.throws(() => pgEnvFromUrl('mysql://x@y/z'), /PostgreSQL/);
  assert.throws(() => pgEnvFromUrl(''), /valid URL/);
  assert.equal(systemBackupPrefix(new Date('2026-11-16T01:30:00Z'), 'job/1'), 'system/2026-11-16/job_1');
});

test('object-store manifest lists every object; pg_dump errors are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-system-'));
  async function* list() { yield { key: 'raw/ab/x.eml', size: 10 }; yield { key: 'attachments/m1/0-aa', size: 5 }; }
  const totals = await writeObjectManifest(join(dir, 'm.tsv'), list());
  assert.deepEqual(totals, { objects: 2, bytes: 15 });
  assert.equal(readFileSync(join(dir, 'm.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('|'), 'raw/ab/x.eml\t10|attachments/m1/0-aa\t5');
  await assert.rejects(runPgDump(join(dir, 'x.dump'), {}, join(dir, 'no-such-pg_dump')), /nicht verfügbar/);
  // a binary that exits non-zero (node rejects the pg_dump options) → stderr in the message
  await assert.rejects(runPgDump(join(dir, 'x.dump'), {}, process.execPath), /pg_dump fehlgeschlagen \(Exit \d+\)/);
});
