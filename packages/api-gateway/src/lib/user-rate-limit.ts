/**
 * Per-user fixed-window rate limiter (8.0.x).
 *
 * Counts in Redis (`ratelimit:<scope>:<userId>:<window>`, INCR + EXPIRE) so the
 * limit holds across gateway instances and restarts; when Redis is slow or
 * unavailable it falls back to an in-process counter (never fails open to
 * "unlimited", never blocks the request on Redis).
 *
 * Test seam: `globalThis.__rateLimitRedis` replaces the Redis client.
 */
import type { Request, Response, NextFunction } from 'express';
import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('api:rate-limit');

export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateDecision { allowed: boolean; count: number; limit: number; retryAfterSec: number }

export interface UserRateLimiterOptions {
  scope: string;
  /** Max. events per window; 0 or less disables the limiter. */
  limit: number;
  windowSec: number;
  store?: () => CounterStore;
  /** Redis timeout before the in-process fallback is used (ms). */
  timeoutMs?: number;
  now?: () => number;
}

function defaultStore(): CounterStore {
  const seam = (globalThis as Record<string, unknown>)['__rateLimitRedis'] as CounterStore | undefined;
  return seam ?? (getRedisClient() as unknown as CounterStore);
}

/** Parses a non-negative integer env value. */
export function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function createUserRateLimiter(opts: UserRateLimiterOptions) {
  const local = new Map<string, number>();
  const now = opts.now ?? Date.now;
  const store = opts.store ?? defaultStore;
  const timeoutMs = opts.timeoutMs ?? 500;
  const windowMs = opts.windowSec * 1000;

  async function hit(userId: string): Promise<RateDecision> {
    if (opts.limit <= 0) return { allowed: true, count: 0, limit: 0, retryAfterSec: 0 };
    const t = now();
    const window = Math.floor(t / windowMs);
    const key = `ratelimit:${opts.scope}:${userId}:${window}`;
    const retryAfterSec = Math.max(1, Math.ceil(((window + 1) * windowMs - t) / 1000));
    let count: number;
    try {
      let timer: NodeJS.Timeout | undefined;
      const s = store();
      count = await Promise.race([
        s.incr(key).then(async (n) => {
          if (n === 1) await s.expire(key, opts.windowSec + 1);
          return n;
        }),
        new Promise<number>((_, reject) => { timer = setTimeout(() => reject(new Error('rate-limit store timeout')), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      log.warn({ err, scope: opts.scope }, 'Rate-limit store unavailable — using the in-process counter');
      if (local.size > 50_000) local.clear();
      for (const k of local.keys()) if (!k.endsWith(`:${window}`)) local.delete(k);
      count = (local.get(key) ?? 0) + 1;
      local.set(key, count);
    }
    return { allowed: count <= opts.limit, count, limit: opts.limit, retryAfterSec };
  }

  /** Express middleware (after requireAuth): 429 + Retry-After when over the limit. */
  function middleware(req: Request, res: Response, next: NextFunction): void {
    const userId = req.apiUser?.userId;
    if (!userId) { next(); return; }
    hit(userId).then((d) => {
      if (d.allowed) { next(); return; }
      res.setHeader('Retry-After', String(d.retryAfterSec));
      res.status(429).json({ error: 'Too many requests — please slow down', code: 'RATE_LIMITED', retryAfter: d.retryAfterSec });
    }, next);
  }

  return { hit, middleware };
}
