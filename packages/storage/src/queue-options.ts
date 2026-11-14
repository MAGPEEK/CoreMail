/**
 * QueueSettings (BCP → Queues → Settings) → BullMQ options for the
 * `smtp-outbound` queue. Shared by every producer (smtp-server, api-gateway
 * web/calendar/quarantine, JMAP, EWS, ActiveSync) so that retry policy and
 * retention are the same no matter where a message was submitted.
 *
 *   maxRetryAttempts / retryBackoffDelaySec → attempts + exponential backoff
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
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: { age: number; count: number };
  removeOnFail: { age: number } | { count: number };
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
    attempts: s.maxRetryAttempts,
    backoff:  { type: 'exponential', delay: s.retryBackoffDelaySec * 1000 },
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
  job: { timestamp: number; opts?: { delay?: number } | undefined },
  settings: Partial<QueueSettingsLike> | null | undefined,
  now = Date.now(),
): boolean {
  const s = normalizeQueueSettings(settings);
  const start = job.timestamp + Math.max(0, job.opts?.delay ?? 0);
  return now - start > s.outboundRetentionHours * 3_600_000;
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
