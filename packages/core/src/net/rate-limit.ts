/**
 * Fixed-window rate limiter keyed by an identity (user id, account …).
 *
 * Counts in a shared store (Redis: `ratelimit:<scope>:<key>:<window>`, INCR +
 * EXPIRE) so the limit holds across processes and restarts; when the store is
 * slow or unavailable it falls back to an in-process counter (never fails open
 * to "unlimited", never blocks the caller on the store). Used by the
 * api-gateway per-user limits and the MAPI server (9.4).
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

export function createFixedWindowLimiter(opts: FixedWindowLimiterOptions): FixedWindowLimiter {
  const local = new Map<string, number>();
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

  function localCount(key: string, window: number): number {
    if (local.size > MAX_LOCAL_KEYS) local.clear();
    for (const k of local.keys()) if (!k.endsWith(`:${window}`)) local.delete(k);
    const count = (local.get(key) ?? 0) + 1;
    local.set(key, count);
    return count;
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
        count = localCount(key, window);
      }
      return { allowed: count <= opts.limit, count, limit: opts.limit, retryAfterSec };
    },
  };
}
