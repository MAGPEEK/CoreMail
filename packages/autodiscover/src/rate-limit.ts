/**
 * Fixed-window request limiter for the anonymous client-setup endpoints (v8.1,
 * Thunderbird autoconfig). In-memory and per process — the autodiscover service runs
 * once per container. Memory is bounded: the key map is cleared every window and
 * never holds more than `maxKeys` entries; requests from further keys share one
 * overflow bucket (so a flood of spoofed/rotating IPs still hits a limit).
 */
export interface FixedWindowLimiterOptions {
  /** Requests per key and window. */
  limit: number;
  windowMs: number;
  /** Distinct keys tracked per window (default 10 000). */
  maxKeys?: number;
  now?: () => number;
}

const OVERFLOW_KEY = '\0overflow';

export class FixedWindowLimiter {
  private windowStart = Number.NEGATIVE_INFINITY;
  private readonly counts = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly opts: FixedWindowLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Counts one request for `key`; `retryAfterSec` is set when it is over the limit. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    if (t - this.windowStart >= this.opts.windowMs) {
      this.windowStart = t;
      this.counts.clear();
    }
    let k = key || 'unknown';
    if (!this.counts.has(k) && this.counts.size >= this.maxKeys) k = OVERFLOW_KEY;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    // the overflow bucket is shared, so it gets a larger allowance
    const allowed = k === OVERFLOW_KEY ? this.opts.limit * 10 : this.opts.limit;
    if (n > allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((this.windowStart + this.opts.windowMs - t) / 1000));
      return { ok: false, retryAfterSec };
    }
    return { ok: true };
  }
}
