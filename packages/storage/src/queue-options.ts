/**
 * QueueSettings (BCP → Queues → Settings) → BullMQ options for the
 * `smtp-outbound` queue. Shared by every producer (smtp-server, api-gateway
 * web/calendar/quarantine, JMAP, EWS, ActiveSync) so that retry policy and
 * retention are the same no matter where a message was submitted.
 *
 *   maxRetryAttempts / retryBackoffDelaySec → attempts (a minimum — time-based expiry wins) +
 *                                              retry schedule (first retry after retryBackoffDelaySec,
 *                                              then 5 / 15 / every 30 min until expiry), v8.1
 *   completedRetentionHours                  → removeOnComplete { age, count 100 }
 *   deadLetterRetentionDays + autoFlushDead  → removeOnFail { age } (only with auto-flush;
 *                                              otherwise dead letters stay until flushed, capped by count)
 *   outboundRetentionHours                   → max time a message may spend in the queue
 *                                              (worker gives up → dead letter + DSN), see isExpiredInQueue()
 *   notifyOnDeadLetter                       → smtp-server notifies the postmaster/admins
 *
 * The smtp-server worker also runs a periodic cleaner (queue.clean) so that
 * changed retention values apply to jobs that were enqueued earlier.
 */
import { prisma } from './prisma/index.js';

export interface QueueSettingsLike {
  maxRetryAttempts: number;
  retryBackoffDelaySec: number;
  deadLetterRetentionDays: number;
  outboundRetentionHours: number;
  completedRetentionHours: number;
  autoFlushDead: boolean;
  notifyOnDeadLetter: boolean;
}

/** Prisma schema defaults of QueueSettings. */
export const DEFAULT_QUEUE_SETTINGS: Readonly<QueueSettingsLike> = {
  maxRetryAttempts: 10,
  retryBackoffDelaySec: 60,
  deadLetterRetentionDays: 7,
  outboundRetentionHours: 48,
  completedRetentionHours: 24,
  autoFlushDead: false,
  notifyOnDeadLetter: true,
};

/** Upper bound for dead letters kept without auto-flush (protects Redis memory). */
export const DEAD_LETTER_MAX_COUNT = 10_000;
/** The BCP shows at most 100 delivered messages. */
export const COMPLETED_MAX_COUNT = 100;

export interface OutboundJobOptions {
  attempts: number;
  backoff: { type: typeof OUTBOUND_BACKOFF_TYPE; delay: number };
  removeOnComplete: { age: number; count: number };
  removeOnFail: { age: number } | { count: number };
}

// ── Retry schedule (v8.1, Exchange-like) ──────────────────────────────────────
//
// A transient failure is retried until the message expires
// (outboundRetentionHours, default 48 h): first after retryBackoffDelaySec
// (default 60 s = 1 min), then 5 min, 15 min, then every 30 min; the last
// retry is pulled forward to the expiry moment, where the worker gives up and
// sends the final NDR (5.4.7). Time-based expiry wins: `maxRetryAttempts` is a
// MINIMUM — the job gets at least enough attempts to cover the whole window.
// The delay DSN (OUTBOUND_DELAY_DSN_HOURS, default 4 h) is unchanged.

/** BullMQ custom backoff type — resolved by the smtp-server worker (outboundBackoffStrategy). */
export const OUTBOUND_BACKOFF_TYPE = 'coremail-outbound' as const;
const RETRY_STEPS_MS = [5 * 60_000, 15 * 60_000] as const;
const RETRY_INTERVAL_MS = 30 * 60_000;

/** Pure: uncapped delay before retry number `attemptsMade` (1 = after the first failure). */
export function outboundRetryStepMs(attemptsMade: number, firstDelayMs = 60_000): number {
  const first = Math.max(1000, firstDelayMs);
  if (attemptsMade <= 1) return first;
  const step = RETRY_STEPS_MS[attemptsMade - 2] ?? RETRY_INTERVAL_MS;
  return Math.max(first, step);
}

/** Pure: attempts needed so the retry schedule covers `retentionHours` (+ the expiry attempt). */
export function attemptsForRetention(retentionHours: number, firstDelayMs = 60_000): number {
  const window = retentionHours * 3_600_000;
  let elapsed = 0;
  let attempts = 1; // the first delivery
  while (elapsed < window && attempts < 10_000) {
    elapsed += outboundRetryStepMs(attempts, firstDelayMs);
    attempts++;
  }
  return attempts + 1; // + the attempt at the expiry moment that gives up (final NDR)
}

/**
 * Pure: delay before the next retry, capped so the retry never lands after the
 * expiry (it is then scheduled 1 s past the expiry — the worker gives up and
 * sends the final NDR right at the end of the window).
 */
export function outboundRetryDelay(
  attemptsMade: number,
  job: {
    timestamp?: number | undefined;
    opts?: { delay?: number | undefined; backoff?: unknown } | undefined;
    data?: object | undefined;
  },
  settings: Partial<QueueSettingsLike> | null | undefined,
  now = Date.now(),
): number {
  const s = normalizeQueueSettings(settings);
  const step = outboundRetryStepMs(attemptsMade, s.retryBackoffDelaySec * 1000);
  if (job.timestamp === undefined && (job.data as { expiryBaseMs?: unknown } | undefined)?.expiryBaseMs === undefined) return step;
  const expiry = queueStartMs(job) + s.outboundRetentionHours * 3_600_000;
  const untilExpiry = expiry - now + 1000;
  return Math.max(1000, Math.min(step, untilExpiry));
}

function intOr(v: unknown, d: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.trunc(v)) : d;
}

/** Fill missing/invalid fields with the schema defaults. */
export function normalizeQueueSettings(s: Partial<QueueSettingsLike> | null | undefined): QueueSettingsLike {
  const d = DEFAULT_QUEUE_SETTINGS;
  return {
    maxRetryAttempts:        intOr(s?.maxRetryAttempts, d.maxRetryAttempts, 1),
    retryBackoffDelaySec:    intOr(s?.retryBackoffDelaySec, d.retryBackoffDelaySec, 1),
    deadLetterRetentionDays: intOr(s?.deadLetterRetentionDays, d.deadLetterRetentionDays, 1),
    outboundRetentionHours:  intOr(s?.outboundRetentionHours, d.outboundRetentionHours, 1),
    completedRetentionHours: intOr(s?.completedRetentionHours, d.completedRetentionHours, 1),
    autoFlushDead:           typeof s?.autoFlushDead === 'boolean' ? s.autoFlushDead : d.autoFlushDead,
    notifyOnDeadLetter:      typeof s?.notifyOnDeadLetter === 'boolean' ? s.notifyOnDeadLetter : d.notifyOnDeadLetter,
  };
}

/** Pure: BullMQ job options for an outbound job. BullMQ `age` is in seconds. */
export function buildOutboundJobOptions(settings: Partial<QueueSettingsLike> | null | undefined): OutboundJobOptions {
  const s = normalizeQueueSettings(settings);
  return {
    // time-based expiry wins: maxRetryAttempts is only a minimum
    attempts: Math.max(s.maxRetryAttempts, attemptsForRetention(s.outboundRetentionHours, s.retryBackoffDelaySec * 1000)),
    backoff:  { type: OUTBOUND_BACKOFF_TYPE, delay: s.retryBackoffDelaySec * 1000 },
    removeOnComplete: { age: s.completedRetentionHours * 3600, count: COMPLETED_MAX_COUNT },
    removeOnFail: s.autoFlushDead
      ? { age: s.deadLetterRetentionDays * 86_400 }
      : { count: DEAD_LETTER_MAX_COUNT },
  };
}

/**
 * Pure: has a job been in the queue longer than outboundRetentionHours?
 * Counted from its earliest planned delivery (enqueue time + initial delay,
 * so a scheduled-send job does not expire before it was due).
 */
export function isExpiredInQueue(
  job: { timestamp: number; opts?: { delay?: number | undefined } | undefined; data?: object | undefined },
  settings: Partial<QueueSettingsLike> | null | undefined,
  now = Date.now(),
): boolean {
  const s = normalizeQueueSettings(settings);
  return now - queueStartMs(job) > s.outboundRetentionHours * 3_600_000;
}

/**
 * Pure: start of a job's retry window — `data.expiryBaseMs` when an admin
 * retry reset it, else the enqueue time + initial delay.
 */
export function queueStartMs(job: {
  timestamp?: number | undefined;
  opts?: { delay?: number | undefined } | undefined;
  data?: object | undefined;
}): number {
  const base = (job.data as { expiryBaseMs?: unknown } | undefined)?.expiryBaseMs;
  if (typeof base === 'number' && Number.isFinite(base)) return base;
  return (job.timestamp ?? Date.now()) + Math.max(0, job.opts?.delay ?? 0);
}

/**
 * Pure: job data for an admin "Retry" of a dead letter (BCP queue view): the
 * retry window starts again now (an expired message is not refused again at
 * once). Delivery progress (`deliveredRcpts`, `bouncedRcpts`) is kept, so no
 * recipient is delivered or bounced twice.
 */
export function adminRetryJobData<T extends Record<string, unknown>>(data: T, now = Date.now()): T & { expiryBaseMs: number } {
  return { ...data, expiryBaseMs: now };
}

/** Pure: grace periods (ms) for the periodic queue cleaner; null = do not clean that state. */
export function queueCleanPlan(settings: Partial<QueueSettingsLike> | null | undefined): { completedGraceMs: number; failedGraceMs: number | null } {
  const s = normalizeQueueSettings(settings);
  return {
    completedGraceMs: s.completedRetentionHours * 3_600_000,
    failedGraceMs: s.autoFlushDead ? s.deadLetterRetentionDays * 86_400_000 : null,
  };
}

// ── DB-backed (60 s cache) ────────────────────────────────────────────────────

let cache: { value: QueueSettingsLike; at: number } | null = null;
const CACHE_MS = 60_000;

/** QueueSettings from the DB (schema defaults when missing/unreachable), cached 60 s. */
export async function loadQueueSettings(): Promise<QueueSettingsLike> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: QueueSettingsLike;
  try {
    value = normalizeQueueSettings(await prisma.queueSettings.findUnique({ where: { id: 'singleton' } }));
  } catch {
    value = normalizeQueueSettings(null);
  }
  cache = { value, at: Date.now() };
  return value;
}

export function invalidateQueueSettingsCache(): void {
  cache = null;
}

/** BullMQ options for a new `smtp-outbound` job from the current QueueSettings. */
export async function getOutboundJobOptions(): Promise<OutboundJobOptions> {
  return buildOutboundJobOptions(await loadQueueSettings());
}
