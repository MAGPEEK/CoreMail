/**
 * Per-user fixed-window rate limiter (8.0.x) — the Express side of
 * createFixedWindowLimiter() (@coremail/core, 9.4: shared with the MAPI server).
 *
 * Counts in Redis (`ratelimit:<scope>:<userId>:<window>`, INCR + EXPIRE) so the
 * limit holds across gateway instances and restarts; when Redis is slow or
 * unavailable it falls back to an in-process counter (never fails open to
 * "unlimited", never blocks the request on Redis).
 *
 * Test seam: `globalThis.__rateLimitRedis` replaces the Redis client.
 */
import type { Request, Response, NextFunction } from 'express';
import { createFixedWindowLimiter, getRedisClient, type CounterStore, type RateDecision } from '@coremail/core';

export type { CounterStore, RateDecision };

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
  const { hit } = createFixedWindowLimiter({ ...opts, store: opts.store ?? defaultStore });

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
