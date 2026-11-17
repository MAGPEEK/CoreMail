/**
 * 9.3 review: a hung system backup can no longer stay RUNNING forever —
 *  - pg_dump is killed after its time limit (SIGTERM, then SIGKILL) and reports
 *    the growing dump size as progress;
 *  - an upload that never finishes is aborted after its time limit;
 *  - JobHeartbeat records `progressAt` (opt-in) and the watchdog's isStalled()
 *    fails jobs that are alive but make no progress.
 * Fakes only: a node script stands in for pg_dump, a TCP server that never
 * answers stands in for S3.
 * Run: node --import tsx --test src/scheduler/system-backup-limits.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';
(globalThis as Record<string, unknown>)['__prisma'] ??= { $on: () => undefined };

const { runPgDump, pgDumpTimeoutMs, uploadTimeoutMs } = await import('./system-backup.js');
const { JobHeartbeat, isStalled, lastProgress, stallTimeoutMs } = await import('./job-progress.js');

const dir = mkdtempSync(join(tmpdir(), 'cm-pgdump-'));
/** Fake pg_dump: writes to --file=… every 30 ms; hangs forever unless FAKE_EXIT_AFTER ms is set. */
const fake = join(dir, 'fake-pg_dump.mjs');
writeFileSync(fake, `
import { appendFileSync } from 'node:fs';
const file = process.argv.find((a) => a.startsWith('--file='))?.slice(7);
setInterval(() => appendFileSync(file, 'x'.repeat(64)), 30);
const exitAfter = Number(process.env.FAKE_EXIT_AFTER || 0);
if (exitAfter) setTimeout(() => process.exit(0), exitAfter);
process.on('SIGTERM', () => { if (process.env.FAKE_IGNORE_TERM) return; process.exit(143); });
`);

test('pg_dump that never ends is killed after the time limit (also when it ignores SIGTERM)', async () => {
  const out = join(dir, 'hang.dump');
  const t0 = Date.now();
  await assert.rejects(
    runPgDump(out, { FAKE_IGNORE_TERM: '1' }, process.execPath, { timeoutMs: 300, killGraceMs: 200, binArgs: [fake] }),
    (err: unknown) => /abgebrochen \(Zeitlimit BACKUP_PGDUMP_TIMEOUT_MIN\)/.test((err as Error).message)
      && (err as { code?: string }).code === 'ETIMEDOUT',
  );
  const took = Date.now() - t0;
  assert.ok(took >= 300 && took < 5_000, `killed after ${took} ms`);
});

test('pg_dump progress: the growing dump size is reported; a normal exit resolves', async () => {
  const out = join(dir, 'ok.dump');
  const sizes: number[] = [];
  await runPgDump(out, { FAKE_EXIT_AFTER: '400' }, process.execPath, {
    timeoutMs: 10_000, pollMs: 40, binArgs: [fake], onProgress: (b) => sizes.push(b),
  });
  assert.ok(existsSync(out));
  assert.ok(sizes.length >= 2, `progress reported ${sizes.length}×`);
  assert.ok(sizes.every((s, i) => i === 0 || s > sizes[i - 1]!), 'strictly growing');
});

test('time limits are configurable (minutes) with safe defaults', () => {
  assert.equal(pgDumpTimeoutMs({}), 30 * 60_000);
  assert.equal(pgDumpTimeoutMs({ BACKUP_PGDUMP_TIMEOUT_MIN: '90' }), 90 * 60_000);
  assert.equal(pgDumpTimeoutMs({ BACKUP_PGDUMP_TIMEOUT_MIN: 'x' }), 30 * 60_000);
  assert.equal(uploadTimeoutMs({}), 60 * 60_000);
  assert.equal(stallTimeoutMs({}), 60 * 60_000);
  assert.equal(stallTimeoutMs({ BACKUP_STALL_TIMEOUT_MIN: '20' }), 20 * 60_000);
  assert.equal(stallTimeoutMs({ BACKUP_STALL_TIMEOUT_MIN: '1' }), 60 * 60_000, 'below 5 minutes is ignored');
});

test('upload to a backup store that never answers is aborted after the time limit', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((s) => { sockets.add(s); s.on('error', () => undefined); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  process.env['S3_ENDPOINT'] = `http://127.0.0.1:${port}`;
  process.env['S3_ACCESS_KEY'] = 'test';
  process.env['S3_SECRET_KEY'] = 'test-secret';
  const { uploadToS3 } = await import('../upload/s3.js');
  const file = join(dir, 'upload.bin');
  writeFileSync(file, Buffer.alloc(1024, 1));
  try {
    const t0 = Date.now();
    await assert.rejects(
      uploadToS3(file, 'system/x/test.bin', 'application/octet-stream', { timeoutMs: 400 }),
      (err: unknown) => /Zeitlimit BACKUP_UPLOAD_TIMEOUT_MIN/.test((err as Error).message),
    );
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

test('stall detection: progressAt follows update()/touch(); alive but no progress = stalled', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const hb = new JobHeartbeat(async (m) => { writes.push(m); }, { phase: 'database' }, 10_000, 0, { trackProgress: true }).start();
  await new Promise((r) => setTimeout(r, 15));
  const first = Date.parse(String(writes.at(-1)!['progressAt']));
  await new Promise((r) => setTimeout(r, 15));
  await hb.touch();
  const second = Date.parse(String(writes.at(-1)!['progressAt']));
  assert.ok(second > first, 'touch() advances progressAt');
  const meta = hb.stop();
  assert.equal(meta['progressAt'], undefined);

  const now = Date.parse('2026-11-16T03:00:00Z');
  const hung = { startedAt: new Date('2026-11-16T01:00:00Z'), progressMeta: { heartbeatAt: '2026-11-16T02:59:30Z', progressAt: '2026-11-16T01:30:00Z' } };
  assert.equal(isStalled(hung, now, 60 * 60_000), true, 'heartbeat fresh, no progress for 90 min');
  const working = { ...hung, progressMeta: { heartbeatAt: '2026-11-16T02:59:30Z', progressAt: '2026-11-16T02:58:00Z' } };
  assert.equal(isStalled(working, now, 60 * 60_000), false);
  const legacy = { startedAt: new Date('2026-11-16T01:00:00Z'), progressMeta: { heartbeatAt: '2026-11-16T02:59:30Z' } };
  assert.equal(lastProgress(legacy), null);
  assert.equal(isStalled(legacy, now, 60 * 60_000), false, 'jobs without progress tracking are never stall-failed');

  // without trackProgress no progressAt is written
  const plain: Array<Record<string, unknown>> = [];
  const hb2 = new JobHeartbeat(async (m) => { plain.push(m); }, {}, 10_000, 0).start();
  await hb2.update({ phase: 'x' });
  hb2.stop();
  assert.equal(plain.every((m) => !('progressAt' in m)), true);
});
