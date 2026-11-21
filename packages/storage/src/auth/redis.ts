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
  /** 10.6: GETDEL (Redis ≥ 6.2) — single-use values (passkey challenges). Optional for older fakes. */
  getdel?(key: string): Promise<string | null>;
}

/**
 * 10.6: reads and deletes a key; the value is returned to exactly one caller
 * (GETDEL, or GET + DEL where only the caller whose DEL removed the key wins).
 */
export async function takeOnce(key: string): Promise<string | null> {
  const r = authRedis();
  if (typeof r.getdel === 'function') return r.getdel(key);
  const v = await r.get(key);
  if (v === null) return null;
  return (await r.del(key)) === 1 ? v : null;
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
