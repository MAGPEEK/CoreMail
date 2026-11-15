/**
 * Object storage migration job (v7.1) — runs in the api-gateway in the
 * background, polled by `coremail storage migrate` / the admin API.
 *
 * One job at a time per installation (Redis lock `storage:migrate:lock`,
 * refreshed while running). The last progress report is kept in Redis
 * (`storage:migrate:last`, 7 days) so the status survives a gateway restart;
 * an interrupted job is resumed by starting it again (copied objects are skipped).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createLogger, getRedisClient } from '@coremail/core';
import {
  migrateObjects, objectStoreFor, isOnContainerRootFs, parseBool, OBJECT_STORAGE_DRIVERS,
  type MigrationProgress, type ObjectStore, type ObjectStorageDriver,
} from '@coremail/storage';

const log = createLogger('storage-migration');

export const MIGRATE_LOCK_KEY = 'storage:migrate:lock';
export const MIGRATE_LAST_KEY = 'storage:migrate:last';
const LOCK_TTL_MS = 120_000;

export interface MigrationJob {
  id: string;
  from: ObjectStorageDriver;
  to: ObjectStorageDriver;
  fromLocation: string;
  toLocation: string;
  dryRun: boolean;
  verifyExisting: boolean;
  startedBy: string;
  running: boolean;
  progress: MigrationProgress;
}

export interface MigrationRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

export interface MigrationDeps {
  redis?: MigrationRedis;
  storeFor?: (driver: ObjectStorageDriver) => ObjectStore;
  /** True when the filesystem root would be inside the container layer. */
  isEphemeral?: (root: string) => Promise<boolean>;
}

let current: { job: MigrationJob; abort: AbortController; lockToken: string } | null = null;

function redisOf(deps: MigrationDeps): MigrationRedis {
  return deps.redis ?? (getRedisClient() as unknown as MigrationRedis);
}

async function defaultIsEphemeral(root: string): Promise<boolean> {
  try {
    if (parseBool('STORAGE_ALLOW_EPHEMERAL', process.env['STORAGE_ALLOW_EPHEMERAL'])) return false;
  } catch { /* invalid → not allowed */ }
  try { return isOnContainerRootFs(root, await readFile('/proc/self/mountinfo', 'utf8')); } catch { return false; }
}

export function isDriver(v: unknown): v is ObjectStorageDriver {
  return typeof v === 'string' && (OBJECT_STORAGE_DRIVERS as readonly string[]).includes(v);
}

export type StartResult =
  | { started: true; job: MigrationJob }
  | { started: false; reason: 'running' | 'same-store' | 'ephemeral-target' | 'config'; message: string; job?: MigrationJob };

export async function startMigration(
  input: { from: ObjectStorageDriver; to: ObjectStorageDriver; dryRun?: boolean; verifyExisting?: boolean; actor: string },
  deps: MigrationDeps = {},
): Promise<StartResult> {
  if (current?.job.running) return { started: false, reason: 'running', message: 'a migration is already running', job: current.job };
  let source: ObjectStore;
  let target: ObjectStore;
  try {
    const storeFor = deps.storeFor ?? ((d: ObjectStorageDriver) => objectStoreFor(d));
    source = storeFor(input.from);
    target = storeFor(input.to);
  } catch (err) {
    return { started: false, reason: 'config', message: (err as Error).message };
  }
  if (source.location === target.location) {
    return { started: false, reason: 'same-store', message: `source and target are the same store (${source.location}) — ${input.from} and ${input.to} use the same MINIO_* settings` };
  }
  if (target.driver === 'filesystem' && !input.dryRun && (await (deps.isEphemeral ?? defaultIsEphemeral)(target.location))) {
    return { started: false, reason: 'ephemeral-target', message: `STORAGE_PATH ${target.location} is not on a mounted volume — mount one (coremail-data:/data) before migrating` };
  }

  const redis = redisOf(deps);
  const lockToken = randomUUID();
  const got = await redis.set(MIGRATE_LOCK_KEY, lockToken, 'PX', LOCK_TTL_MS, 'NX');
  if (got !== 'OK') return { started: false, reason: 'running', message: 'a migration is already running on another instance' };

  const job: MigrationJob = {
    id: randomUUID(),
    from: input.from, to: input.to,
    fromLocation: source.location, toLocation: target.location,
    dryRun: !!input.dryRun, verifyExisting: !!input.verifyExisting,
    startedBy: input.actor, running: true,
    progress: {
      phase: 'listing', dryRun: !!input.dryRun, from: input.from, to: input.to,
      scanned: 0, copied: 0, skipped: 0, verified: 0, failed: 0, bytesScanned: 0, bytesCopied: 0,
      errors: [], startedAt: new Date().toISOString(),
    },
  };
  const abort = new AbortController();
  current = { job, abort, lockToken };

  let lastSave = 0;
  const save = (force = false): void => {
    if (!force && Date.now() - lastSave < 2000) return;
    lastSave = Date.now();
    void redis.set(MIGRATE_LAST_KEY, JSON.stringify(job), 'EX', 7 * 24 * 3600).catch(() => undefined);
  };
  const refresh = setInterval(() => { void redis.pexpire(MIGRATE_LOCK_KEY, LOCK_TTL_MS).catch(() => undefined); }, LOCK_TTL_MS / 3);
  refresh.unref?.();

  log.info({ jobId: job.id, from: job.fromLocation, to: job.toLocation, dryRun: job.dryRun, actor: input.actor }, 'Object storage migration started');
  void migrateObjects({
    source, target, dryRun: job.dryRun, verifyExisting: job.verifyExisting, signal: abort.signal,
    onProgress: (p) => { job.progress = p; save(); },
  })
    .then((p) => { job.progress = p; })
    .catch((err: unknown) => {
      job.progress = { ...job.progress, phase: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() };
    })
    .finally(async () => {
      job.running = false;
      clearInterval(refresh);
      save(true);
      const p = job.progress;
      log[p.phase === 'done' ? 'info' : 'error']({ jobId: job.id, phase: p.phase, scanned: p.scanned, copied: p.copied, skipped: p.skipped, failed: p.failed, bytes: p.bytesCopied, error: p.error }, 'Object storage migration finished');
      if ((await redis.get(MIGRATE_LOCK_KEY).catch(() => null)) === lockToken) await redis.del(MIGRATE_LOCK_KEY).catch(() => undefined);
    });
  save(true);
  return { started: true, job };
}

/** Current (or last) job: in-memory first, else the last report from Redis. */
export async function getMigrationJob(deps: MigrationDeps = {}): Promise<MigrationJob | null> {
  if (current) return current.job;
  try {
    const raw = await redisOf(deps).get(MIGRATE_LAST_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw) as MigrationJob;
    // A job that was running when the gateway stopped is not running any more.
    if (job.running) job.running = false;
    if (job.progress.phase === 'copying' || job.progress.phase === 'listing') {
      job.progress = { ...job.progress, phase: 'cancelled', error: 'interrupted (api-gateway restarted) — start the migration again to resume' };
    }
    return job;
  } catch {
    return null;
  }
}

export function cancelMigration(): boolean {
  if (!current?.job.running) return false;
  current.abort.abort();
  return true;
}

/** Tests only. */
export function resetMigrationForTests(): void {
  current = null;
}
