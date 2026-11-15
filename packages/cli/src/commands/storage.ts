/**
 * `coremail storage …` — object storage status and migration (v7.1).
 * Talks to /api/v1/admin/storage (ORGANIZATION_MANAGEMENT). The copy runs as a
 * background job in the api-gateway; this command starts it and polls.
 *
 *   coremail storage status
 *   coremail storage check
 *   coremail storage migrate --from minio --to filesystem [--dry-run] [--verify-existing] [--no-wait]
 *   coremail storage migrate-status
 *   coremail storage migrate-cancel
 */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { formatBytes, printJson } from '../output.js';

const DRIVERS = ['minio', 's3', 'filesystem'] as const;

export interface MigrationProgressView {
  phase: string;
  dryRun: boolean;
  scanned: number;
  copied: number;
  skipped: number;
  verified: number;
  failed: number;
  bytesScanned: number;
  bytesCopied: number;
  errors: Array<{ key: string; error: string }>;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface MigrationJobView {
  id: string;
  from: string;
  to: string;
  fromLocation: string;
  toLocation: string;
  dryRun: boolean;
  running: boolean;
  progress: MigrationProgressView;
}

interface HealthView { status: string; blocking?: boolean; sampled?: number; missing?: number; missingKeys?: string[]; lifecycle?: boolean; error?: string; hint?: string; checkedAt?: string }
interface StatusView { driver: string | null; location: string | null; error?: string; health: HealthView | null; migration: MigrationJobView | null }

/** One progress line (also used for the final summary). */
export function formatProgress(p: MigrationProgressView): string {
  const verb = p.dryRun ? 'to copy' : 'copied';
  return `[${p.phase}] scanned ${p.scanned} (${formatBytes(p.bytesScanned)}), ${verb} ${p.copied} (${formatBytes(p.bytesCopied)}), `
    + `already present ${p.skipped}, verified ${p.verified}, failed ${p.failed}`;
}

export function validateDrivers(from: string, to: string): void {
  if (!(DRIVERS as readonly string[]).includes(from)) throw new Error(`--from must be one of ${DRIVERS.join(', ')}`);
  if (!(DRIVERS as readonly string[]).includes(to)) throw new Error(`--to must be one of ${DRIVERS.join(', ')}`);
  if (from === to) throw new Error('--from and --to must differ');
}

function printHealth(h: HealthView | null): void {
  if (!h) return;
  process.stdout.write(`Check:     ${h.status}${h.blocking ? ' (BLOCKING — mail services wait)' : ''}`
    + `${h.sampled !== undefined ? `, ${h.missing ?? 0}/${h.sampled} sampled objects missing` : ''}\n`);
  if (h.lifecycle !== undefined) process.stdout.write(`Expiry:    ${h.lifecycle ? 'bucket lifecycle rules' : 'periodic cleaner'}\n`);
  if (h.missingKeys?.length) process.stdout.write(`Missing:   ${h.missingKeys.join(', ')}\n`);
  if (h.error) process.stdout.write(`Error:     ${h.error}\n`);
  if (h.hint) process.stdout.write(`Hint:      ${h.hint}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function registerStorage(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const storage = program.command('storage').description('Object storage: status, startup check, migration between minio / s3 / filesystem');

  storage.command('status', { isDefault: true }).description('Driver, location, startup-check result, last migration')
    .action(async () => {
      const s = await api().get<StatusView>('/api/v1/admin/storage');
      if (json()) { printJson(s); return; }
      process.stdout.write(`Driver:    ${s.driver ?? '(invalid configuration)'}\nLocation:  ${s.location ?? '—'}\n`);
      if (s.error) process.stdout.write(`Error:     ${s.error}\n`);
      printHealth(s.health);
      if (s.migration) process.stdout.write(`Migration: ${s.migration.from} → ${s.migration.to}${s.migration.running ? ' (running)' : ''} — ${formatProgress(s.migration.progress)}\n`);
    });

  storage.command('check').description('Run the storage startup check now')
    .action(async () => {
      const s = await api().post<{ driver: string; location: string; health: HealthView }>('/api/v1/admin/storage/check');
      if (json()) { printJson(s); return; }
      process.stdout.write(`Driver:    ${s.driver}\nLocation:  ${s.location}\n`);
      printHealth(s.health);
      if (s.health.blocking) process.exitCode = 1;
    });

  storage.command('migrate')
    .description('Copy all objects from one driver to another (streams, verifies sha256/size, resumable, never deletes the source)')
    .requiredOption('--from <driver>', 'source: minio | s3 | filesystem')
    .requiredOption('--to <driver>', 'target: minio | s3 | filesystem')
    .option('--dry-run', 'only count what would be copied')
    .option('--verify-existing', 're-hash objects that already exist in the target instead of comparing sizes')
    .option('--no-wait', 'start the job and return (poll with `coremail storage migrate-status`)')
    .option('--interval <seconds>', 'poll interval', '2')
    .action(async (o: { from: string; to: string; dryRun?: boolean; verifyExisting?: boolean; wait: boolean; interval: string }) => {
      validateDrivers(o.from, o.to);
      const started = await api().post<{ job: MigrationJobView }>('/api/v1/admin/storage/migrate', {
        from: o.from, to: o.to, dryRun: !!o.dryRun, verifyExisting: !!o.verifyExisting,
      });
      let job = started.job;
      if (!json()) process.stderr.write(`Migration ${job.id}: ${job.fromLocation} → ${job.toLocation}${job.dryRun ? ' (dry run)' : ''}\n`);
      if (!o.wait) { if (json()) printJson(job); return; }
      const interval = Math.max(0.5, Number(o.interval) || 2) * 1000;
      let lastLine = '';
      while (job.running) {
        await sleep(interval);
        const r = await api().get<{ job: MigrationJobView | null }>('/api/v1/admin/storage/migrate');
        if (!r.job || r.job.id !== job.id) throw new Error('migration job disappeared (api-gateway restarted?) — run the command again to resume');
        job = r.job;
        const line = formatProgress(job.progress);
        if (!json() && line !== lastLine) { process.stderr.write(line + '\n'); lastLine = line; }
      }
      if (json()) { printJson(job); } else {
        process.stdout.write(formatProgress(job.progress) + '\n');
        for (const e of job.progress.errors) process.stdout.write(`  ✗ ${e.key}: ${e.error}\n`);
        if (job.progress.error) process.stdout.write(`${job.progress.error}\n`);
        if (job.progress.phase === 'done' && !job.dryRun) {
          process.stdout.write(`\nAll objects are in ${job.toLocation}. Next: set OBJECT_STORAGE=${job.to} in .env and run\n`
            + `  docker compose up -d coremail\nThen run this command once more to copy objects written in between (see docs/storage.md).\n`);
        }
      }
      if (job.progress.phase !== 'done') process.exitCode = 1;
    });

  storage.command('migrate-status').description('Progress of the running / last migration')
    .action(async () => {
      const r = await api().get<{ job: MigrationJobView | null }>('/api/v1/admin/storage/migrate');
      if (json()) { printJson(r.job); return; }
      if (!r.job) { process.stdout.write('No migration has run yet\n'); return; }
      process.stdout.write(`${r.job.from} → ${r.job.to}${r.job.running ? ' (running)' : ''}: ${formatProgress(r.job.progress)}\n`);
      for (const e of r.job.progress.errors) process.stdout.write(`  ✗ ${e.key}: ${e.error}\n`);
      if (r.job.progress.error) process.stdout.write(`${r.job.progress.error}\n`);
    });

  storage.command('migrate-cancel').description('Stop the running migration (copied objects stay; start again to resume)')
    .action(async () => {
      await api().post('/api/v1/admin/storage/migrate/cancel');
      process.stdout.write('Migration cancelled\n');
    });
}
