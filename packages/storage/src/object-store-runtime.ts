/**
 * Runtime wiring of the object-storage startup check (Prisma + env + logs).
 *
 *   waitForObjectStorage(service)  mail services (SMTP/IMAP/POP3/JMAP/ActiveSync)
 *                                  await this before opening listeners: while the
 *                                  check is blocking they log an ERROR with the
 *                                  migration command and re-check every minute
 *                                  (no crash loop, no mails served without content).
 *   getStorageHealth()             cached result for /healthz and the admin API.
 */
import { readFile } from 'node:fs/promises';
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { getObjectStore } from './object-store/index.js';
import { checkObjectStorage, isOnContainerRootFs, type StorageCheckResult } from './object-store/health.js';
import { parseBool } from './object-store/config.js';
import type { ObjectStore } from './object-store/types.js';

const log = createLogger('object-store');

interface RefDb {
  message: { findMany(args: unknown): Promise<Array<{ storagePath: string | null }>> };
  attachment: { findMany(args: unknown): Promise<Array<{ storagePath: string }>> };
}

/**
 * Most recent object keys referenced by the database. Ordered by id (cuid —
 * time-ordered, primary-key index) so the query stays cheap on large tables.
 */
export async function sampleStorageReferences(db: RefDb = prisma as unknown as RefDb, n = 5): Promise<string[]> {
  const [msgs, atts] = await Promise.all([
    db.message.findMany({ where: { storagePath: { not: null } }, orderBy: { id: 'desc' }, take: n, select: { storagePath: true } }),
    db.attachment.findMany({ where: { storagePath: { not: '' } }, orderBy: { id: 'desc' }, take: n, select: { storagePath: true } }),
  ]);
  return [...msgs.map((m) => m.storagePath), ...atts.map((a) => a.storagePath)].filter((k): k is string => !!k);
}

async function isEphemeral(root: string): Promise<boolean> {
  let info: string;
  try { info = await readFile('/proc/self/mountinfo', 'utf8'); } catch { return false; }
  return isOnContainerRootFs(root, info);
}

export async function runStorageCheck(store: ObjectStore = getObjectStore()): Promise<StorageCheckResult> {
  let disabled = false;
  let allowEphemeral = false;
  try {
    disabled = (process.env['STORAGE_STARTUP_CHECK'] ?? '').trim().toLowerCase() === 'off';
    allowEphemeral = parseBool('STORAGE_ALLOW_EPHEMERAL', process.env['STORAGE_ALLOW_EPHEMERAL']) ?? false;
  } catch (err) {
    log.warn({ err }, 'Invalid STORAGE_ALLOW_EPHEMERAL — treated as false');
  }
  return checkObjectStorage({ store, references: () => sampleStorageReferences(), isEphemeral, allowEphemeral, disabled });
}

let cached: { at: number; result: StorageCheckResult } | null = null;
let running: Promise<StorageCheckResult> | null = null;

/** Check result for health endpoints; re-checked when older than `maxAgeMs`. */
export async function getStorageHealth(maxAgeMs = 5 * 60_000, force = false): Promise<StorageCheckResult> {
  // A blocking result is re-checked every 30 s so health turns green soon after a migration.
  const maxAge = cached?.result.blocking ? Math.min(maxAgeMs, 30_000) : maxAgeMs;
  if (!force && cached && Date.now() - cached.at < maxAge) return cached.result;
  running ??= runStorageCheck()
    .then((result) => { cached = { at: Date.now(), result }; return result; })
    .finally(() => { running = null; });
  return running;
}

/** Last cached result without triggering a check (null before the first one). */
export function peekStorageHealth(): StorageCheckResult | null {
  return cached?.result ?? null;
}

function logResult(service: string, r: StorageCheckResult): void {
  const ctx = { service, driver: r.driver, location: r.location, status: r.status, sampled: r.sampled, missing: r.missing, missingKeys: r.missingKeys };
  if (r.blocking) log.error({ ...ctx, error: r.error }, `Object storage check FAILED — ${service} does not start. ${r.error ?? ''} ${r.hint ?? ''}`.trim());
  else if (r.status === 'degraded') log.warn(ctx, `Object storage degraded: ${r.missing}/${r.sampled} sampled objects missing. ${r.hint ?? ''}`);
  else log.info(ctx, 'Object storage ready');
}

/**
 * Blocks until the object storage check passes (re-checks every `retryMs`).
 * Never throws; the service starts as soon as the objects are present.
 */
export async function waitForObjectStorage(service: string, opts: { retryMs?: number } = {}): Promise<StorageCheckResult> {
  const maxDelay = opts.retryMs ?? 60_000;
  // Backoff 5 s → 60 s: a backend that is still starting (MinIO) delays the
  // service only briefly; a misconfiguration is re-checked once a minute.
  const delay = (attempt: number): Promise<void> =>
    new Promise((res) => setTimeout(res, Math.min(maxDelay, 5000 * 2 ** attempt)));
  for (let attempt = 0; ; attempt++) {
    let r: StorageCheckResult;
    try {
      r = await runStorageCheck();
    } catch (err) {
      log.error({ err, service }, 'Object storage check crashed — retrying');
      await delay(attempt);
      continue;
    }
    cached = { at: Date.now(), result: r };
    logResult(service, r);
    if (!r.blocking) return r;
    await delay(attempt);
  }
}
