/**
 * Minimal Redis surface used by the auth module. Tests inject an in-memory
 * implementation through `globalThis.__authRedis` (set before the first call).
 */
import { getRedisClient } from '@coremail/core';

export interface AuthRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __authRedis: AuthRedis | undefined;
}

export function authRedis(): AuthRedis {
  return globalThis.__authRedis ?? (getRedisClient() as unknown as AuthRedis);
}

/** INCR + set the TTL on the first increment. Returns the new count. */
export async function incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const r = authRedis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, ttlSeconds);
  return n;
}
