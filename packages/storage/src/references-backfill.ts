/**
 * Backfill of `Message.references` (v9.1) for rows written before the column
 * existed (or whose writer did not pass it and missed the storagePath cache):
 * `references = null` means "not indexed yet".
 *
 * Two triggers, both best-effort and never on the mail delivery path:
 *  - lazy: IMAP THREAD=REFERENCES calls {@link loadThreadReferences} for the
 *    selected folder, which indexes up to {@link REFERENCES_BACKFILL_COMMAND_LIMIT}
 *    rows of that folder per command before threading;
 *  - background: {@link startReferencesBackfill} (REFERENCES_BACKFILL=on|off,
 *    default on) works off the whole table in batches, one instance at a time
 *    (Redis lock `storage:references-backfill:lock`), with pauses between batches
 *    and a long idle interval once nothing is left.
 *
 * Only the header section of the stored raw object is read (streamed, stops at
 * the blank line). Rows without a raw object (legacy rows; the reconstruction
 * carries no References) and rows whose object is missing get '' (= none);
 * other read errors leave the row null so a later run retries it.
 *
 * Writing the column does not bump the modSeq: References are derived from the
 * immutable raw message and are not a client-visible change (same rule as the
 * lazy raw-object migration in raw-message-default.ts).
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { getObjectStore } from './object-store/index.js';
import { isNotFound } from './object-store/types.js';
import { extractReferences, formatReferencesColumn, splitReferences, MAX_REFERENCES_HEADER_SCAN } from './references.js';

const log = createLogger('storage:references-backfill');

/** Rows indexed per IMAP THREAD=REFERENCES command (lazy backfill). */
export const REFERENCES_BACKFILL_COMMAND_LIMIT = 2000;
/** Rows per background batch. */
export const REFERENCES_BACKFILL_BATCH = 500;
/** Batches per background run (then the lock interval ends). */
export const REFERENCES_BACKFILL_MAX_BATCHES = 20;
/** Delay between background runs while rows are left / once the table is done. */
export const REFERENCES_BACKFILL_BUSY_INTERVAL_MS = 60_000;
export const REFERENCES_BACKFILL_IDLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Pause between two batches of one run (low priority). */
export const REFERENCES_BACKFILL_PAUSE_MS = 250;
export const REFERENCES_BACKFILL_LOCK_KEY = 'storage:references-backfill:lock';
/** Parallel header reads. */
const READ_CONCURRENCY = 8;

/** REFERENCES_BACKFILL: `on` (default) | `off`. */
export function referencesBackfillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env['REFERENCES_BACKFILL'] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no' || v === 'disabled');
}

/** Reads a stream until the end of the header section (or `limit` bytes) and closes it. */
export async function readHeaderSection(stream: Readable, limit = MAX_REFERENCES_HEADER_SCAN): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      chunks.push(buf);
      size += buf.length;
      if (size >= limit) break;
      // The blank line may straddle chunks: search the joined tail.
      const joined = chunks.length === 1 ? buf : Buffer.concat(chunks);
      if (joined.includes('\r\n\r\n') || joined.includes('\n\n')) break;
    }
  } finally {
    stream.destroy();
  }
  const all = Buffer.concat(chunks);
  return all.length > limit ? all.subarray(0, limit) : all;
}

/** Minimal message delegate the backfill needs (Prisma client, transaction client or a fake). */
export interface BackfillDb {
  message: {
    findMany(args: unknown): Promise<unknown[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface BackfillDeps {
  db?: BackfillDb;
  /** Header section (or the whole object) of a raw message. */
  readHeader?(storagePath: string): Promise<Buffer>;
}

export interface BackfillScope {
  folderId?: string;
  mailboxId?: string;
}

export interface BackfillResult {
  /** Rows looked at. */
  scanned: number;
  /** Rows whose column was written ('' included). */
  filled: number;
  /** Rows left null because the raw object could not be read (retried later). */
  failed: number;
}

const defaultReadHeader = async (storagePath: string): Promise<Buffer> =>
  readHeaderSection(await getObjectStore().getStream(storagePath));

/**
 * Indexes up to `limit` rows with `references = null` (newest first) in the scope.
 * Never throws for a single unreadable object.
 */
export async function backfillReferences(
  scope: BackfillScope = {},
  opts: { limit?: number; deps?: BackfillDeps } = {},
): Promise<BackfillResult> {
  const db = opts.deps?.db ?? (prisma as unknown as BackfillDb);
  const readHeader = opts.deps?.readHeader ?? defaultReadHeader;
  const limit = Math.max(1, opts.limit ?? REFERENCES_BACKFILL_BATCH);
  const rows = await db.message.findMany({
    where: {
      references: null,
      ...(scope.folderId ? { folderId: scope.folderId } : {}),
      ...(scope.mailboxId ? { folder: { mailboxId: scope.mailboxId } } : {}),
    },
    select: { id: true, storagePath: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit,
  }) as Array<{ id: string; storagePath: string | null }>;
  const result: BackfillResult = { scanned: rows.length, filled: 0, failed: 0 };
  if (rows.length === 0) return result;

  const values = new Map<string, string>(); // id → column value
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const row = rows[next++]!;
      if (!row.storagePath) { values.set(row.id, ''); continue; }
      try {
        values.set(row.id, formatReferencesColumn(extractReferences(await readHeader(row.storagePath))));
      } catch (err) {
        if (isNotFound(err)) { values.set(row.id, ''); continue; }
        result.failed++;
        log.debug({ err, messageId: row.id }, 'references backfill: raw message unreadable');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, rows.length) }, () => worker()));

  // One statement for all rows without references, one per row otherwise; only
  // rows that are still null (a concurrent writer/backfill may have filled them).
  const empty = [...values].filter(([, v]) => v === '').map(([id]) => id);
  if (empty.length) {
    result.filled += (await db.message.updateMany({ where: { id: { in: empty }, references: null }, data: { references: '' } })).count;
  }
  for (const [id, value] of values) {
    if (value === '') continue;
    result.filled += (await db.message.updateMany({ where: { id, references: null }, data: { references: value } })).count;
  }
  return result;
}

/**
 * Reference lists of the messages of a folder for IMAP THREAD=REFERENCES: first
 * indexes up to `limit` unindexed rows of the folder (lazy backfill, errors are
 * logged and ignored), then loads the column in one query. Messages that are
 * still unindexed map to [] (the caller falls back to In-Reply-To).
 */
export async function loadThreadReferences(
  folderId: string,
  ids: readonly string[],
  opts: { limit?: number; deps?: BackfillDeps } = {},
): Promise<Map<string, string[]>> {
  const db = opts.deps?.db ?? (prisma as unknown as BackfillDb);
  try {
    await backfillReferences({ folderId }, { limit: opts.limit ?? REFERENCES_BACKFILL_COMMAND_LIMIT, ...(opts.deps ? { deps: opts.deps } : {}) });
  } catch (err) {
    log.warn({ err, folderId }, 'references backfill failed — threading uses In-Reply-To for unindexed messages');
  }
  const wanted = new Set(ids);
  const rows = await db.message.findMany({
    where: { folderId, deletedAt: null, references: { not: null } },
    select: { id: true, references: true },
  }) as Array<{ id: string; references: string | null }>;
  const out = new Map<string, string[]>();
  for (const r of rows) if (wanted.has(r.id)) out.set(r.id, splitReferences(r.references));
  return out;
}

// ─── Background job ──────────────────────────────────────────────────────────

/** Minimal Redis surface (ioredis-compatible). */
export interface BackfillRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

export interface BackfillRunResult extends BackfillResult {
  batches: number;
  /** True when rows may be left (the last batch was full or had failures). */
  more: boolean;
}

/**
 * One locked background run: up to `maxBatches` batches with pauses. Null when
 * another process holds the lock.
 */
export async function runLockedReferencesBackfill(
  redis: BackfillRedis,
  opts: { lockTtlMs?: number; batchSize?: number; maxBatches?: number; pauseMs?: number; deps?: BackfillDeps } = {},
): Promise<BackfillRunResult | null> {
  const got = await redis.set(REFERENCES_BACKFILL_LOCK_KEY, randomUUID(), 'PX', opts.lockTtlMs ?? REFERENCES_BACKFILL_BUSY_INTERVAL_MS - 10_000, 'NX');
  if (got !== 'OK') return null;
  const batchSize = opts.batchSize ?? REFERENCES_BACKFILL_BATCH;
  const maxBatches = opts.maxBatches ?? REFERENCES_BACKFILL_MAX_BATCHES;
  const pauseMs = opts.pauseMs ?? REFERENCES_BACKFILL_PAUSE_MS;
  const total: BackfillRunResult = { scanned: 0, filled: 0, failed: 0, batches: 0, more: false };
  for (let i = 0; i < maxBatches; i++) {
    const r = await backfillReferences({}, { limit: batchSize, ...(opts.deps ? { deps: opts.deps } : {}) });
    total.batches++;
    total.scanned += r.scanned;
    total.filled += r.filled;
    total.failed += r.failed;
    total.more = r.scanned === batchSize;
    // Stop when the table is done, or when a batch made no progress (only unreadable rows left).
    if (!total.more || r.filled === 0) break;
    if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
  }
  return total;
}

/**
 * Starts the background backfill (no-op handle when REFERENCES_BACKFILL=off).
 * Runs every minute while rows are left, every 6 hours once the table is done.
 */
export function startReferencesBackfill(
  redis: BackfillRedis,
  opts: { initialDelayMs?: number; busyIntervalMs?: number; idleIntervalMs?: number; env?: Record<string, string | undefined> } = {},
): { stop(): void } {
  if (!referencesBackfillEnabled(opts.env)) {
    log.info('REFERENCES_BACKFILL=off — References of older messages are indexed only by IMAP THREAD');
    return { stop: () => undefined };
  }
  const busy = opts.busyIntervalMs ?? REFERENCES_BACKFILL_BUSY_INTERVAL_MS;
  const idle = opts.idleIntervalMs ?? REFERENCES_BACKFILL_IDLE_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    let delay = busy;
    try {
      const r = await runLockedReferencesBackfill(redis, { lockTtlMs: Math.max(10_000, busy - 10_000) });
      if (r) {
        if (r.filled) log.info({ filled: r.filled, failed: r.failed, more: r.more }, 'References backfilled');
        if (!r.more) delay = idle;
      }
    } catch (err) {
      log.warn({ err }, 'References backfill run failed');
    }
    schedule(delay);
  };
  schedule(opts.initialDelayMs ?? 2 * 60_000);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
