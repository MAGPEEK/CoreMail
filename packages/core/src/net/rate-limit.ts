/**
 * Fixed-window rate limiter keyed by an identity (user id, account …).
 *
 * Counts in a shared store (Redis: `ratelimit:<scope>:<key>:<window>`, INCR +
 * EXPIRE) so the limit holds across processes and restarts; when the store is
 * slow or unavailable it falls back to an in-process counter (never fails open
 * to "unlimited", never blocks the caller on the store). Used by the
 * api-gateway per-user limits and the MAPI server (9.4).
 *
 * {@link FixedWindowCounter} is the in-process counter: the fallback above and
 * the api-gateway's global per-user / per-IP API limit (one process, synchronous).
 */
import { createLogger } from '../logger/index.js';

const log = createLogger('core:rate-limit');

export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateDecision { allowed: boolean; count: number; limit: number; retryAfterSec: number }

export interface FixedWindowLimiterOptions {
  scope: string;
  /** Max. events per window; 0 or less disables the limiter. */
  limit: number;
  windowSec: number;
  store: () => CounterStore;
  /** Store timeout before the in-process fallback is used (ms). */
  timeoutMs?: number;
  now?: () => number;
}

export interface FixedWindowLimiter {
  hit(key: string): Promise<RateDecision>;
}

const MAX_LOCAL_KEYS = 50_000;

/** Fixed-window counters per key, in process memory (expired windows are pruned). */
export class FixedWindowCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = 0;

  /** Counts one event; a key's window starts with its first event and lasts `windowMs`. */
  hit(key: string, windowMs: number, now: number): { count: number; resetAt: number } {
    this.prune(now, windowMs);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w;
  }

  /** Current count of a key without counting (0 when no window is open). */
  peek(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && w.resetAt > now ? w.count : 0;
  }

  /** Forget every window (memory bound of the fallback). */
  clear(): void { this.windows.clear(); }

  /** Remove expired windows at most once per window length. */
  private prune(now: number, windowMs: number): void {
    if (now - this.lastPrune < windowMs) return;
    this.lastPrune = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  get size(): number { return this.windows.size; }
}

export function createFixedWindowLimiter(opts: FixedWindowLimiterOptions): FixedWindowLimiter {
  const local = new FixedWindowCounter();
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 500;
  const windowMs = opts.windowSec * 1000;

  async function storeCount(key: string): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const s = opts.store();
    return Promise.race([
      s.incr(key).then(async (n) => {
        if (n === 1) await s.expire(key, opts.windowSec + 1);
        return n;
      }),
      new Promise<number>((_, reject) => { timer = setTimeout(() => reject(new Error('rate-limit store timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }

  /** In-process count; `key` carries the window number, so a new window is a new key. */
  function localCount(key: string, t: number): number {
    if (local.size > MAX_LOCAL_KEYS) local.clear();
    return local.hit(key, windowMs, t).count;
  }

  return {
    async hit(id) {
      if (opts.limit <= 0) return { allowed: true, count: 0, limit: 0, retryAfterSec: 0 };
      const t = now();
      const window = Math.floor(t / windowMs);
      const key = `ratelimit:${opts.scope}:${id}:${window}`;
      const retryAfterSec = Math.max(1, Math.ceil(((window + 1) * windowMs - t) / 1000));
      let count: number;
      try {
        count = await storeCount(key);
      } catch (err) {
        log.warn({ err, scope: opts.scope }, 'Rate-limit store unavailable — using the in-process counter');
        count = localCount(key, t);
      }
      return { allowed: count <= opts.limit, count, limit: opts.limit, retryAfterSec };
    },
  };
}
