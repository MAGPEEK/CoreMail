/**
 * Backfill of `Message.references` (v9.1) for rows written before the column
 * existed (or whose writer did not pass it and missed the storagePath cache):
 * `references = null` means "not indexed yet".
 *
 * Two triggers, both best-effort and never on the mail delivery path:
 *  - lazy: IMAP THREAD=REFERENCES calls {@link loadThreadReferences} for the
 *    selected folder, which indexes at most {@link REFERENCES_BACKFILL_COMMAND_LIMIT}
 *    rows of that folder per command and stops after REFERENCES_LAZY_BUDGET_MS
 *    (default 1500 ms) — the rest is left to the background job, so a slow object
 *    store never blocks an IMAP session for long. Rows that failed recently in this
 *    process are skipped;
 *  - background: {@link startReferencesBackfill} (REFERENCES_BACKFILL=on|off,
 *    default on) works off the whole table in batches, one instance at a time
 *    (Redis lock `storage:references-backfill:lock`, refreshed with a token check
 *    between batches and released with compare-and-delete), with pauses between
 *    batches and a long idle interval once a pass over the table is complete.
 *
 * Only the header section of the stored raw object is read (streamed, stops at
 * the blank line). Rows without a raw object (legacy rows; the reconstruction
 * carries no References) and rows whose object is missing get '' (= none).
 *
 * Other read errors (object store unreachable, permissions, …) leave the row
 * null — the column is never written as '' for them, because '' is final and
 * would permanently drop the References of a message after a transient outage.
 * Instead (9.1 starvation fix):
 *  - the background job walks the table with a cursor (createdAt desc, id asc),
 *    so rows that keep failing never block older rows; a pass restarts from the
 *    newest row only after it reached the end (idle interval in between);
 *  - failures are counted per message id (Redis keys
 *    `storage:references-backfill:fail:<id>`, TTL {@link REFERENCES_BACKFILL_FAILURE_TTL_MS}
 *    from the first failure; an in-process map when Redis lacks the commands).
 *    A row with {@link REFERENCES_BACKFILL_MAX_ATTEMPTS} failures is not read again
 *    until its counter expires, so the same objects are not re-read every minute.
 * Rows that stay unindexed simply thread by In-Reply-To.
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
export const REFERENCES_BACKFILL_COMMAND_LIMIT = 200;
/** Default time budget of the lazy backfill per command (REFERENCES_LAZY_BUDGET_MS). */
export const REFERENCES_LAZY_BUDGET_MS = 1500;
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
/** Read failures after which a row is skipped until its failure counter expires. */
export const REFERENCES_BACKFILL_MAX_ATTEMPTS = 3;
/** Lifetime of a failure counter (from the first failure). */
export const REFERENCES_BACKFILL_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
export const REFERENCES_BACKFILL_FAILURE_KEY_PREFIX = 'storage:references-backfill:fail:';
/** Parallel header reads. */
const READ_CONCURRENCY = 8;
/** Ids per `id IN (…)` query. */
const ID_CHUNK = 1000;
/** Recently failed ids excluded from the lazy query. */
const LAZY_EXCLUDE_MAX = 1000;

/** REFERENCES_BACKFILL: `on` (default) | `off`. */
export function referencesBackfillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env['REFERENCES_BACKFILL'] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no' || v === 'disabled');
}

/** REFERENCES_LAZY_BUDGET_MS (default 1500; 0 disables the lazy step; capped at 30 s). */
export function referencesLazyBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env['REFERENCES_LAZY_BUDGET_MS'] ?? '').trim();
  if (!/^\d+$/.test(raw)) return REFERENCES_LAZY_BUDGET_MS;
  return Math.min(parseInt(raw, 10), 30_000);
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

// ─── Failure tracking ────────────────────────────────────────────────────────

/** Per-message read-failure counters. Implementations never throw to the caller's harm (errors are caught). */
export interface BackfillFailureTracker {
  /** Current failure counts of `ids` (absent = 0). */
  counts(ids: readonly string[]): Promise<Map<string, number>>;
  /** Adds one failure to each id. */
  record(ids: readonly string[]): Promise<void>;
  /** Most recently failed ids (newest first), at most `max` — optional. */
  recent?(max: number): Promise<string[]>;
}

/** In-process tracker (bounded map, TTL from the first failure). */
export function createMemoryFailureTracker(
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): BackfillFailureTracker {
  const ttl = opts.ttlMs ?? REFERENCES_BACKFILL_FAILURE_TTL_MS;
  const maxEntries = opts.maxEntries ?? 20_000;
  const now = opts.now ?? Date.now;
  const map = new Map<string, { count: number; expires: number }>();
  const live = (id: string): { count: number; expires: number } | undefined => {
    const e = map.get(id);
    if (!e) return undefined;
    if (e.expires <= now()) { map.delete(id); return undefined; }
    return e;
  };
  return {
    async counts(ids) {
      const out = new Map<string, number>();
      for (const id of ids) { const e = live(id); if (e) out.set(id, e.count); }
      return out;
    },
    async record(ids) {
      for (const id of ids) {
        const e = live(id);
        map.delete(id); // re-insert: most recent failure last
        map.set(id, e ? { count: e.count + 1, expires: e.expires } : { count: 1, expires: now() + ttl });
        while (map.size > maxEntries) map.delete(map.keys().next().value as string);
      }
    },
    async recent(max) {
      const out: string[] = [];
      for (const id of [...map.keys()].reverse()) {
        if (out.length >= max) break;
        if (live(id)) out.push(id);
      }
      return out;
    },
  };
}

/** Redis commands the shared tracker needs (ioredis-compatible). */
export interface BackfillFailureRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

/** Tracker shared by all processes: one counter key per failing message (TTL from the first failure). */
export function createRedisFailureTracker(redis: BackfillFailureRedis, opts: { ttlMs?: number } = {}): BackfillFailureTracker {
  const ttl = opts.ttlMs ?? REFERENCES_BACKFILL_FAILURE_TTL_MS;
  const key = (id: string): string => `${REFERENCES_BACKFILL_FAILURE_KEY_PREFIX}${id}`;
  return {
    async counts(ids) {
      const out = new Map<string, number>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        if (!chunk.length) continue;
        const vals = await redis.mget(...chunk.map(key));
        chunk.forEach((id, j) => { const n = Number(vals[j] ?? 0); if (n > 0) out.set(id, n); });
      }
      return out;
    },
    async record(ids) {
      for (const id of ids) {
        const n = await redis.incr(key(id));
        if (n === 1) await redis.pexpire(key(id), ttl);
      }
    },
  };
}

/** Lazy (IMAP) failures of this process. */
const lazyFailures = createMemoryFailureTracker();
/** Background failures when the Redis client lacks INCR/MGET/PEXPIRE. */
const backgroundFailures = createMemoryFailureTracker();

// ─── Core batch ──────────────────────────────────────────────────────────────

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

/** Position in the (createdAt desc, id asc) order: the last row looked at. */
export interface BackfillCursor {
  createdAt: Date;
  id: string;
}

export interface BackfillOptions {
  limit?: number;
  deps?: BackfillDeps;
  /** Continue after this row (background pass). */
  after?: BackfillCursor | null;
  /** Failure counters; rows with `maxAttempts` failures are not read. */
  tracker?: BackfillFailureTracker;
  maxAttempts?: number;
  /** Stop starting new reads after this many ms; unread rows stay null (`deferred`). */
  budgetMs?: number;
  /** Ids left out of the query. */
  excludeIds?: readonly string[];
}

export interface BackfillResult {
  /** Rows looked at. */
  scanned: number;
  /** Rows whose column was written ('' included). */
  filled: number;
  /** Rows left null because the raw object could not be read (retried later). */
  failed: number;
  /** Rows not read because they failed `maxAttempts` times recently. */
  skipped: number;
  /** Rows not read because the time budget ran out. */
  deferred: number;
  /** Last row taken (null when nothing was taken). */
  cursor: BackfillCursor | null;
  /** True when the query reached the end of the (remaining) rows. */
  exhausted: boolean;
}

const defaultReadHeader = async (storagePath: string): Promise<Buffer> =>
  readHeaderSection(await getObjectStore().getStream(storagePath));

/**
 * Indexes up to `limit` rows with `references = null` (newest first) in the scope.
 * Never throws for a single unreadable object.
 */
export async function backfillReferences(scope: BackfillScope = {}, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const db = opts.deps?.db ?? (prisma as unknown as BackfillDb);
  const readHeader = opts.deps?.readHeader ?? defaultReadHeader;
  const limit = Math.max(1, opts.limit ?? REFERENCES_BACKFILL_BATCH);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? REFERENCES_BACKFILL_MAX_ATTEMPTS);
  const and: Array<Record<string, unknown>> = [];
  if (opts.after) {
    and.push({ OR: [
      { createdAt: { lt: opts.after.createdAt } },
      { createdAt: opts.after.createdAt, id: { gt: opts.after.id } },
    ] });
  }
  if (opts.excludeIds?.length) and.push({ NOT: { id: { in: [...opts.excludeIds] } } });
  const rows = await db.message.findMany({
    where: {
      references: null,
      ...(scope.folderId ? { folderId: scope.folderId } : {}),
      ...(scope.mailboxId ? { folder: { mailboxId: scope.mailboxId } } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    select: { id: true, storagePath: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit,
  }) as Array<{ id: string; storagePath: string | null; createdAt: Date }>;
  const result: BackfillResult = { scanned: rows.length, filled: 0, failed: 0, skipped: 0, deferred: 0, cursor: null, exhausted: rows.length < limit };
  if (rows.length === 0) return result;

  let counts = new Map<string, number>();
  if (opts.tracker) {
    try {
      counts = await opts.tracker.counts(rows.filter((r) => r.storagePath).map((r) => r.id));
    } catch (err) {
      log.debug({ err }, 'references backfill: failure counters unavailable');
    }
  }

  const values = new Map<string, string>(); // id → column value
  const failedIds: string[] = [];
  let stopped = false;
  let next = 0;
  const deadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : Infinity;
  const noteFailure = (id: string): void => {
    if (!stopped) { failedIds.push(id); return; }
    // A read that finished after the budget: still count it.
    void opts.tracker?.record([id]).catch(() => undefined);
  };
  const worker = async (): Promise<void> => {
    while (!stopped && next < rows.length && Date.now() < deadline) {
      const row = rows[next++]!;
      if (!row.storagePath) { values.set(row.id, ''); continue; }
      if ((counts.get(row.id) ?? 0) >= maxAttempts) { result.skipped++; continue; }
      try {
        const value = formatReferencesColumn(extractReferences(await readHeader(row.storagePath)));
        if (!stopped) values.set(row.id, value);
      } catch (err) {
        if (isNotFound(err)) { if (!stopped) values.set(row.id, ''); continue; }
        noteFailure(row.id);
        log.debug({ err, messageId: row.id }, 'references backfill: raw message unreadable');
      }
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, rows.length) }, () => worker()));
  if (deadline === Infinity) {
    await all;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((res) => { timer = setTimeout(res, Math.max(0, deadline - Date.now())); timer.unref?.(); });
    await Promise.race([all, budget]);
    if (timer) clearTimeout(timer);
  }
  stopped = true;
  const taken = next;
  result.deferred = rows.length - taken;
  result.failed = failedIds.length;
  result.cursor = taken > 0 ? { createdAt: rows[taken - 1]!.createdAt, id: rows[taken - 1]!.id } : null;
  if (taken < rows.length) result.exhausted = false;
  if (failedIds.length && opts.tracker) {
    try { await opts.tracker.record(failedIds); } catch (err) { log.debug({ err }, 'references backfill: failure counters not written'); }
  }

  // One statement for all rows without references, one per row otherwise; only
  // rows that are still null (a concurrent writer/backfill may have filled them).
  const settled = [...values];
  const empty = settled.filter(([, v]) => v === '').map(([id]) => id);
  if (empty.length) {
    result.filled += (await db.message.updateMany({ where: { id: { in: empty }, references: null }, data: { references: '' } })).count;
  }
  for (const [id, value] of settled) {
    if (value === '') continue;
    result.filled += (await db.message.updateMany({ where: { id, references: null }, data: { references: value } })).count;
  }
  return result;
}

/**
 * Reference lists of the messages `ids` of a folder for IMAP THREAD=REFERENCES:
 * first indexes at most `limit` unindexed rows of the folder within `budgetMs`
 * (lazy backfill; rows that failed recently are skipped; errors are logged and
 * ignored), then loads the column for `ids` (chunks of 1000). Messages that are
 * still unindexed map to [] (the caller falls back to In-Reply-To).
 */
export async function loadThreadReferences(
  folderId: string,
  ids: readonly string[],
  opts: { limit?: number; budgetMs?: number; deps?: BackfillDeps; tracker?: BackfillFailureTracker; env?: Record<string, string | undefined> } = {},
): Promise<Map<string, string[]>> {
  const db = opts.deps?.db ?? (prisma as unknown as BackfillDb);
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const budgetMs = opts.budgetMs ?? referencesLazyBudgetMs(opts.env);
  if (budgetMs > 0) {
    const tracker = opts.tracker ?? lazyFailures;
    try {
      const excludeIds = (await tracker.recent?.(LAZY_EXCLUDE_MAX)) ?? [];
      await backfillReferences({ folderId }, {
        limit: opts.limit ?? REFERENCES_BACKFILL_COMMAND_LIMIT,
        budgetMs,
        tracker,
        maxAttempts: 1,
        excludeIds,
        ...(opts.deps ? { deps: opts.deps } : {}),
      });
    } catch (err) {
      log.warn({ err, folderId }, 'references backfill failed — threading uses In-Reply-To for unindexed messages');
    }
  }
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const rows = await db.message.findMany({
      where: { folderId, deletedAt: null, references: { not: null }, id: { in: unique.slice(i, i + ID_CHUNK) } },
      select: { id: true, references: true },
    }) as Array<{ id: string; references: string | null }>;
    for (const r of rows) out.set(r.id, splitReferences(r.references));
  }
  return out;
}

// ─── Background job ──────────────────────────────────────────────────────────

/** Minimal Redis surface (ioredis-compatible). `eval` and the counter commands are optional. */
export interface BackfillRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  incr?(key: string): Promise<number>;
  pexpire?(key: string, ms: number): Promise<number>;
  mget?(...keys: string[]): Promise<Array<string | null>>;
}

/** Extends the lock only while it still carries our token. */
const REFRESH_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Deletes the lock only while it still carries our token. */
const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface BackfillRunResult {
  scanned: number;
  filled: number;
  failed: number;
  skipped: number;
  batches: number;
  /** True when rows may be left in this pass (the end of the table was not reached). */
  more: boolean;
  /** Where the next run continues (null = the pass is complete, start from the newest row). */
  cursor: BackfillCursor | null;
  /** Why the run ended early: the lock was lost / about to expire. */
  stoppedForLock?: boolean;
}

function trackerFor(redis: BackfillRedis): BackfillFailureTracker {
  if (typeof redis.incr === 'function' && typeof redis.mget === 'function' && typeof redis.pexpire === 'function') {
    return createRedisFailureTracker(redis as BackfillRedis & BackfillFailureRedis);
  }
  return backgroundFailures;
}

/**
 * One locked background run: up to `maxBatches` batches with pauses, continuing
 * after `cursor`. Null when another process holds the lock. The lock is refreshed
 * (token check) between batches — or, without EVAL, the run stops before the TTL
 * runs out — and released with compare-and-delete at the end.
 */
export async function runLockedReferencesBackfill(
  redis: BackfillRedis,
  opts: {
    lockTtlMs?: number; batchSize?: number; maxBatches?: number; pauseMs?: number; deps?: BackfillDeps;
    cursor?: BackfillCursor | null; tracker?: BackfillFailureTracker; maxAttempts?: number;
  } = {},
): Promise<BackfillRunResult | null> {
  const ttl = opts.lockTtlMs ?? REFERENCES_BACKFILL_BUSY_INTERVAL_MS - 10_000;
  const token = randomUUID();
  const got = await redis.set(REFERENCES_BACKFILL_LOCK_KEY, token, 'PX', ttl, 'NX');
  if (got !== 'OK') return null;
  const canEval = typeof redis.eval === 'function';
  let lockExpires = Date.now() + ttl;
  const batchSize = opts.batchSize ?? REFERENCES_BACKFILL_BATCH;
  const maxBatches = opts.maxBatches ?? REFERENCES_BACKFILL_MAX_BATCHES;
  const pauseMs = opts.pauseMs ?? REFERENCES_BACKFILL_PAUSE_MS;
  const tracker = opts.tracker ?? trackerFor(redis);
  // A batch never outlives the lock: half the TTL per batch, the rest is headroom.
  const batchBudget = Math.max(1000, Math.floor(ttl / 2));
  let cursor = opts.cursor ?? null;
  const total: BackfillRunResult = { scanned: 0, filled: 0, failed: 0, skipped: 0, batches: 0, more: true, cursor };
  try {
    for (let i = 0; i < maxBatches; i++) {
      if (i > 0) {
        if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
        // Keep the lock for the next batch — or stop while it is still ours.
        if (canEval) {
          const ok = Number(await redis.eval!(REFRESH_LOCK_SCRIPT, 1, REFERENCES_BACKFILL_LOCK_KEY, token, ttl).catch(() => 0));
          if (ok !== 1) { total.stoppedForLock = true; break; }
          lockExpires = Date.now() + ttl;
        } else if (lockExpires - Date.now() <= batchBudget + 1000) {
          total.stoppedForLock = true;
          break;
        }
      }
      const r = await backfillReferences({}, {
        limit: batchSize, after: cursor, tracker, budgetMs: batchBudget,
        ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        ...(opts.deps ? { deps: opts.deps } : {}),
      });
      total.batches++;
      total.scanned += r.scanned;
      total.filled += r.filled;
      total.failed += r.failed;
      total.skipped += r.skipped;
      if (r.cursor) cursor = r.cursor;
      if (r.exhausted) { cursor = null; total.more = false; break; }
      // Only read failures in this batch: the object store is probably down — stop
      // the run (the cursor has moved on; the next run continues after it).
      if (r.failed > 0 && r.filled === 0) break;
    }
  } finally {
    if (canEval) {
      await redis.eval!(RELEASE_LOCK_SCRIPT, 1, REFERENCES_BACKFILL_LOCK_KEY, token).catch((err: unknown) => {
        log.debug({ err }, 'references backfill: lock release failed (expires by TTL)');
      });
    }
  }
  total.cursor = cursor;
  return total;
}

/**
 * Starts the background backfill (no-op handle when REFERENCES_BACKFILL=off).
 * Runs every minute while a pass over the table is in progress, every 6 hours
 * once a pass is complete. The pass position (cursor) is kept in this process.
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
  let cursor: BackfillCursor | null = null;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    let delay = busy;
    try {
      const r = await runLockedReferencesBackfill(redis, { lockTtlMs: Math.max(10_000, busy - 10_000), cursor });
      if (r) {
        cursor = r.cursor;
        if (r.filled || r.failed) log.info({ filled: r.filled, failed: r.failed, skipped: r.skipped, more: r.more }, 'References backfilled');
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
