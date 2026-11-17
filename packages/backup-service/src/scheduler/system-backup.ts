/**
 * System backup (9.3, schedule / job scope "system"): the PostgreSQL database
 * (users, settings, certificates, DKIM keys, rules, calendars, contacts, mail
 * metadata) as a `pg_dump` custom-format dump, plus a manifest of the mail
 * object store (key + size of every object), both encrypted into the backup
 * store under `system/<day>/<jobId>/`.
 *
 * NOT included — must be backed up separately (docs/backup.md):
 *   - the mail object store itself (raw messages, attachments: volume
 *     `coremail-data` or the S3 bucket) — the manifest lists what it must contain;
 *   - the secrets in `.env` (JWT_SECRET, PEPPER, BACKUP_ENCRYPTION_KEY,
 *     MFA_ENCRYPTION_KEY, database/Redis passwords).
 * Restore: download the dump in the BCP (decrypted) and `pg_restore` it.
 *
 * pg_dump runs with the connection data from DATABASE_URL in PG* environment
 * variables — the password never appears in the process list.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { prisma, getObjectStore } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { uploadToS3 } from '../upload/s3.js';
import { runInBackground, classifyError, type JobOutcome } from './run-helpers.js';
import { JobHeartbeat } from './job-progress.js';

const log = createLogger('backup:system');

/** libpq environment from a (Prisma) DATABASE_URL; Prisma-only parameters are dropped. */
export function pgEnvFromUrl(url: string): Record<string, string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('DATABASE_URL is not a valid URL'); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new Error('DATABASE_URL is not a PostgreSQL URL');
  const env: Record<string, string> = {};
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host) env['PGHOST'] = decodeURIComponent(host);
  if (u.port) env['PGPORT'] = u.port;
  if (u.username) env['PGUSER'] = decodeURIComponent(u.username);
  if (u.password) env['PGPASSWORD'] = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env['PGDATABASE'] = db;
  const map: Record<string, string> = {
    sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME', host: 'PGHOST', port: 'PGPORT',
  };
  for (const [k, v] of u.searchParams) {
    const name = map[k];
    if (name && v) env[name] = v;
  }
  return env;
}

/** Object key prefix of one system backup. */
export function systemBackupPrefix(date: Date, jobId: string): string {
  return `system/${date.toISOString().slice(0, 10)}/${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Milliseconds from an environment variable given in minutes (fallback when unset / invalid). */
function envMinutes(name: string, fallbackMin: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMin) * 60_000;
}

/** Hard limit for pg_dump: BACKUP_PGDUMP_TIMEOUT_MIN (default 30 minutes). */
export function pgDumpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMinutes('BACKUP_PGDUMP_TIMEOUT_MIN', 30, env);
}

/** Hard limit for one upload to the backup store: BACKUP_UPLOAD_TIMEOUT_MIN (default 60 minutes). */
export function uploadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMinutes('BACKUP_UPLOAD_TIMEOUT_MIN', 60, env);
}

export interface PgDumpOptions {
  /** Kill pg_dump after this many ms (default pgDumpTimeoutMs()). */
  timeoutMs?: number;
  /** Called with the dump size whenever the output file grew (progress for the heartbeat). */
  onProgress?: (bytes: number) => void;
  /** How often the output size is sampled (default 5 s). */
  pollMs?: number;
  /** Grace between SIGTERM and SIGKILL (default 10 s). */
  killGraceMs?: number;
  /** Test seam: arguments placed before the pg_dump options (e.g. a script for `node`). */
  binArgs?: string[];
}

/**
 * Runs pg_dump (custom format) into `outPath`; rejects with the (trimmed) stderr.
 * 9.3 review: a hung pg_dump (locked table, dead connection) is killed after
 * `timeoutMs` (SIGTERM, then SIGKILL) and the job fails — it used to stay
 * RUNNING forever. The output size is reported as progress while it grows.
 */
export function runPgDump(
  outPath: string,
  pgEnv: Record<string, string>,
  bin = process.env['PG_DUMP_BIN'] || 'pg_dump',
  opts: PgDumpOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? pgDumpTimeoutMs();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...(opts.binArgs ?? []), '--format=custom', '--compress=6', '--no-password', `--file=${outPath}`], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...pgEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let lastSize = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const poll = opts.onProgress ? setInterval(() => {
      void stat(outPath).then((s) => {
        if (s.size > lastSize) { lastSize = s.size; opts.onProgress?.(s.size); }
      }, () => undefined);
    }, opts.pollMs ?? 5_000) : undefined;
    poll?.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), opts.killGraceMs ?? 10_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (poll) clearInterval(poll);
    };
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
    child.once('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new Error('pg_dump ist in diesem Container nicht verfügbar') : err);
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (timedOut) {
        reject(Object.assign(
          new Error(`pg_dump nach ${Math.round(timeoutMs / 60_000) || '<1'} Min. abgebrochen (Zeitlimit BACKUP_PGDUMP_TIMEOUT_MIN)`),
          { code: 'ETIMEDOUT' },
        ));
      } else if (code === 0) resolve();
      else reject(new Error(`pg_dump fehlgeschlagen (Exit ${code ?? signal}): ${stderr.trim().slice(-1500) || 'keine Ausgabe'}`));
    });
  });
}

/** Writes "key<TAB>size" per object of the mail object store; returns totals. */
export async function writeObjectManifest(
  outPath: string,
  list: AsyncIterable<{ key: string; size: number }> = getObjectStore().list(''),
  onProgress?: (objects: number) => void,
): Promise<{ objects: number; bytes: number }> {
  const ws = createWriteStream(outPath, { mode: 0o600 });
  let objects = 0;
  let bytes = 0;
  try {
    ws.write('# CoreMail object store manifest: key<TAB>size\n');
    for await (const o of list) {
      objects++;
      bytes += o.size;
      if (!ws.write(`${o.key}\t${o.size}\n`)) await once(ws, 'drain');
      if (objects % 1000 === 0) onProgress?.(objects);
    }
  } finally {
    ws.end();
    await once(ws, 'close').catch(() => undefined);
  }
  return { objects, bytes };
}

interface RunOpts { triggeredBy?: string; scheduleId?: string }

/** Starts a system backup job; `done` resolves when it ended. */
export async function runSystemBackup(opts: RunOpts = {}): Promise<{ jobId: string; done: Promise<JobOutcome> }> {
  const startedAt = new Date();
  const job = await prisma.backupJob.create({
    data: {
      scope: 'system',
      format: 'pgdump',
      status: 'RUNNING',
      triggeredBy: opts.triggeredBy ?? 'MANUAL',
      ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
      startedAt,
    },
  });

  const work = async (): Promise<JobOutcome> => {
    const hb = new JobHeartbeat(async (meta, progress) => {
      await prisma.backupJob.update({ where: { id: job.id }, data: { progressMeta: meta as never, ...(progress !== undefined ? { progress } : {}) } });
    }, { phase: 'database' }, undefined, undefined, { trackProgress: true }).start();
    const dir = await mkdtemp(join(tmpdir(), 'coremail-system-'));
    try {
      const prefix = systemBackupPrefix(startedAt, job.id);
      const dumpPath = join(dir, 'coremail-db.dump');
      // 9.3 review: hard limits (pg_dump kill timeout, upload timeout) and real
      // progress (dump size, uploaded bytes, listed objects) for the watchdog's
      // stall detection — a hung step can no longer keep the job RUNNING.
      const touch = () => { void hb.touch(); };
      await runPgDump(dumpPath, pgEnvFromUrl(process.env['DATABASE_URL'] ?? ''), undefined, { onProgress: touch });
      const dumpSize = (await stat(dumpPath)).size;
      await hb.update({ phase: 'upload-database' }, 40);
      const upOpts = { timeoutMs: uploadTimeoutMs(), onProgress: touch };
      const dump = await uploadToS3(dumpPath, `${prefix}/coremail-db.dump`, 'application/octet-stream', upOpts);

      await hb.update({ phase: 'object-manifest' }, 60);
      const manifestPath = join(dir, 'objects-manifest.tsv');
      const store = getObjectStore();
      const totals = await writeObjectManifest(manifestPath, store.list(''), touch);
      const manifest = await uploadToS3(manifestPath, `${prefix}/objects-manifest.tsv`, 'text/tab-separated-values', upOpts);
      const manifestSize = (await stat(manifestPath)).size;

      const finishedAt = new Date();
      const meta = hb.stop();
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          downloadUrl: dump.key,
          completedAt: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          sizeBytes: BigInt(dumpSize + manifestSize),
          progressMeta: {
            ...meta,
            phase: 'done',
            extraKeys: [manifest.key],
            objectStore: { driver: store.driver, objects: totals.objects, bytes: totals.bytes },
            appVersion: process.env['COREMAIL_VERSION'] ?? null,
          } as never,
        },
      });
      log.info({ jobId: job.id, dumpSize, objects: totals.objects }, 'System backup complete');
      return { jobId: job.id, status: 'COMPLETED', total: 1, failed: 0, errorMsg: null };
    } catch (err) {
      const meta = hb.stop();
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, jobId: job.id }, 'System backup failed');
      await prisma.backupJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMsg, errorClass: classifyError(err), completedAt: new Date(), progressMeta: { ...meta, phase: 'failed' } as never },
      }).catch(() => undefined);
      return { jobId: job.id, status: 'FAILED', total: 1, failed: 1, errorMsg };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return { jobId: job.id, done: runInBackground(work, job.id) };
}
