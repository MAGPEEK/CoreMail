/**
 * Periodic expiry of temporary objects — the filesystem equivalent of the S3
 * lifecycle rules (outbound-queue 7 d, quarantine 90 d, jmap-upload 7 d,
 * backups 365 d). Also used for S3 providers that refuse lifecycle rules.
 *
 * One run per interval across all processes/instances: Redis lock
 * `storage:cleaner:lock` (SET NX PX). For the filesystem driver a run also
 * removes `.tmp-*` leftovers of crashed writes and prunes empty directories of
 * the expiring prefixes.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core/logger';
import { EXPIRY_RULES } from './s3.js';
import { FilesystemObjectStore } from './filesystem.js';
import type { ObjectStore } from './types.js';

const log = createLogger('object-store:cleaner');

const DAY_MS = 24 * 60 * 60 * 1000;
export const CLEANER_LOCK_KEY = 'storage:cleaner:lock';
export const CLEANER_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Temp files of crashed writes older than this are removed. */
export const TEMP_FILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ExpiryRule { prefix: string; days: number }

export const DEFAULT_EXPIRY_RULES: readonly ExpiryRule[] = EXPIRY_RULES.map(({ prefix, days }) => ({ prefix, days }));

export interface CleanupResult {
  scanned: number;
  deleted: number;
  perPrefix: Record<string, number>;
  tempFiles: number;
  dirs: number;
}

/** Deletes objects under each rule's prefix whose lastModified is older than `days`. */
export async function runExpiryCleanup(
  store: ObjectStore,
  rules: readonly ExpiryRule[] = DEFAULT_EXPIRY_RULES,
  now = Date.now(),
): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: 0, deleted: 0, perPrefix: {}, tempFiles: 0, dirs: 0 };
  for (const rule of rules) {
    const cutoff = now - rule.days * DAY_MS;
    let n = 0;
    for await (const obj of store.list(rule.prefix)) {
      result.scanned++;
      if (obj.lastModified.getTime() < cutoff) {
        await store.delete(obj.key);
        n++;
      }
    }
    result.perPrefix[rule.prefix] = n;
    result.deleted += n;
  }
  if (store instanceof FilesystemObjectStore) {
    const left = await store.cleanupLeftovers(TEMP_FILE_MAX_AGE_MS, now, rules.map((r) => r.prefix));
    result.tempFiles = left.tempFiles;
    result.dirs = left.dirs;
  }
  return result;
}

/** Minimal Redis surface (ioredis-compatible) — injectable for tests. */
export interface CleanerRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

/** One locked run: null when another process holds the lock for this interval. */
export async function runLockedCleanup(
  store: ObjectStore,
  redis: CleanerRedis,
  opts: { rules?: readonly ExpiryRule[]; lockTtlMs?: number; now?: number } = {},
): Promise<CleanupResult | null> {
  const got = await redis.set(CLEANER_LOCK_KEY, randomUUID(), 'PX', opts.lockTtlMs ?? CLEANER_INTERVAL_MS - 5 * 60_000, 'NX');
  if (got !== 'OK') return null;
  return runExpiryCleanup(store, opts.rules, opts.now);
}

export interface MaintenanceHandle { stop(): void }

/**
 * Starts the periodic cleaner when the store needs it (filesystem, or S3
 * without lifecycle support). First run after `initialDelayMs`.
 */
export function startObjectStorageCleaner(
  store: ObjectStore,
  redis: CleanerRedis,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): MaintenanceHandle {
  const interval = opts.intervalMs ?? CLEANER_INTERVAL_MS;
  const tick = async (): Promise<void> => {
    try {
      const r = await runLockedCleanup(store, redis, { lockTtlMs: Math.max(60_000, interval - 5 * 60_000) });
      if (r && (r.deleted || r.tempFiles)) log.info({ driver: store.driver, ...r }, 'Expired temporary objects removed');
    } catch (err) {
      log.warn({ err }, 'Object storage cleaner run failed');
    }
  };
  const first = setTimeout(() => void tick(), opts.initialDelayMs ?? 60_000);
  const timer = setInterval(() => void tick(), interval);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
