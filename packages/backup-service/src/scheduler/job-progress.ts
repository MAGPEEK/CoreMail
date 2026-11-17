/**
 * Job heartbeat + stale-job detection (9.3).
 *
 * The watchdog used to fail every job still RUNNING 30 minutes after its
 * start — a large full backup or restore that was still working was marked
 * FAILED and later flipped back to COMPLETED. Running jobs now write
 * `progressMeta.heartbeatAt` (+ the host that runs them) at least once a
 * minute; the watchdog only fails jobs whose heartbeat stopped, and the start-up
 * cleanup fails the jobs of THIS host (they cannot be running any more) plus
 * stale ones of other hosts. Pure helpers + a small writer; unit-tested.
 */
import { hostname } from 'node:os';

export const RUNNING_STATUSES = ['RUNNING', 'PENDING', 'RETRYING', 'PROCESSING', 'SCHEDULED'] as const;

export interface JobLike {
  startedAt: Date | string | null;
  createdAt?: Date | string | null;
  progressMeta?: unknown;
}

function metaOf(job: JobLike): Record<string, unknown> {
  return job.progressMeta && typeof job.progressMeta === 'object' && !Array.isArray(job.progressMeta)
    ? job.progressMeta as Record<string, unknown> : {};
}

/** Last sign of life: the heartbeat, else the start (or creation) time. */
export function lastBeat(job: JobLike): number {
  const hb = metaOf(job)['heartbeatAt'];
  const t = typeof hb === 'string' ? Date.parse(hb) : NaN;
  if (Number.isFinite(t)) return t;
  const s = job.startedAt ?? job.createdAt ?? null;
  const st = s === null ? NaN : new Date(s).getTime();
  return Number.isFinite(st) ? st : 0;
}

/**
 * Last real progress (9.3 review): `progressMeta.progressAt`, written by
 * JobHeartbeat whenever the job reports progress (phase / counters / bytes).
 * null for jobs of older versions (no stall detection for them).
 */
export function lastProgress(job: JobLike): number | null {
  const p = metaOf(job)['progressAt'];
  const t = typeof p === 'string' ? Date.parse(p) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * True when the job is alive (heartbeat) but has made no progress for
 * `stallMs` — a hung pg_dump / upload / store call. The watchdog fails it.
 */
export function isStalled(job: JobLike, now: number, stallMs: number): boolean {
  const p = lastProgress(job);
  return p !== null && now - p > stallMs;
}

/** Stall window of the watchdog: BACKUP_STALL_TIMEOUT_MIN (default 60 minutes). */
export function stallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['BACKUP_STALL_TIMEOUT_MIN']);
  return (Number.isFinite(n) && n >= 5 ? n : 60) * 60_000;
}

/** True when the job has shown no sign of life for `staleMs`. */
export function isStale(job: JobLike, now: number, staleMs: number): boolean {
  return now - lastBeat(job) > staleMs;
}

/** Host that runs the job (progressMeta.host), or null. */
export function jobHost(job: JobLike): string | null {
  const h = metaOf(job)['host'];
  return typeof h === 'string' && h ? h : null;
}

/** Start-up cleanup: jobs of this host are orphans; jobs of other hosts only when stale. */
export function isOrphanAtStartup(job: JobLike, thisHost: string, now: number, staleMs: number): boolean {
  const h = jobHost(job);
  if (h === thisHost) return true;
  return isStale(job, now, staleMs);
}

export function currentHost(): string {
  return `${hostname()}`;
}

export interface MetaWriter {
  (meta: Record<string, unknown>, progress: number | undefined): Promise<void>;
}

/**
 * Keeps `progressMeta` of a running job up to date: `update()` merges fields
 * (written at most every `minIntervalMs`), a timer writes the heartbeat every
 * `beatMs`. `stop()` must be called when the job ends.
 *
 * 9.3 review: the heartbeat alone only proves the process is alive — every
 * `update()` / `touch()` also records `progressAt` (only for jobs created with
 * `{ trackProgress: true }`, i.e. jobs that report progress often enough), so
 * the watchdog can tell a working job from a hung one (isStalled).
 */
export class JobHeartbeat {
  private meta: Record<string, unknown>;
  private progress: number | undefined;
  private timer: NodeJS.Timeout | null = null;
  private lastWrite = 0;
  private progressAt = new Date().toISOString();

  constructor(private readonly write: MetaWriter, initial: Record<string, unknown> = {}, private readonly beatMs = 60_000, private readonly minIntervalMs = 2_000,
    private readonly opts: { trackProgress?: boolean } = {}) {
    this.meta = { ...initial, host: currentHost() };
  }

  snapshot(): Record<string, unknown> {
    return { ...this.meta, ...(this.opts.trackProgress ? { progressAt: this.progressAt } : {}), heartbeatAt: new Date().toISOString() };
  }

  start(): this {
    this.timer = setInterval(() => { void this.flush(true); }, this.beatMs);
    this.timer.unref?.();
    void this.flush(true);
    return this;
  }

  update(fields: Record<string, unknown>, progress?: number): Promise<void> {
    this.meta = { ...this.meta, ...fields };
    if (progress !== undefined) this.progress = progress;
    this.progressAt = new Date().toISOString();
    return this.flush(false);
  }

  /** Reports progress without new fields (bytes written, objects listed, …). */
  touch(): Promise<void> {
    this.progressAt = new Date().toISOString();
    return this.flush(false);
  }

  private async flush(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWrite < this.minIntervalMs) return;
    this.lastWrite = now;
    await this.write(this.snapshot(), this.progress).catch(() => undefined);
  }

  stop(): Record<string, unknown> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const { heartbeatAt: _h, progressAt: _p, ...rest } = this.snapshot();
    return rest;
  }
}
